"""One fetcher per ATS. Each returns a list of raw job dicts:

    {key, title, loc, country?, remote?, posted?, url, dept?}

`posted` may be an ISO string, a date string, epoch millis, or None.
Fetchers raise FetchError (or Unsupported) on failure.
"""
from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urlencode, urlsplit

from bs4 import BeautifulSoup

from .http import Client, FetchError


class Unsupported(Exception):
    pass


def _parts(url: str):
    s = urlsplit(url.strip())
    host = (s.hostname or "").lower()
    path = [p for p in s.path.split("/") if p]
    return s, host, path


def _sub(host: str) -> str:
    return host.split(".")[0]


# ---------------------------------------------------------------- JSON APIs

async def greenhouse(c: Client, url: str):
    _, host, path = _parts(url)
    if "greenhouse.io" not in host or not path:
        raise Unsupported("custom Greenhouse domain")
    token = path[0]
    api = "boards-api.eu.greenhouse.io" if ".eu." in host else "boards-api.greenhouse.io"
    d = await c.get_json(f"https://{api}/v1/boards/{token}/jobs")
    out = []
    for j in d.get("jobs", []):
        out.append(dict(
            key=f"gh:{token}:{j['id']}", title=j.get("title"),
            loc=(j.get("location") or {}).get("name"),
            posted=j.get("first_published") or j.get("updated_at"),
            url=j.get("absolute_url")))
    return out


async def gem(c: Client, url: str):
    _, host, path = _parts(url)
    slug = path[0]
    d = await c.get_json(f"https://api.gem.com/job_board/v0/{slug}/job_posts/")
    jobs = d if isinstance(d, list) else d.get("jobs", d.get("job_posts", []))
    return [dict(key=f"gem:{slug}:{j['id']}", title=j.get("title"),
                 loc=(j.get("location") or {}).get("name") if isinstance(j.get("location"), dict) else j.get("location"),
                 remote=j.get("location_type") == "remote",
                 posted=j.get("first_published_at") or j.get("updated_at"),
                 url=j.get("absolute_url")) for j in jobs]


async def lever(c: Client, url: str):
    _, host, path = _parts(url)
    if "lever.co" not in host or not path:
        raise Unsupported("custom Lever domain")
    site = path[0]
    api = "api.eu.lever.co" if ".eu." in host else "api.lever.co"
    d = await c.get_json(f"https://{api}/v0/postings/{site}?mode=json")
    out = []
    for j in d if isinstance(d, list) else []:
        cat = j.get("categories") or {}
        locs = cat.get("allLocations") or [cat.get("location")]
        out.append(dict(
            key=f"lever:{site}:{j['id']}", title=j.get("text"),
            loc=" | ".join(x for x in locs if x), country=j.get("country"),
            remote=j.get("workplaceType") == "remote", posted=j.get("createdAt"),
            url=j.get("hostedUrl"), dept=cat.get("team")))
    return out


async def ashby(c: Client, url: str):
    _, host, path = _parts(url)
    if "ashbyhq.com" not in host or not path:
        raise Unsupported("custom Ashby domain")
    name = path[0]
    d = await c.get_json(f"https://api.ashbyhq.com/posting-api/job-board/{name}")
    out = []
    for j in d.get("jobs", []):
        if j.get("isListed") is False:
            continue
        addr = ((j.get("address") or {}).get("postalAddress") or {})
        locs = [j.get("location")] + [s.get("location") for s in j.get("secondaryLocations") or []]
        out.append(dict(
            key=f"ashby:{name}:{j['id']}", title=j.get("title"),
            loc=" | ".join(x for x in locs if x), country=addr.get("addressCountry"),
            remote=j.get("isRemote") or j.get("workplaceType") == "Remote",
            posted=j.get("publishedAt"), url=j.get("jobUrl"), dept=j.get("department")))
    return out


