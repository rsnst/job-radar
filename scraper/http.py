"""Polite async HTTP client: global + per-host concurrency limits, retries with backoff."""
from __future__ import annotations

import asyncio
import random
from urllib.parse import urlsplit

import httpx

UA = "Mozilla/5.0 (compatible; JobRadar/1.0; +https://github.com/rsnst/job-radar)"


class FetchError(Exception):
    pass


class Client:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, *,
                 concurrency: int = 48, per_host: int = 4, timeout: float = 25.0, retries: int = 2):
        self._c = httpx.AsyncClient(
            transport=transport, timeout=timeout, follow_redirects=True,
            headers={"User-Agent": UA, "Accept": "application/json, text/html;q=0.9, */*;q=0.8"},
            limits=httpx.Limits(max_connections=concurrency * 2, max_keepalive_connections=concurrency),
        )
        self._global = asyncio.Semaphore(concurrency)
        self._hosts: dict[str, asyncio.Semaphore] = {}
        self._per_host = per_host
        self._retries = retries
        self.requests = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self._c.aclose()

    def _host_sem(self, url: str) -> asyncio.Semaphore:
        h = urlsplit(url).hostname or ""
        if h not in self._hosts:
            self._hosts[h] = asyncio.Semaphore(self._per_host)
        return self._hosts[h]

    async def request(self, method: str, url: str, **kw) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self._retries + 1):
            async with self._global, self._host_sem(url):
                try:
                    self.requests += 1
                    r = await self._c.request(method, url, **kw)
                except httpx.HTTPError as e:
                    last = e
                    r = None
            if r is not None:
                if r.status_code in (429, 500, 502, 503, 504) and attempt < self._retries:
                    ra = r.headers.get("retry-after", "")
                    wait = float(ra) if ra.isdigit() else 2 ** attempt * 2
                    await asyncio.sleep(min(wait, 30) + random.random())
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
