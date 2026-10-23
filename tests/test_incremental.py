"""End-to-end check of incremental runs against a simulated set of ATS boards (no network).

Day 1 full sweep -> the world changes -> day 2 incremental -> day 9 incremental -> weekly full,
comparing the built database with the simulated truth and counting requests at each step.
"""
import asyncio
import csv
import gzip
import io
import json
import random
import sqlite3
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from scraper import build_db
from scraper.run import main_async, parse

D1, D2, D9, D14 = date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 9), date(2026, 10, 14)


class World:
    """Fake ATS backends. Each board's jobs are newest-first, like the real APIs."""

    def __init__(self, seed=1):
        rnd = random.Random(seed)
        self.boards = []  # (company, ats, url, tenant)
        self.jobs: dict[str, list[str]] = {}  # tenant -> job ids, newest first
        self.fail: set[str] = set()
        self.requests = 0
        self.by_tenant: dict[str, int] = {}
        self._next = 100000
        for i in range(30):
            t = f"wd{i}"
            self.boards.append((f"Workday Co {i}", "Workday", f"https://{t}.wd1.myworkdayjobs.com/External", t))
            self.jobs[t] = self._new(0 if i in (0, 1) else rnd.randint(1, 95))
        for i in range(15):
            t = f"adp{i}"
            self.boards.append((f"ADP Co {i}", "ADP",
                                f"https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid={t}&ccId=1", t))
            self.jobs[t] = self._new(0 if i == 0 else rnd.randint(1, 260))
        for i in range(25):
            t = f"gh{i}"
            self.boards.append((f"Greenhouse Co {i}", "Greenhouse", f"https://job-boards.greenhouse.io/{t}", t))
            self.jobs[t] = self._new(0 if i < 3 else rnd.randint(1, 40))

    def _new(self, n):
        ids = [str(self._next + k) for k in range(n)]
        self._next += n
        return ids[::-1]

    def add(self, tenant, n):
        self.jobs[tenant] = self._new(n) + self.jobs[tenant]

    def expected_keys(self):
        out = set()
        for _, ats, _, t in self.boards:
            prefix = {"Workday": f"wd:{t}:", "ADP": f"adp:{t}:", "Greenhouse": f"gh:{t}:"}[ats]
            out |= {prefix + j for j in self.jobs[t]}
        return out

    def handler(self, req: httpx.Request):
        self.requests += 1
        u = urlsplit(str(req.url))
        if "myworkdayjobs.com" in u.netloc:
            t = u.netloc.split(".")[0]
            body = json.loads(req.content)
            ids = self.jobs[t][body["offset"]: body["offset"] + body["limit"]]
            posts = [{"title": f"Engineer {j}", "externalPath": f"/job/Austin-TX/Engineer_{j}",
                      "locationsText": "Austin, TX", "postedOn": "Posted Today", "bulletFields": [j]} for j in ids]
            return self._reply(t, {"total": len(self.jobs[t]), "jobPostings": posts})
        if u.netloc == "workforcenow.adp.com":
            q = parse_qs(u.query)
            t, skip, top = q["cid"][0], int(q["$skip"][0]), int(q["$top"][0])
            reqs = [{"itemID": j, "requisitionTitle": f"Analyst {j}",
                     "requisitionLocations": [{"address": {"cityName": "Dallas", "countrySubdivisionLevel1": {"codeValue": "TX"},
                                                           "country": {"codeValue": "US"}}}]}
                    for j in self.jobs[t][skip: skip + top]]
            return self._reply(t, {"meta": {"totalNumber": len(self.jobs[t])}, "jobRequisitions": reqs})
        if u.netloc == "boards-api.greenhouse.io":
            t = u.path.split("/")[3]
            return self._reply(t, {"jobs": [{"id": int(j), "title": f"Developer {j}", "location": {"name": "Remote - US"},
                                             "absolute_url": f"https://job-boards.greenhouse.io/{t}/jobs/{j}"}
                                            for j in self.jobs[t]]})
        return httpx.Response(404)

    def _reply(self, tenant, payload):
        self.by_tenant[tenant] = self.by_tenant.get(tenant, 0) + 1
        if tenant in self.fail:
            return httpx.Response(503)
        return httpx.Response(200, json=payload)


def write_boards(world, path: Path):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["company", "ats", "board_url", "us_evidence", "us_share_pct", "open_jobs"])
    for co, ats, url, _ in world.boards:
        w.writerow([co, ats, url, "US jobs", "100", ""])
    with gzip.open(path, "wt") as f:
        f.write(buf.getvalue())


def run_day(world, tmp: Path, day: date, mode: str):
    out = tmp / f"out-{day.isoformat()}"
    world.requests, world.by_tenant = 0, {}
    args = parse(["--mode", mode, "--state", str(tmp / "state"), "--boards", str(tmp / "boards.csv.gz"),
                  "--out", str(out), "--rps", "0", "--today", day.isoformat()])
    summary = asyncio.run(main_async(args, transport=httpx.MockTransport(world.handler)))
    meta = build_db.build(out, tmp / "site", tmp / "state", today=day, boards_path=tmp / "boards.csv.gz")
    return summary, meta, world.requests


