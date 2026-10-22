"""Description lookups inside a shard run: reuse of earlier text, time budget, and failures."""
import asyncio
import time

from scraper import details, run
from scraper.http import Deadline

BOARD = {"id": 1, "ats": "Workday", "company": "Acme", "board_url": "https://acme.wd5.myworkdayjobs.com/x"}


def job(k, url=None):
    return {"k": k, "url": url or f"https://acme.wd5.myworkdayjobs.com/x/job/{k}"}


def fake_describe(monkeypatch, fn):
    async def d(c, url, cache):
        return await fn(url)
    monkeypatch.setattr(run, "describe", d)


def test_reuses_text_from_earlier_run_without_fetching(monkeypatch):
    calls = []

    async def fn(url):
        calls.append(url)
        return "<p>new</p>"

    fake_describe(monkeypatch, fn)
    jobs = [job("a"), job("b")]
    n = asyncio.run(run.attach_details(None, BOARD, jobs, {"a": "<p>old</p>"}, {}, time.monotonic() + 60))
    assert n == 1 and len(calls) == 1
    assert jobs[0]["x"] == "<p>old</p>" and jobs[1]["x"] == "<p>new</p>"


def test_stops_at_time_budget_and_keeps_the_rest_empty(monkeypatch):
    fake_describe(monkeypatch, lambda url: asyncio.sleep(0, result="<p>x</p>"))
    jobs = [job("a"), job("b")]
    n = asyncio.run(run.attach_details(None, BOARD, jobs, {}, {}, time.monotonic() - 1))
    assert n == 0 and all("x" not in j for j in jobs)


def test_one_bad_posting_does_not_stop_the_board(monkeypatch):
    async def fn(url):
        if url.endswith("/bad"):
            raise ValueError("boom")
        return "<p>ok</p>"

    fake_describe(monkeypatch, fn)
    jobs = [job("bad", "https://acme.wd5.myworkdayjobs.com/x/job/bad"), job("good")]
    asyncio.run(run.attach_details(None, BOARD, jobs, {}, {}, time.monotonic() + 60))
    assert "x" not in jobs[0] and jobs[1]["x"] == "<p>ok</p>"


def test_deadline_from_client_keeps_jobs_without_text(monkeypatch):
    async def fn(url):
        raise Deadline("out of time")

    fake_describe(monkeypatch, fn)
    jobs = [job("a")]
    assert asyncio.run(run.attach_details(None, BOARD, jobs, {}, {}, time.monotonic() + 60)) == 0
    assert jobs == [job("a")]


def test_ats_without_detail_lookup_is_skipped(monkeypatch):
    fake_describe(monkeypatch, lambda url: asyncio.sleep(0, result="<p>x</p>"))
    jobs = [job("a")]
    board = {**BOARD, "ats": "Greenhouse"}
    assert asyncio.run(run.attach_details(None, board, jobs, {}, {}, time.monotonic() + 60)) == 0
    assert "x" not in jobs[0]


def test_jobposting_drops_repeated_description_heading(monkeypatch):
    html = ('<html><script type="application/ld+json">'
            '{"@type":"JobPosting","description":"<h2>Description</h2><p>Build things</p>"}'
            '</script></html>')

    class C:
        async def get_text(self, url, **kw):
            return html

    got = asyncio.run(details._jobposting_from_page(C(), "https://recruiting.paylocity.com/x"))
    assert got == "<p>Build things</p>"
