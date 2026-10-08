"""State carried from one run to the next (restored from the Actions cache).

boards.json.gz   {board_url: {st, n, total, top, ok, full, err}}
    st     last status: ok | error | unsupported
    n      raw jobs the ATS returned (all locations) on the last fetch
    total  the ATS's own count, for paginated boards
    top    job keys on page 1, for paginated boards
    ok     day (days since epoch) of the last successful fetch
    full   day the board's complete job list was last fetched
jobs.jsonl.gz    one line per board: {"url": board_url, "jobs": [job, ...]}
    each job carries "f", the day it was first seen
"""
from __future__ import annotations

import gzip
import json
import os
from datetime import date
from pathlib import Path

EPOCH = date(1970, 1, 1)


def day(d: date) -> int:
    return (d - EPOCH).days


def load_boards_state(state_dir: Path) -> dict[str, dict]:
    p = Path(state_dir) / "boards.json.gz"
    if not p.exists():
        return {}
    with gzip.open(p, "rt") as f:
        return json.load(f)


def _atomic(path: Path):
    """Write to a temp file, then rename over the target: an interrupted build never leaves a torn file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.with_name(path.name + ".tmp")


def save_boards_state(state_dir: Path, st: dict[str, dict]):
    p = Path(state_dir) / "boards.json.gz"
    tmp = _atomic(p)
    with gzip.open(tmp, "wt") as f:
        json.dump(st, f, separators=(",", ":"))
    os.replace(tmp, p)


def load_jobs_state(state_dir: Path) -> dict[str, list[dict]]:
    p = Path(state_dir) / "jobs.jsonl.gz"
    if not p.exists():
        return {}
    out = {}
    with gzip.open(p, "rt") as f:
        for line in f:
            r = json.loads(line)
            out[r["url"]] = r["jobs"]
    return out


def save_jobs_state(state_dir: Path, by_url: dict[str, list[dict]]):
    p = Path(state_dir) / "jobs.jsonl.gz"
    tmp = _atomic(p)
    with gzip.open(tmp, "wt", compresslevel=6) as f:
        for url, jobs in by_url.items():
            if jobs:
                f.write(json.dumps({"url": url, "jobs": jobs}, separators=(",", ":")) + "\n")
    os.replace(tmp, p)
