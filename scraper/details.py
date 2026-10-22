"""Full job descriptions for ATSs whose job list doesn't carry them.

Ported from api/detail.js (same hosts, same fields). Each lookup takes the job's apply URL
and returns description HTML, or "" when the posting has none. Errors raise FetchError,
which the caller catches so one bad posting never stops a board.
"""
from __future__ import annotations

import json
import re
from urllib.parse import quote, urlsplit

from .http import FetchError

# Board types (as named in scraper/adapters.py and meta.by_ats) that get a per-job lookup.
DETAIL_ATS = {"Rippling", "Workday", "SmartRecruiters", "BambooHR", "Workable", "Pinpoint",
              "Paylocity", "Jobvite", "Oracle Recruiting"}


def _parts(u):
    return [p for p in u.path.split("/") if p]


def _after(parts, key):
    """The segment after `key` in a path, or "" when `key` is missing (the JS version's -1 case)."""
    return parts[parts.index(key) + 1] if key in parts and parts.index(key) + 1 < len(parts) else ""


def _join(*xs):
    return "".join(x for x in xs if isinstance(x, str) and x)


async def _rippling(c, u, cache):
    p = _parts(u)
    if len(p) < 3:
        return ""
    slug, uuid = p[0], p[2]
    d = await c.get_json(f"https://api.rippling.com/platform/api/ats/v1/board/{quote(slug, safe='')}/jobs/{quote(uuid, safe='')}")
    desc = d.get("description") or {}
    return _join(desc.get("company"), desc.get("role"))


async def _workday(c, u, cache):
    p = _parts(u)
    if p and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", p[0]):
        p = p[1:]
    if len(p) < 2:
        return ""
    site, rest = p[0], p[1:]
    tenant = u.hostname.split(".")[0]
    d = await c.get_json(f"https://{u.hostname}/wday/cxs/{tenant}/{site}/{'/'.join(rest)}")
    return ((d.get("jobPostingInfo") or {}).get("jobDescription")) or ""


async def _smartrecruiters(c, u, cache):
    p = _parts(u)
    if len(p) < 2:
        return ""
    d = await c.get_json(f"https://api.smartrecruiters.com/v1/companies/{quote(p[0], safe='')}/postings/{quote(p[1], safe='')}")
    secs = (d.get("jobAd") or {}).get("sections") or {}
    text = "".join(((secs.get(k) or {}).get("text") or "")
                   for k in ("companyDescription", "jobDescription", "qualifications", "additionalInformation"))
    return text or "".join(((x or {}).get("text") or "") for x in secs.values())


async def _bamboohr(c, u, cache):
    p = _parts(u)
    if len(p) < 2:
        return ""
    d = await c.get_json(f"https://{u.hostname}/careers/{quote(p[1], safe='')}/detail")
    return (((d.get("result") or {}).get("jobOpening") or {}).get("description")) or ""


async def _workable(c, u, cache):
    p = _parts(u)
    sub, sc = (p[0] if p else ""), _after(p, "j")
    if not sub or not sc:
        return ""
    d = await c.get_json(f"https://apply.workable.com/api/v2/accounts/{quote(sub, safe='')}/jobs/{quote(sc, safe='')}")
    return _join(d.get("description"), d.get("requirements"), d.get("benefits"))


async def _pinpoint(c, u, cache):
    # The board's list already carries the text: fetch that once per board, then match by path.
    if u.hostname not in cache:
        cache[u.hostname] = (await c.get_json(f"https://{u.hostname}/postings.json")).get("data") or []
    for j in cache[u.hostname]:
        if j.get("url") and urlsplit(j["url"]).path == u.path:
            return _join(j.get("description"), j.get("key_responsibilities"),
                         j.get("skills_knowledge_expertise"), j.get("benefits"))
    return ""


_LD = re.compile(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>')


async def _jobposting_from_page(c, url):
    html = await c.get_text(url, headers={"accept": "text/html"})
    for m in _LD.finditer(html):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        nodes = []
        for d in (data if isinstance(data, list) else [data]):
            nodes.append(d)
            if isinstance(d, dict) and d.get("@graph"):
                nodes += d["@graph"] if isinstance(d["@graph"], list) else [d["@graph"]]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            t = node.get("@type")
            if "JobPosting" in (t if isinstance(t, list) else [t]) and isinstance(node.get("description"), str):
                return node["description"]
    return ""


async def _paylocity(c, u, cache):
    return await _jobposting_from_page(c, u.geturl())


async def _oracle(c, u, cache):
    p = _parts(u)
    site, jid = _after(p, "sites"), _after(p, "job")
    if not site or not jid:
        return ""
    d = await c.get_json(
        f"https://{u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true"
        f"&finder=ById;Id=\"{quote(jid, safe='')}\",siteNumber={quote(site, safe='')}")
    item = (d.get("items") or [{}])[0] or {}
    return _join(item.get("ExternalDescriptionStr"), item.get("ExternalQualificationsStr"),
                 item.get("ExternalResponsibilitiesStr"))


def _route(host: str):
    if host == "ats.rippling.com":
        return _rippling
    if host.endswith(".myworkdayjobs.com"):
        return _workday
    if host == "jobs.smartrecruiters.com":
        return _smartrecruiters
    if host.endswith(".bamboohr.com"):
        return _bamboohr
    if host == "apply.workable.com":
        return _workable
    if host.endswith(".pinpointhq.com"):
        return _pinpoint
    if host == "recruiting.paylocity.com":
        return _paylocity
    if host == "jobs.jobvite.com":
        return lambda c, u, cache: _jobposting_from_page(c, u.geturl())
    if host.endswith(".oraclecloud.com"):
        return _oracle
    return None


async def describe(c, url: str, cache: dict) -> str:
    """Description HTML for one posting, or "" when there is none or the host isn't supported."""
    u = urlsplit(url)
    if u.scheme != "https" or not u.hostname:
        return ""
    fn = _route(u.hostname)
    if fn is None:
        return ""
    return await fn(c, u, cache)
