"""Merge shard outputs with last run's state into a chunked SQLite DB the web app
reads with HTTP range requests, and write the state for the next run.

    python -m scraper.build_db --in out/ --site site/ --state state/
"""
from __future__ import annotations

import argparse
import glob
import gzip
import json
import sqlite3
import sys
import zlib
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from .run import BOARDS, load_boards
from .state import day, load_boards_state, load_jobs_state, save_boards_state, save_jobs_state
from .pay import pay_from_text

STALE_DAYS = 3  # keep a board's last jobs this long if it errors or isn't reached
# the published DB only holds jobs posted within this many days (state keeps all of them)
SHOW_DAYS = 35

CHUNK = 25 * 1024 * 1024
PAGE = 4096

SCHEMA = """
PRAGMA page_size = %d;
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE boards(id INTEGER PRIMARY KEY, company TEXT, ats TEXT, url TEXT, evidence TEXT,
                    status TEXT, jobs INTEGER);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, board INTEGER, company TEXT, ats TEXT, title TEXT, loc TEXT,
                  state TEXT, remote INTEGER, us INTEGER, posted INTEGER, seen INTEGER, url TEXT, pay TEXT);
-- one row per job that has a description; the HTML is zlib-compressed (the web app inflates it)
CREATE TABLE job_details(job_id INTEGER PRIMARY KEY, body BLOB);
""" % PAGE

INDEXES = """
-- rows are inserted newest-first, so rowid order == newest-first; single-column
-- indexes keep rowid order inside each value, so "WHERE x=? ORDER BY id" never sorts.
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX jobs_ats ON jobs(ats);
CREATE INDEX jobs_remote ON jobs(remote);
CREATE INDEX jobs_seen ON jobs(seen);
CREATE INDEX jobs_board ON jobs(board);
CREATE INDEX boards_jobs ON boards(jobs DESC);
CREATE INDEX boards_ats ON boards(ats, jobs DESC);
CREATE VIRTUAL TABLE jobs_fts USING fts5(title, company, loc, content='jobs', content_rowid='id',
    tokenize="unicode61 remove_diacritics 2 tokenchars '#+'");
INSERT INTO jobs_fts(rowid, title, company, loc) SELECT id, title, company, loc FROM jobs;
INSERT INTO jobs_fts(jobs_fts) VALUES('optimize');
CREATE VIRTUAL TABLE boards_fts USING fts5(company, url, content='boards', content_rowid='id');
INSERT INTO boards_fts(rowid, company, url) SELECT id, company, url FROM boards;
INSERT INTO boards_fts(boards_fts) VALUES('optimize');
"""


def _log(stage: str):
    """Progress to stderr with peak memory, so a cancelled build shows how far it got."""
    import resource
    mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    print(f"[build] {stage} (peak {mb} MB)", file=sys.stderr, flush=True)


def description_bytes(html: str) -> bytes:
    """UTF-8 for a description. Lone surrogates (from some JSON APIs) can't be encoded; replace them."""
    return html.encode("utf-8", "replace")


def day_of(s: str | None) -> int | None:
    if not s:
        return None
    try:
        return day(date.fromisoformat(s[:10]))
    except ValueError:
        return None


def _compact(j: dict, f: int) -> dict:
    """Shard-format job -> state-format job (board fields dropped, first-seen day added)."""
    out = {"k": j["k"], "t": j["t"], "l": j["l"], "s": j["s"], "r": j["r"], "u": j["u"],
           "d": j["d"], "url": j["url"], "f": f}
    if j.get("x"):
        out["x"] = j["x"]
    if j.get("p"):
        out["p"] = j["p"]
    return out