async def smartrecruiters(c: Client, url: str):
    _, host, path = _parts(url)
    if "smartrecruiters.com" not in host or not path:
        raise Unsupported("custom SmartRecruiters domain")
    co = path[0]
    out, offset = [], 0
    while True:
        d = await c.get_json(f"https://api.smartrecruiters.com/v1/companies/{co}/postings?limit=100&offset={offset}")
        content = d.get("content", [])
        for j in content:
            l = j.get("location") or {}
            loc = l.get("fullLocation") or ", ".join(x for x in [l.get("city"), l.get("region")] if x)
            out.append(dict(
                key=f"sr:{co}:{j['id']}", title=j.get("name"), loc=loc, country=l.get("country"),
                remote=l.get("remote"), posted=j.get("releasedDate"),
                url=f"https://jobs.smartrecruiters.com/{co}/{j['id']}"))
        offset += 100
        if not content or offset >= d.get("totalFound", 0) or offset >= 5000:
            return out


async def workable(c: Client, url: str):
    _, host, path = _parts(url)
    if "workable.com" not in host or not path:
        raise Unsupported("custom Workable domain")
    sub = path[0]
    body = {"query": "", "department": [], "location": [], "remote": [], "workplace": [], "worktype": []}
    out = []
    for _ in range(50):
        d = await c.post_json(f"https://apply.workable.com/api/v3/accounts/{sub}/jobs", body)
        for j in d.get("results", []):
            l = j.get("location") or {}
            out.append(dict(
                key=f"wk:{sub}:{j['shortcode']}", title=j.get("title"),
                loc=", ".join(x for x in [l.get("city"), l.get("region"), l.get("country")] if x),
                country=l.get("countryCode") or l.get("country"),
                remote=j.get("remote") or j.get("workplace") == "remote", posted=j.get("published"),
                url=f"https://apply.workable.com/{sub}/j/{j['shortcode']}/"))
        if not d.get("nextPage"):
            break
        body["token"] = d["nextPage"]
    return out


async def recruitee(c: Client, url: str):
    _, host, _ = _parts(url)
    sub = _sub(host)
    d = await c.get_json(f"https://{sub}.recruitee.com/api/offers/")
    return [dict(key=f"rt:{sub}:{j['id']}", title=j.get("title"),
                 loc=j.get("location") or ", ".join(x for x in [j.get("city"), j.get("state_code")] if x),
                 country=j.get("country_code"), remote=j.get("remote"),
                 posted=j.get("published_at"), url=j.get("careers_url"), dept=j.get("department"))
            for j in d.get("offers", [])]


async def bamboohr(c: Client, url: str):
    _, host, _ = _parts(url)
    sub = _sub(host)
    d = await c.get_json(f"https://{sub}.bamboohr.com/careers/list")
    out = []
    for j in d.get("result", []):
        l = j.get("atsLocation") or j.get("location") or {}
        out.append(dict(
            key=f"bhr:{sub}:{j['id']}", title=j.get("jobOpeningName"),
            loc=", ".join(x for x in [l.get("city"), l.get("state")] if x), country=l.get("country"),
            remote=bool(j.get("isRemote")) or j.get("locationType") == "1",
            url=f"https://{sub}.bamboohr.com/careers/{j['id']}", dept=j.get("departmentLabel")))
    return out


async def breezy(c: Client, url: str):
    _, host, _ = _parts(url)
    sub = _sub(host)
    d = await c.get_json(f"https://{sub}.breezy.hr/json")
    out = []
    for j in d if isinstance(d, list) else []:
        l = j.get("location") or {}
        country = l.get("country")
        out.append(dict(
            key=f"bz:{sub}:{j['id']}", title=j.get("name"), loc=l.get("name"),
            country=country.get("id") if isinstance(country, dict) else country,
            remote=l.get("is_remote"), posted=j.get("published_date"), url=j.get("url"),
            dept=j.get("department")))
    return out


