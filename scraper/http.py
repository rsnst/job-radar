"""Polite async HTTP client.

Requests are limited per *rate group* (the registered domain, e.g. every ADP board
shares "adp.com") by both concurrency and requests/second, so a run can't hammer
one ATS no matter how its boards are spread across shards. Retries back off on
429/5xx and honour Retry-After.
"""
from __future__ import annotations

import asyncio
import random
import time
from urllib.parse import urlsplit

import httpx

UA = "Mozilla/5.0 (compatible; JobRadar/1.0; +https://github.com/rsnst/job-radar)"


class FetchError(Exception):
    pass


class Deadline(FetchError):
    """The run's time budget ran out before this request could start."""


# Multi-tenant domains where each tenant is a separate site on shared infrastructure:
# allow a higher rate for the domain as a whole.
GROUP_RPS = {"myworkdayjobs.com": 4.0}


def rate_group(url: str) -> str:
    host = urlsplit(url).hostname or ""
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


class Client:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, *,
                 concurrency: int = 48, per_host: int = 4, rps: float = 0.0,
                 timeout: float = 25.0, retries: int = 2):
        self._c = httpx.AsyncClient(
            transport=transport, timeout=timeout, follow_redirects=True,
            headers={"User-Agent": UA, "Accept": "application/json, text/html;q=0.9, */*;q=0.8"},
            limits=httpx.Limits(max_connections=concurrency * 2, max_keepalive_connections=concurrency),
        )
        self._global = asyncio.Semaphore(concurrency)
        self._hosts: dict[str, asyncio.Semaphore] = {}
        self._next: dict[str, float] = {}
        self._per_host = per_host
        self._rps = rps
        self._retries = retries
        self.requests = 0
        self.throttled = 0
        self.deadline: float | None = None  # time.monotonic() after which no request starts

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self._c.aclose()

    def _host_sem(self, group: str) -> asyncio.Semaphore:
        if group not in self._hosts:
            self._hosts[group] = asyncio.Semaphore(self._per_host)
        return self._hosts[group]

    async def _pace(self, group: str):
        """Space request starts within a group to at most `rps` per second."""
        rps = GROUP_RPS.get(group, self._rps) if self._rps else 0
        if not rps:
            return
        loop = asyncio.get_running_loop()
        now = loop.time()
        start = max(now, self._next.get(group, 0.0))
        self._next[group] = start + 1.0 / rps
        if start > now:
            await asyncio.sleep(start - now)

    async def request(self, method: str, url: str, **kw) -> httpx.Response:
        last: Exception | None = None
        group = rate_group(url)
        for attempt in range(self._retries + 1):
            # wait for the group's slot first, so a throttled ATS doesn't hold global slots
            async with self._host_sem(group):
                await self._pace(group)
                if self.deadline is not None and time.monotonic() > self.deadline:
                    raise Deadline("run time budget exhausted")
                async with self._global:
                    try:
                        self.requests += 1
                        r = await self._c.request(method, url, **kw)
                    except httpx.HTTPError as e:
                        last = e
                        r = None
            if r is not None:
                if r.status_code in (429, 500, 502, 503, 504) and attempt < self._retries:
                    ra = r.headers.get("retry-after", "")
                    wait = min(float(ra) if ra.isdigit() else 2 ** attempt * 2, 30)
                    if r.status_code == 429:  # back the whole group off, not just this request
                        now = asyncio.get_running_loop().time()
                        self._next[group] = max(self._next.get(group, 0.0), now + wait)
                        self.throttled += 1
                    await asyncio.sleep(wait + random.random())
                    continue
                if r.status_code == 404:
                    raise FetchError("404 board not found")
                if r.status_code >= 400:
                    raise FetchError(f"HTTP {r.status_code}")
                return r
            if attempt < self._retries:
                await asyncio.sleep(2 ** attempt + random.random())
        raise FetchError(f"{type(last).__name__}: {last}")

    async def get_json(self, url: str, **kw):
        r = await self.request("GET", url, **kw)
        try:
            return r.json()
        except ValueError as e:
            raise FetchError("non-JSON response") from e

    async def post_json(self, url: str, body, **kw):
        r = await self.request("POST", url, json=body, **kw)
        try:
            return r.json()
        except ValueError as e:
            raise FetchError("non-JSON response") from e

    async def get_text(self, url: str, **kw) -> str:
        r = await self.request("GET", url, **kw)
        return r.text