def merge(in_dir: Path, state_dir: Path, today: date, boards_path: Path = BOARDS):
    """Combine this run's shard output with last run's state.

    Returns (boards, jobs_by_url, new_board_state, run_info), where each board dict
    gains "status" and jobs are in state format.
    """
    td = day(today)
    prev_b = load_boards_state(state_dir)
    prev_j = load_jobs_state(state_dir)
    first = {j["k"]: j["f"] for jobs in prev_j.values() for j in jobs}

    stats: dict[int, dict] = {}
    for p in sorted(glob.glob(str(in_dir / "boards-*.jsonl"))):
        for line in open(p):
            st = json.loads(line)
            stats[st["b"]] = st
    fresh: dict[int, list] = defaultdict(list)
    for p in sorted(glob.glob(str(in_dir / "jobs-*.jsonl.gz"))):
        with gzip.open(p, "rt") as f:
            for line in f:
                j = json.loads(line)
                fresh[j["b"]].append(j)
    summaries = [json.loads(Path(p).read_text()) for p in sorted(glob.glob(str(in_dir / "summary-*.json")))]

    boards, jobs_by_url, new_state = [], {}, {}
    outcome = Counter()
    for b in load_boards(boards_path):
        url = b["board_url"]
        s = stats.get(b["id"])
        ps = prev_b.get(url)
        pj = prev_j.get(url, [])
        st = s["st"] if s else "not_run"
        recent_ok = bool(ps and td - ps.get("ok", -10**6) <= STALE_DAYS)
        if st == "ok":
            new = []
            seen = set()
            for j in fresh.get(b["id"], []):
                if j["k"] not in seen:
                    seen.add(j["k"])
                    new.append(_compact(j, first.get(j["k"], td)))
            ns = {"st": "ok", "n": s.get("n", 0), "ok": td, "full": td}
            if "top" in s:
                ns.update(total=s.get("total"), top=s["top"])
            if s.get("partial"):  # only page 1 fetched: keep the rest from last run
                new += [j for j in pj if j["k"] not in seen]
                ns["full"] = (ps or {}).get("full", td)
                outcome["page1_unchanged"] += 1
            else:
                outcome["fetched"] += 1
            jobs, status = new, "ok"
        elif st == "unsupported":
            jobs, status, ns = [], "unsupported", {"st": "unsupported", "err": s.get("err")}
            outcome["unsupported"] += 1
        elif st == "skip" and ps:
            jobs, status, ns = pj, ps.get("st", "ok"), ps
            outcome["skipped_empty"] += 1
        elif st == "error":
            jobs = pj if recent_ok else []
            status, ns = "error", {**(ps or {}), "st": "error", "err": s.get("err")}
            outcome["error_kept_last" if jobs else "error"] += 1
        elif ps:  # timeout, or its shard didn't finish: keep last run's result for a while
            jobs = pj if recent_ok else []
            status, ns = ps.get("st", "not_run"), ps
            outcome["not_reached_kept_last" if jobs else "not_reached"] += 1
        else:
            jobs, status, ns = [], "not_run", None
            outcome["not_reached"] += 1
        if ns is not None:
            new_state[url] = ns
        if jobs:
            jobs_by_url[url] = jobs
        boards.append({**b, "status": status})

    run = {
        "mode": "full" if not summaries or any(x.get("mode") == "full" for x in summaries) else "incremental",
        "requests": sum(x.get("requests", 0) for x in summaries),
        "throttled": sum(x.get("throttled", 0) for x in summaries),
        "fetch_seconds": max((x.get("seconds", 0) for x in summaries), default=0),
        "shards": len(summaries),
        "outcome": dict(outcome),
    }
    return boards, jobs_by_url, new_state, run