async def rippling(c: Client, url: str):
    _, _, path = _parts(url)
    slug = path[0]
    d = await c.get_json(f"https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs")
    jobs = d if isinstance(d, list) else d.get("items", d.get("jobs", []))
    out = []
    for j in jobs:
        wl = j.get("workLocation") or {}
        loc = wl.get("label") if isinstance(wl, dict) else wl
        jid = j.get("uuid") or j.get("id")
        out.append(dict(
            key=f"rip:{slug}:{jid}", title=j.get("name") or j.get("title"), loc=loc,
            url=j.get("url") or f"https://ats.rippling.com/{slug}/jobs/{jid}",
            dept=(j.get("department") or {}).get("label") if isinstance(j.get("department"), dict) else None))
    return out


async def pinpoint(c: Client, url: str):
    _, host, _ = _parts(url)
    sub = _sub(host)
    d = await c.get_json(f"https://{sub}.pinpointhq.com/postings.json")
    out = []
    for j in d.get("data", []):
        l = j.get("location") or {}
        out.append(dict(
            key=f"pp:{sub}:{j['id']}", title=j.get("title"),
            loc=l.get("name") or ", ".join(x for x in [l.get("city"), l.get("province")] if x),
            remote=j.get("workplace_type") == "remote", url=j.get("url"),
            posted=j.get("published_at") or j.get("created_at")))
    return out


# ---------------------------------------------------------------- enterprise

_WD_LOCALE = re.compile(r"^[a-z]{2}-[A-Z]{2}$")
_WD_POSTED = re.compile(r"(\d+)\+?\s+Days?\s+Ago", re.I)


def _wd_posted(s: str | None):
    if not s:
        return None
    low = s.lower()
    if "today" in low:
        return "-0d"
    if "yesterday" in low:
        return "-1d"
    m = _WD_POSTED.search(s)
    return f"-{m.group(1)}d" if m else None


async def workday(c: Client, url: str, max_jobs: int = 10000):
    _, host, path = _parts(url)
    if "myworkdayjobs.com" not in host:
        raise Unsupported("custom Workday domain")
    tenant = _sub(host)
    path = [p for p in path if not _WD_LOCALE.match(p)]
    if not path:
        raise Unsupported("no Workday site in URL")
    site = path[0]
    api = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    out, offset, total = [], 0, None
    while True:
        d = await c.post_json(api, {"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": ""})
        if total is None:
            total = d.get("total") or 0
        posts = d.get("jobPostings", [])
        for j in posts:
            ext = j.get("externalPath") or ""
            req = (j.get("bulletFields") or [None])[0] or ext.rsplit("_", 1)[-1]
            out.append(dict(
                key=f"wd:{tenant}:{req}", title=j.get("title"), loc=j.get("locationsText"),
                remote=j.get("remoteType"), posted=_wd_posted(j.get("postedOn")),
                url=f"https://{host}/en-US/{site}{ext}"))
        offset += 20
        if not posts or offset >= total or offset >= max_jobs:
            return out


async def paylocity(c: Client, url: str):
    html = await c.get_text(url)
    m = re.search(r"window\.pageData\s*=\s*(\{.*?\});\s*</script>", html, re.S)
    if not m:
        raise FetchError("pageData not found")
    data = json.loads(m.group(1))
    out = []
    for j in data.get("Jobs", []):
        jl = j.get("JobLocation") or {}
        out.append(dict(
            key=f"pcty:{j['JobId']}", title=j.get("JobTitle"),
            loc=j.get("LocationName") or ", ".join(x for x in [jl.get("City"), jl.get("State")] if x),
            country=jl.get("Country"), remote=j.get("IsRemote"), posted=j.get("PublishedDate"),
            url=f"https://recruiting.paylocity.com/Recruiting/Jobs/Details/{j['JobId']}"))
    return out