def db_rows(tmp: Path):
    db_dir = tmp / "site" / "db"
    cfg = json.loads((db_dir / "config.json").read_text())
    chunks = sorted(db_dir.glob("db.sqlite3.*"))
    # chunk names carry the build version, so one name never holds two builds' bytes
    assert cfg["urlPrefix"] == f"db.sqlite3.{cfg['cacheBust']}."
    assert [c.name for c in chunks] == [f"{cfg['urlPrefix']}{i:03d}" for i in range(len(chunks))]
    assert sum(c.stat().st_size for c in chunks) == cfg["databaseLengthBytes"]
    raw = b"".join(c.read_bytes() for c in chunks)
    p = tmp / "check.sqlite3"
    p.write_bytes(raw)
    con = sqlite3.connect(p)
    rows = con.execute("SELECT url, seen FROM jobs").fetchall()
    con.close()
    return rows


def keys_from_db(world, tmp):
    """Map DB rows back to world keys via their URLs."""
    keys, seen = set(), {}
    for url, s in db_rows(tmp):
        if "myworkdayjobs.com" in url:
            k = f"wd:{urlsplit(url).netloc.split('.')[0]}:{url.rsplit('_', 1)[1]}"
        elif "adp.com" in url:
            q = parse_qs(urlsplit(url).query)
            k = f"adp:{q['cid'][0]}:{q['jobId'][0]}"
        else:
            parts = urlsplit(url).path.split("/")
            k = f"gh:{parts[1]}:{parts[3]}"
        keys.add(k)
        seen[k] = s
    return keys, seen


@pytest.fixture
def world(tmp_path):
    w = World()
    write_boards(w, tmp_path / "boards.csv.gz")
    return w


def test_incremental_lifecycle(world, tmp_path):
    # ---- day 1: no state yet -> runner falls back to a full sweep
    s1, m1, req_full = run_day(world, tmp_path, D1, "incremental")
    assert s1["mode"] == "full"
    keys, seen = keys_from_db(world, tmp_path)
    assert keys == world.expected_keys()
    assert set(seen.values()) == {(D1 - date(1970, 1, 1)).days}

    # ---- the world changes
    world.add("wd2", 3)                         # new postings land on page 1
    world.jobs["wd3"].pop(-1)                   # a deep posting closes -> total drops
    world.add("adp1", 1)
    world.add("gh3", 2)
    world.jobs["gh4"] = world.jobs["gh4"][1:]   # single-request ATS: closing is always seen
    world.add("wd0", 5)                         # an empty board starts hiring
    world.fail.add("adp2")                      # an ATS outage for one board
    adp2_before = {f"adp:adp2:{j}" for j in world.jobs["adp2"]}
    world.add("adp2", 1)                        # ...hiding a new posting

    # ---- day 2: incremental
    s2, m2, req_inc = run_day(world, tmp_path, D2, "incremental")
    assert s2["mode"] == "incremental"
    keys, seen = keys_from_db(world, tmp_path)
    expected = world.expected_keys()
    blind = {k for k in expected if k.startswith("wd:wd0:")} | {k for k in expected if k.startswith("adp:adp2:")}
    assert expected - keys == blind - adp2_before  # only the skipped empty board + outage board's new job
    assert keys - expected == set()               # nothing stale except via the outage board (still open)
    assert adp2_before <= keys                     # outage board keeps yesterday's jobs

    # paginated boards that didn't change cost exactly one request
    for t in ("wd5", "wd6", "adp3"):
        assert world.by_tenant[t] == 1, t
    # changed boards were crawled in full
    # changed boards keep paging on from the probe: no request is wasted
    assert world.by_tenant["wd2"] == -(-len(world.jobs["wd2"]) // 20)
    assert "wd0" not in world.by_tenant and "gh0" not in world.by_tenant   # empty boards skipped
    assert req_inc < req_full * 0.75, (req_inc, req_full)

    # first-seen dates: old jobs keep day 1, new ones get day 2
    d1, d2 = ((x - date(1970, 1, 1)).days for x in (D1, D2))
    assert seen["gh:gh3:" + world.jobs["gh3"][0]] == d2
    assert seen["gh:gh3:" + world.jobs["gh3"][-1]] == d1
    assert m2["run"]["outcome"]["skipped_empty"] == 6  # wd0, wd1, adp0, gh0-2
    assert m2["run"]["outcome"]["error_kept_last"] == 1

    # ---- day 9: empty boards are due for their weekly re-check
    world.fail.clear()
    s9, m9, _ = run_day(world, tmp_path, D9, "incremental")
    keys, _ = keys_from_db(world, tmp_path)
    assert keys == world.expected_keys()

    # ---- weekly full sweep agrees exactly
    world.jobs["wd7"] = world.jobs["wd7"][:-1] + [str(999999)]  # same total, deep change: only a full sweep sees it
    s14, m14, req = run_day(world, tmp_path, D14, "full")
    keys, _ = keys_from_db(world, tmp_path)
    assert keys == world.expected_keys()
    print(f"\nrequests: full {req_full}, incremental {req_inc} ({req_inc / req_full:.0%})")


def test_outage_longer_than_stale_window_drops_jobs(world, tmp_path):
    run_day(world, tmp_path, D1, "full")
    world.fail.add("gh5")
    run_day(world, tmp_path, D2, "incremental")
    assert any(k.startswith("gh:gh5:") for k in keys_from_db(world, tmp_path)[0])
    run_day(world, tmp_path, D9, "incremental")  # failing for > STALE_DAYS since last success
    assert not any(k.startswith("gh:gh5:") for k in keys_from_db(world, tmp_path)[0])