def build(in_dir: Path, site: Path, state_dir: Path, today: date | None = None, boards_path: Path = BOARDS):
    today = today or datetime.now(timezone.utc).date()
    td = day(today)
    boards, jobs_by_url, new_state, run = merge(in_dir, state_dir, today, boards_path)
    _log("merged shards and state")

    # Save state first: it needs the full descriptions. After this, each description is moved
    # out of memory as its row is built (kept compressed), so the build never holds all the text.
    state_dir.mkdir(parents=True, exist_ok=True)
    save_boards_state(state_dir, new_state)
    save_jobs_state(state_dir, jobs_by_url)

    rows = []
    per_board = Counter()
    for b in boards:
        for j in jobs_by_url.get(b["board_url"], []):
            x = j.pop("x", None)
            posted = day_of(j.get("d"))
            if posted is None or posted > td:
                posted = j["f"]
            if posted < td - SHOW_DAYS:
                continue
            per_board[b["id"]] += 1
            rows.append((b["id"], b["company"], b["ats"], j["t"], j["l"], j["s"], j["r"], j["u"],
                         posted, j["f"], j["url"], j.get("p") or pay_from_text(x),
                         zlib.compress(description_bytes(x), 9) if x else None))
    rows.sort(key=lambda r: (-r[8], -r[9], r[1]))
    _log(f"built {len(rows)} rows")

    by_ats = defaultdict(lambda: {"boards": 0, "ok": 0, "error": 0, "unsupported": 0, "jobs": 0})
    board_rows = []
    for b in boards:
        n = per_board.get(b["id"], 0)
        a = by_ats[b["ats"]]
        a["boards"] += 1
        a["ok"] += b["status"] == "ok"
        a["error"] += b["status"] == "error"
        a["unsupported"] += b["status"] == "unsupported"
        a["jobs"] += n
        board_rows.append((b["id"], b["company"], b["ats"], b["board_url"], b.get("us_evidence", ""), b["status"], n))

    site_db = site / "db"
    site_db.mkdir(parents=True, exist_ok=True)
    tmp = site / "db.sqlite3.build"
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)

    _log("writing database")
    con.executemany("INSERT INTO boards VALUES (?,?,?,?,?,?,?)", board_rows)
    con.executemany("INSERT INTO jobs(board,company,ats,title,loc,state,remote,us,posted,seen,url,pay) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [r[:12] for r in rows])
    # rowids are 1..n in insertion order, so a job's id is its position in `rows`
    con.executemany("INSERT INTO job_details(job_id, body) VALUES (?, ?)",
                    ((i, r[12]) for i, r in enumerate(rows, start=1) if r[12]))
    con.commit()
    _log("indexing")
    con.executescript(INDEXES)
    con.execute("ANALYZE")
    con.commit()
    con.execute("VACUUM")
    con.close()

    _log("splitting into chunks")
    # split into fixed-size chunks for static hosting
    for old in site_db.glob("db.sqlite3.*"):
        old.unlink()
    size = tmp.stat().st_size
    with open(tmp, "rb") as f:
        i = 0
        while chunk := f.read(CHUNK):
            (site_db / f"db.sqlite3.{i:03d}").write_bytes(chunk)
            i += 1
    version = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    (site_db / "config.json").write_text(json.dumps({
        "serverMode": "chunked", "requestChunkSize": PAGE, "databaseLengthBytes": size,
        "serverChunkSize": CHUNK, "urlPrefix": "db.sqlite3.", "suffixLength": 3, "cacheBust": version}))

    # rowid cutoffs so "posted in last N days" becomes a cheap rowid range (id <= K)
    cutoffs = {}
    for n in (1, 3, 7, 14, 30):
        k = 0
        for i, r in enumerate(rows, start=1):
            if r[8] >= td - n:
                k = i
            else:
                break
        cutoffs[str(n)] = k
    states = Counter(r[5] for r in rows if r[5])
    # duplicate check: same apply link twice, or same company + title + place under different links
    urls = Counter(r[10] for r in rows)
    same_url = sum(n - 1 for n in urls.values() if n > 1)
    keyed = Counter((r[1].strip().lower(), r[3].strip().lower(), (r[4] or "").strip().lower()) for r in rows)
    same_role = sum(n - 1 for n in keyed.values() if n > 1)
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": td, "version": version, "db_bytes": size,
        "jobs": len(rows), "us_confirmed": sum(r[7] for r in rows), "remote": sum(r[6] for r in rows),
        "new_today": sum(1 for r in rows if r[9] == td),
        "with_pay": sum(1 for r in rows if r[11]),
        "with_details": sum(1 for r in rows if r[12]),
        "boards": len(board_rows),
        "boards_ok": sum(1 for r in board_rows if r[5] == "ok"),
        "boards_with_jobs": sum(1 for r in board_rows if r[6] > 0),
        "boards_error": sum(1 for r in board_rows if r[5] == "error"),
        "boards_unsupported": sum(1 for r in board_rows if r[5] == "unsupported"),
        "by_ats": dict(sorted(by_ats.items(), key=lambda kv: -kv[1]["jobs"])),
        "states": [s for s, _ in states.most_common()],
        "cutoffs": cutoffs,
        "show_days": SHOW_DAYS,
        "duplicates": {"same_url": same_url, "same_company_title_place": same_role},
        "run": run,
    }
    (site / "meta.json").write_text(json.dumps(meta, indent=1))
    _log("done")
    tmp.unlink()
    return meta


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", default="out")
    p.add_argument("--site", default="site")
    p.add_argument("--state", default="state")
    p.add_argument("--today", default="", help=argparse.SUPPRESS)
    a = p.parse_args(argv)
    meta = build(Path(a.inp), Path(a.site), Path(a.state), date.fromisoformat(a.today) if a.today else None)
    print(json.dumps({k: v for k, v in meta.items() if k not in ("by_ats", "states")}, indent=1))


if __name__ == "__main__":
    main()