async def adp(c: Client, url: str):
    s, host, _ = _parts(url)
    if host != "workforcenow.adp.com":
        raise Unsupported("ADP MyJobs sites need a session token")
    q = parse_qs(s.query)
    cid, ccid = q.get("cid", [None])[0], q.get("ccId", ["19000101_000001"])[0]
    if not cid:
        raise Unsupported("no ADP cid")
    out, skip = [], 0
    base = "https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions"
    while True:
        qs = urlencode({"cid": cid, "ccId": ccid, "lang": "en_US", "locale": "en_US", "$top": 100, "$skip": skip})
        d = await c.get_json(f"{base}?{qs}")
        reqs = d.get("jobRequisitions", [])
        for j in reqs:
            locs = j.get("requisitionLocations") or []
            a = (locs[0].get("address") or {}) if locs else {}
            st = ((a.get("countrySubdivisionLevel1") or {}).get("codeValue"))
            loc = ", ".join(x for x in [a.get("cityName"), st] if x) or (
                (locs[0].get("nameCode") or {}).get("shortName") if locs else None)
            out.append(dict(
                key=f"adp:{cid}:{j['itemID']}", title=j.get("requisitionTitle"), loc=loc,
                country=(a.get("country") or {}).get("codeValue"), posted=j.get("postDate"),
                url=f"{url}&jobId={j['itemID']}"))
        skip += 100
        total = (d.get("meta") or {}).get("totalNumber", 0)
        if not reqs or skip >= total or skip >= 3000:
            return out


async def ukg(c: Client, url: str):
    s, host, path = _parts(url)
    if "JobBoard" not in path:
        raise Unsupported("unrecognised UKG URL")
    i = path.index("JobBoard")
    board = f"https://{host}/{'/'.join(path[:i + 2])}"
    out, skip = [], 0
    while True:
        body = {"opportunitySearch": {
            "Top": 50, "Skip": skip, "QueryString": "",
            "OrderBy": [{"Value": "postedDateDesc", "PropertyName": "PostedDate", "Ascending": False}],
            "Filters": [{"t": "TermsSearchFilterDto", "fieldName": n, "extra": None, "values": []} for n in (4, 5, 6)]},
            "matchCriteria": {"PreferredJobs": [], "Educations": [], "LicenseAndCertifications": [],
                              "Skills": [], "hasNoLicenses": False, "SkippedSkills": []}}
        d = await c.post_json(f"{board}/JobBoardView/LoadSearchResults", body)
        opps = d.get("opportunities", [])
        for j in opps:
            locs = j.get("Locations") or [{}]
            a = (locs[0] or {}).get("Address") or {}
            loc = ", ".join(x for x in [a.get("City"), (a.get("State") or {}).get("Code")] if x) or (locs[0] or {}).get("LocalizedDescription")
            out.append(dict(
                key=f"ukg:{path[i - 1]}:{j['Id']}", title=j.get("Title"), loc=loc,
                country=(a.get("Country") or {}).get("Code"), remote=j.get("JobLocationType") == 2,
                posted=j.get("PostedDate"), url=f"{board}/OpportunityDetail?opportunityId={j['Id']}"))
        skip += 50
        if not opps or skip >= d.get("totalCount", 0) or skip >= 3000:
            return out


