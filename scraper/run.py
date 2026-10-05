"""Fetch every board in one shard and write normalized US jobs.

    python -m scraper.run --shard 0 --of 20 --out out/
    python -m scraper.run --ats Greenhouse --limit 50 --out out/      # quick local run
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

from .adapters import Unsupported, fetcher_for
from .http import Client, FetchError
from .location import classify, is_remote

ROOT = Path(__file__).resolve().parent.parent
BOARDS = ROOT / "data" / "boards.csv.gz"
TODAY = datetime.now(timezone.utc).date()


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


def normalize(board: dict, raw: dict) -> dict | None:
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
        "u": int(us == "us"), "d": norm_date(raw.get("posted")), "url": raw["url"],
    }


async def run_board(c: Client, board: dict):
    try:
        raw = await fetcher_for(board["ats"])(c, board["board_url"])
        jobs = [j for j in (normalize(board, r) for r in raw) if j]
        return board, jobs, {"b": board["id"], "ok": 1, "n": len(raw), "us": len(jobs)}
    except Unsupported as e:
        return board, [], {"b": board["id"], "ok": 0, "skip": 1, "err": str(e)[:120]}
    except (FetchError, KeyError, ValueError, TypeError, AttributeError) as e:
        return board, [], {"b": board["id"], "ok": 0, "err": f"{type(e).__name__}: {e}"[:160]}


async def main_async(args):
    boards = [b for b in load_boards()
              if b["id"] % args.of == args.shard and (not args.ats or b["ats"] == args.ats)]
    if args.limit:
        boards = boards[: args.limit]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    jf = gzip.open(out / f"jobs-{args.shard:02d}.jsonl.gz", "wt")
    sf = open(out / f"boards-{args.shard:02d}.jsonl", "w")
    done = jobs_n = 0
    deadline = time.monotonic() + args.max_minutes * 60
    async with Client(concurrency=args.concurrency, per_host=args.per_host) as c:
        pending = set()
        it = iter(boards)
        for b in it:
            pending.add(asyncio.create_task(run_board(c, b)))
            if len(pending) >= args.concurrency * 4:
                break
        while pending:
            finished, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for t in finished:
                board, jobs, stat = t.result()
                for j in jobs:
                    jf.write(json.dumps(j, separators=(",", ":")) + "\n")
                sf.write(json.dumps(stat) + "\n")
                done += 1
                jobs_n += len(jobs)
                if done % 500 == 0:
                    print(f"[shard {args.shard}] {done}/{len(boards)} boards, {jobs_n} jobs, {c.requests} req", flush=True)
                if time.monotonic() < deadline:
                    nxt = next(it, None)
                    if nxt is not None:
                        pending.add(asyncio.create_task(run_board(c, nxt)))
    jf.close()
    sf.close()
    print(f"[shard {args.shard}] done: {done}/{len(boards)} boards, {jobs_n} US jobs", flush=True)


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--shard", type=int, default=0)
    p.add_argument("--of", type=int, default=1)
    p.add_argument("--ats", default="")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--out", default="out")
    p.add_argument("--concurrency", type=int, default=48)
    p.add_argument("--per-host", type=int, default=4)
    p.add_argument("--max-minutes", type=float, default=300)
    asyncio.run(main_async(p.parse_args(argv)))


if __name__ == "__main__":
    main()
