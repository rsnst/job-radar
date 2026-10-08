"""Fetch the boards in one shard and write normalized US jobs.

    python -m scraper.run --shard 0 --of 20 --mode incremental --out out/
    python -m scraper.run --ats Greenhouse --limit 50 --out out/      # quick local run

Modes
  full         fetch every board, every page
  incremental  skip boards that were empty on a fetch in the last 7 days, and for
               paginated ATSs stop after page 1 when it's unchanged since last run
               (build_db carries the rest of that board's jobs forward)

Each board gets one line in boards-NN.jsonl:
  {"b": id, "st": ok|error|unsupported|skip|timeout, "n", "us", "total", "top", "partial"}
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import gzip
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .adapters import PAGINATED, Unsupported, fetcher_for
from .http import Client, Deadline, FetchError
from .location import classify, is_remote
from .state import day, load_boards_state

ROOT = Path(__file__).resolve().parent.parent
BOARDS = ROOT / "data" / "boards.csv.gz"
TODAY = datetime.now(timezone.utc).date()
EMPTY_RECHECK_DAYS = 7


def load_boards(path: Path = BOARDS):
    with gzip.open(path, "rt", newline="") as f:
        for i, r in enumerate(csv.DictReader(f)):
            r["id"] = i
            yield r


_ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_US_DATE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")
_MS_DATE = re.compile(r"/Date\((\d+)")


def norm_date(v, today: date = TODAY) -> str | None:
    if v in (None, "", 0):
        return None
    if isinstance(v, (int, float)):
        ts = v / 1000 if v > 1e11 else v
        return datetime.fromtimestamp(ts, timezone.utc).date().isoformat()
    s = str(v)
    m = re.fullmatch(r"-(\d+)d", s)
    if m:
        return (today - timedelta(days=int(m.group(1)))).isoformat()
    m = _ISO.search(s)
    if m:
        return m.group(0)
    m = _US_DATE.search(s)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    m = _MS_DATE.search(s)
    if m:
        return norm_date(int(m.group(1)), today)
    return None


def normalize(board: dict, raw: dict, today: date = TODAY) -> dict | None:
    title = (raw.get("title") or "").strip()
    if not title or not raw.get("url"):
        return None
    loc = (raw.get("loc") or "").strip() or None
    us, state = classify(loc, raw.get("country"))
    if us == "non":
        return None
    if us == "unk" and (board.get("us_share_pct") or "") == "100":
        us = "us"
    remote = is_remote(raw.get("remote") is True, loc, title)
    return {
        "k": raw["key"], "b": board["id"], "t": title[:200], "c": board["company"], "a": board["ats"],
        "l": (loc or ("Remote" if remote else ""))[:160], "s": state, "r": int(remote),
        "u": int(us == "us"), "d": norm_date(raw.get("posted"), today), "url": raw["url"],
    }


def plan(board: dict, prev: dict | None, mode: str, today: date) -> tuple[str, dict | None]:
    """Decide what to do with a board: ("skip", None) or ("fetch", probe-or-None)."""
    if mode != "incremental" or not prev:
        return "fetch", None
    if (prev.get("st") == "ok" and prev.get("n") == 0
            and day(today) - prev.get("full", -10**6) < EMPTY_RECHECK_DAYS):
        return "skip", None
    if board["ats"] in PAGINATED and prev.get("st") == "ok" and prev.get("top"):
        return "fetch", {"total": prev.get("total"), "top": prev["top"]}
    return "fetch", None


async def run_board(c: Client, board: dict, prev: dict | None, mode: str, today: date):
    action, probe = plan(board, prev, mode, today)
    base = {"b": board["id"]}
    if action == "skip":
        return [], {**base, "st": "skip"}
    try:
        fetch = fetcher_for(board["ats"])
        raw = await (fetch(c, board["board_url"], prev=probe) if board["ats"] in PAGINATED
                     else fetch(c, board["board_url"]))
        jobs = [j for j in (normalize(board, r, today) for r in raw) if j]
        stat = {**base, "st": "ok", "n": len(raw), "us": len(jobs)}
        if board["ats"] in PAGINATED:
            stat.update(total=raw.total, top=raw.top, partial=int(not raw.complete))
            if not raw.complete:  # page 1 only: the real count is unchanged from last run
                stat["n"] = prev.get("n", len(raw))
        return jobs, stat
    except Deadline:
        return [], {**base, "st": "timeout"}
    except Unsupported as e:
        return [], {**base, "st": "unsupported", "err": str(e)[:120]}
    except (FetchError, KeyError, ValueError, TypeError, AttributeError) as e:
        return [], {**base, "st": "error", "err": f"{type(e).__name__}: {e}"[:160]}


async def main_async(args, transport=None):
    today = date.fromisoformat(args.today) if args.today else TODAY
    boards = [b for b in load_boards(Path(args.boards))
              if b["id"] % args.of == args.shard and (not args.ats or b["ats"] == args.ats)]
    if args.limit:
        boards = boards[: args.limit]
    prev = load_boards_state(Path(args.state)) if args.mode == "incremental" else {}
    if args.mode == "incremental" and not prev:
        print(f"[shard {args.shard}] no previous state: running full", flush=True)
        args.mode = "full"
        args.max_minutes = max(args.max_minutes, args.full_max_minutes)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    deadline = t0 + args.max_minutes * 60
    counts: dict[str, int] = {}
    jobs_n = done = 0
    with gzip.open(out / f"jobs-{args.shard:02d}.jsonl.gz", "wt") as jf, \
            open(out / f"boards-{args.shard:02d}.jsonl", "w") as sf:
        async with Client(transport, concurrency=args.concurrency, per_host=args.per_host, rps=args.rps) as c:
            c.deadline = deadline
            # every board is queued at once; the client's per-domain limits decide the order,
            # so one slow ATS never starves the others
            tasks = [asyncio.create_task(run_board(c, b, prev.get(b["board_url"]), args.mode, today))
                     for b in boards]
            for fut in asyncio.as_completed(tasks):
                jobs, stat = await fut
                for j in jobs:
                    jf.write(json.dumps(j, separators=(",", ":")) + "\n")
                sf.write(json.dumps(stat, separators=(",", ":")) + "\n")
                key = stat["st"] + ("-page1" if stat.get("partial") else "")
                counts[key] = counts.get(key, 0) + 1
                done += 1
                jobs_n += len(jobs)
                if done % 1000 == 0:
                    print(f"[shard {args.shard}] {done}/{len(boards)} boards, {c.requests} req, "
                          f"{time.monotonic() - t0:.0f}s", flush=True)
            summary = {"shard": args.shard, "mode": args.mode, "boards": len(boards), "requests": c.requests,
                       "throttled": c.throttled, "jobs": jobs_n, "seconds": round(time.monotonic() - t0, 1),
                       **dict(sorted(counts.items()))}
    (out / f"summary-{args.shard:02d}.json").write_text(json.dumps(summary))
    print(json.dumps(summary), flush=True)
    return summary


def parse(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--shard", type=int, default=0)
    p.add_argument("--of", type=int, default=1)
    p.add_argument("--mode", choices=["full", "incremental"], default="full")
    p.add_argument("--state", default="state", help="dir with boards.json.gz from the last build")
    p.add_argument("--boards", default=str(BOARDS))
    p.add_argument("--ats", default="")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--out", default="out")
    p.add_argument("--concurrency", type=int, default=48)
    p.add_argument("--per-host", type=int, default=4, help="concurrent requests per ATS domain")
    p.add_argument("--rps", type=float, default=2.0, help="requests/second per ATS domain (0 = unlimited)")
    p.add_argument("--max-minutes", type=float, default=300,
                   help="stop starting new boards after this; unstarted boards keep last run's jobs")
    p.add_argument("--full-max-minutes", type=float, default=120,
                   help="time budget used instead when an incremental run has to fall back to full")
    p.add_argument("--today", default="", help=argparse.SUPPRESS)
    return p.parse_args(argv)


def main(argv=None):
    asyncio.run(main_async(parse(argv)))


if __name__ == "__main__":
    main()