async def oracle(c: Client, url: str):
    _, host, path = _parts(url)
    if "oraclecloud.com" not in host or "sites" not in path:
        raise Unsupported("Taleo/custom Oracle site")
    site = path[path.index("sites") + 1]
    out, offset = [], 0
    while True:
        api = (f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true"
               f"&expand=requisitionList&finder=findReqs;siteNumber={site},limit=200,offset={offset},sortBy=POSTING_DATES_DESC")
        d = await c.get_json(api)
        item = (d.get("items") or [{}])[0]
        reqs = item.get("requisitionList") or []
        for j in reqs:
            out.append(dict(
                key=f"orc:{host.split('.')[0]}:{j['Id']}", title=j.get("Title"),
                loc=j.get("PrimaryLocation"), country=j.get("PrimaryLocationCountry"),
                remote=(j.get("WorkplaceType") or "").lower().startswith("remote"),
                posted=j.get("PostedDate"),
                url=f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{j['Id']}"))
        offset += 200
        if not reqs or offset >= (item.get("TotalJobsCount") or 0) or offset >= 5000:
            return out


# ---------------------------------------------------------------- HTML boards

async def jazzhr(c: Client, url: str):
    _, host, _ = _parts(url)
    soup = BeautifulSoup(await c.get_text(f"https://{host}/apply"), "lxml")
    out = []
    for a in soup.select('a[href*="/apply/"]'):
        m = re.search(r"/apply/([A-Za-z0-9]{6,})/", a.get("href", ""))
        if not m or not a.get_text(strip=True):
            continue
        li = a.find_parent("li")
        loc_el = li.select_one(".fa-map-marker") if li else None
        loc = loc_el.parent.get_text(" ", strip=True) if loc_el else None
        out.append(dict(key=f"jazz:{_sub(host)}:{m.group(1)}", title=a.get_text(" ", strip=True),
                        loc=loc, url=a["href"] if a["href"].startswith("http") else f"https://{host}{a['href']}"))
    return _dedupe(out)


async def jobvite(c: Client, url: str):
    _, _, path = _parts(url)
    co = path[0]
    soup = BeautifulSoup(await c.get_text(f"https://jobs.jobvite.com/{co}/jobs"), "lxml")
    out = []
    for row in soup.select("tr"):
        a = row.select_one('a[href*="/job/"]')
        if not a:
            continue
        jid = a["href"].rstrip("/").rsplit("/", 1)[-1]
        loc = row.select_one(".jv-job-list-location")
        out.append(dict(key=f"jv:{co}:{jid}", title=a.get_text(" ", strip=True),
                        loc=loc.get_text(" ", strip=True) if loc else None,
                        url=f"https://jobs.jobvite.com{a['href']}" if a["href"].startswith("/") else a["href"]))
    return _dedupe(out)


async def icims(c: Client, url: str):
    _, host, _ = _parts(url)
    out, seen = [], set()
    for page in range(40):
        soup = BeautifulSoup(await c.get_text(f"https://{host}/jobs/search?ss=1&in_iframe=1&pr={page}"), "lxml")
        new = 0
        for a in soup.select('a[href*="/jobs/"]'):
            m = re.search(r"/jobs/(\d+)/", a.get("href", ""))
            if not m or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            new += 1
            row = a.find_parent(class_=re.compile("row")) or a.parent
            text = row.get_text(" ", strip=True) if row else ""
            lm = re.search(r"\b([A-Z]{2}-[A-Z]{2}-[A-Za-z .'-]+?)(?=\s{2,}|\s+[A-Z][a-z]+:|$)", text)
            title = a.get_text(" ", strip=True)
            title = re.sub(r"^Title\s*", "", title)
            out.append(dict(key=f"icims:{_sub(host)}:{m.group(1)}", title=title,
                            loc=lm.group(1) if lm else None, url=a["href"].split("?")[0]))
        if new == 0:
            break
    return out


def _dedupe(jobs):
    seen, out = set(), []
    for j in jobs:
        if j["key"] not in seen:
            seen.add(j["key"])
            out.append(j)
    return out


async def unsupported(c: Client, url: str):
    raise Unsupported("no fetcher yet")


FETCHERS = {
    "Greenhouse": greenhouse, "Gem": gem, "Lever": lever, "Ashby": ashby,
    "SmartRecruiters": smartrecruiters, "Workable": workable, "Recruitee": recruitee,
    "BambooHR": bamboohr, "BreezyHR": breezy, "Rippling": rippling, "Pinpoint": pinpoint,
    "Workday": workday, "Paylocity": paylocity, "ADP": adp, "UltiPro / UKG": ukg,
    "Oracle Recruiting": oracle, "JazzHR": jazzhr, "Jobvite": jobvite, "iCIMS": icims,
}


def fetcher_for(ats: str):
    return FETCHERS.get(ats, unsupported)
