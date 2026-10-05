"""Merge shard outputs into a chunked SQLite DB the web app reads with HTTP range requests.

    python -m scraper.build_db --in out/ --site site/ --state state/
"""
from __future__ import annotations

import argparse
import glob
import gzip
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from .run import BOARDS, load_boards

EPOCH = date(1970, 1, 1)
CHUNK = 25 * 1024 * 1024
PAGE = 4096

SCHEMA = """
PRAGMA page_size = %d;
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE boards(id INTEGER PRIMARY KEY, company TEXT, ats TEXT, url TEXT, evidence TEXT,
                    status TEXT, jobs INTEGER);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, board INTEGER, company TEXT, ats TEXT, title TEXT, loc TEXT,
                  state TEXT, remote INTEGER, us INTEGER, posted INTEGER, seen INTEGER, url TEXT);
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


def day(s: str | None) -> int | None:
    if not s:
        return None
    try:
        return (date.fromisoformat(s[:10]) - EPOCH).days
    except ValueError:
        return None


def load_first_seen(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    with gzip.open(path, "rt") as f:
        return {k: int(v) for k, v in (line.rstrip("\n").split("\t") for line in f if "\t" in line)}


def save_first_seen(path: Path, fs: dict[str, int]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt") as f:
        for k, v in fs.items():
            f.write(f"{k}\t{v}\n")


def build(in_dir: Path, site: Path, state_dir: Path, today: date | None = None, boards_path: Path = BOARDS):
    today = today or datetime.now(timezone.utc).date()
    td = (today - EPOCH).days
    fs_path = state_dir / "first_seen.tsv.gz"
    first_seen = load_first_seen(fs_path)

    # board run status
    status: dict[int, dict] = {}
    for p in sorted(glob.glob(str(in_dir / "boards-*.jsonl"))):
        for line in open(p):
            s = json.loads(line)
            status[s["b"]] = s

    # jobs, deduped by key
    jobs: dict[str, dict] = {}
    for p in sorted(glob.glob(str(in_dir / "jobs-*.jsonl.gz"))):
        with gzip.open(p, "rt") as f:
            for line in f:
                j = json.loads(line)
                jobs.setdefault(j["k"], j)

    new_fs = {}
    rows = []
    per_board = Counter()
    for k, j in jobs.items():
        seen = first_seen.get(k, td)
        new_fs[k] = seen
        posted = day(j.get("d"))
        if posted is None or posted > td:
            posted = seen
        per_board[j["b"]] += 1
        rows.append((j["b"], j["c"], j["a"], j["t"], j["l"], j["s"], j["r"], j["u"], posted, seen, j["url"]))
    rows.sort(key=lambda r: (-r[8], -r[9], r[1]))

    site_db = site / "db"
    site_db.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)
    tmp = state_dir / "jobs.sqlite3"
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)

    by_ats = defaultdict(lambda: {"boards": 0, "ok": 0, "unsupported": 0, "jobs": 0})
    board_rows = []
    for b in load_boards(boards_path):
        s = status.get(b["id"])
        st = "not_run" if s is None else ("ok" if s.get("ok") else ("unsupported" if s.get("skip") else "error"))
        n = per_board.get(b["id"], 0)
        a = by_ats[b["ats"]]
        a["boards"] += 1
        a["ok"] += st == "ok"
        a["unsupported"] += st == "unsupported"
        a["jobs"] += n
        board_rows.append((b["id"], b["company"], b["ats"], b["board_url"], b["us_evidence"], st, n))
    con.executemany("INSERT INTO boards VALUES (?,?,?,?,?,?,?)", board_rows)
    con.executemany("INSERT INTO jobs(board,company,ats,title,loc,state,remote,us,posted,seen,url) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    con.executescript(INDEXES)
    con.execute("ANALYZE")
    con.commit()
    con.execute("VACUUM")
    con.close()

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
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": td, "version": version, "db_bytes": size,
        "jobs": len(rows), "us_confirmed": sum(r[7] for r in rows), "remote": sum(r[6] for r in rows),
        "new_today": sum(1 for r in rows if r[9] == td),
        "boards": len(board_rows),
        "boards_ok": sum(1 for r in board_rows if r[5] == "ok"),
        "boards_with_jobs": sum(1 for r in board_rows if r[6] > 0),
        "boards_error": sum(1 for r in board_rows if r[5] == "error"),
        "boards_unsupported": sum(1 for r in board_rows if r[5] == "unsupported"),
        "by_ats": dict(sorted(by_ats.items(), key=lambda kv: -kv[1]["jobs"])),
        "states": [s for s, _ in states.most_common()],
        "cutoffs": cutoffs,
    }
    (site / "meta.json").write_text(json.dumps(meta, indent=1))
    save_first_seen(fs_path, new_fs)
    tmp.unlink()
    return meta


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", default="out")
    p.add_argument("--site", default="site")
    p.add_argument("--state", default="state")
    a = p.parse_args(argv)
    meta = build(Path(a.inp), Path(a.site), Path(a.state))
    print(json.dumps({k: v for k, v in meta.items() if k not in ("by_ats", "states")}, indent=1))


if __name__ == "__main__":
    main()
