"""Adapter tests against recorded-shape responses (no network)."""
import asyncio
import json

import httpx
import pytest

from scraper import adapters
from scraper.http import Client
from scraper.run import normalize, norm_date
from datetime import date

ROUTES = {
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {"jobs": [
        {"id": 1, "title": "Software Engineer", "absolute_url": "https://job-boards.greenhouse.io/acme/jobs/1",
         "location": {"name": "Austin, TX"}, "first_published": "2026-10-01T10:00:00-04:00",
         "content": "&lt;p&gt;Build .NET services.&lt;/p&gt;",
         "pay_input_ranges": [{"min_cents": 12000000, "max_cents": 15000000, "currency_type": "USD", "title": "Base"}]},
        {"id": 2, "title": "SWE London", "absolute_url": "https://x/2", "location": {"name": "London, UK"},
         "updated_at": "2026-09-01T00:00:00Z"}]},
    "https://api.lever.co/v0/postings/acme?mode=json": [
        {"id": "abc", "text": "Data Engineer", "hostedUrl": "https://jobs.lever.co/acme/abc", "createdAt": 1790000000000,
         "categories": {"location": "Remote", "team": "Data"}, "workplaceType": "remote", "country": "US"}],
    "https://api.ashbyhq.com/posting-api/job-board/acme": {"jobs": [
        {"id": "u1", "title": "Backend Engineer", "location": "New York", "isRemote": False, "isListed": True,
         "publishedAt": "2026-10-02T00:00:00Z", "jobUrl": "https://jobs.ashbyhq.com/acme/u1",
         "address": {"postalAddress": {"addressCountry": "United States", "addressRegion": "NY"}}}]},
    "https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=0": {"totalFound": 1, "content": [
        {"id": "744", "name": ".NET Developer", "releasedDate": "2026-09-30T12:00:00.000Z",
         "location": {"city": "Dallas", "region": "TX", "country": "us", "remote": False}}]},
    "https://acme.recruitee.com/api/offers/": {"offers": [
        {"id": 9, "title": "PM", "location": "Denver, CO", "country_code": "US", "remote": False,
         "published_at": "2026-09-20 10:00:00 UTC", "careers_url": "https://acme.recruitee.com/o/pm"}]},
    "https://acme.bamboohr.com/careers/list": {"result": [
        {"id": "12", "jobOpeningName": "Accountant", "location": {"city": "Boise", "state": "Idaho"}, "isRemote": None}]},
    "https://acme.breezy.hr/json": [
        {"id": "z", "name": "Nurse", "url": "https://acme.breezy.hr/p/z", "published_date": "2026-09-10T00:00:00Z",
         "location": {"name": "Tampa, FL", "country": {"id": "US"}, "is_remote": False}}],
    "https://acme.pinpointhq.com/postings.json": {"data": [
        {"id": 5, "title": "Analyst", "url": "https://acme.pinpointhq.com/postings/5", "location": {"name": "Chicago, IL"}}]},
    "https://api.rippling.com/platform/api/ats/v1/board/acme/jobs": [
        {"uuid": "r1", "name": "Ops Lead", "url": "https://ats.rippling.com/acme/jobs/r1", "workLocation": {"label": "Remote (United States)"}}],
}
WORKDAY = {"total": 2, "jobPostings": [
    {"title": "Sr Data Engineer", "externalPath": "/job/Plano-TX/Sr-Data-Engineer_R100", "locationsText": "Plano, TX",
     "postedOn": "Posted 3 Days Ago", "bulletFields": ["R100"]},
    {"title": "Analyst", "externalPath": "/job/Pune/Analyst_R101", "locationsText": "Pune, India",
     "postedOn": "Posted Today", "bulletFields": ["R101"]}]}
PAYLOCITY_HTML = """<html><script>window.pageData = {"Jobs":[{"JobId":77,"JobTitle":"Driver","LocationName":"San Antonio, TX",
"PublishedDate":"2026-09-29T00:00:00","JobLocation":{"City":"San Antonio","State":"TX","Country":"USA"}}]};</script></html>"""
WORKABLE = {"results": [{"shortcode": "ABC", "title": "QA", "published": "2026-09-01",
                         "location": {"city": "Miami", "region": "Florida", "country": "United States", "countryCode": "US"}}],
            "nextPage": None}
ADP = {"meta": {"totalNumber": 1}, "jobRequisitions": [
    {"itemID": "999", "requisitionTitle": "Mechanic", "postDate": "2026-09-15T00:00:00Z",
     "requisitionLocations": [{"address": {"cityName": "Reno", "countrySubdivisionLevel1": {"codeValue": "NV"},
                                           "country": {"codeValue": "US"}}}]}]}
UKG = {"totalCount": 1, "opportunities": [{"Id": "g-1", "Title": "Clerk", "PostedDate": "2026-09-02T00:00:00Z",
       "Locations": [{"Address": {"City": "Omaha", "State": {"Code": "NE"}, "Country": {"Code": "USA"}}}]}]}
ORACLE = {"items": [{"TotalJobsCount": 1, "requisitionList": [
    {"Id": "300", "Title": "Engineer", "PostedDate": "2026-09-25", "PrimaryLocation": "Austin, TX, United States",
     "PrimaryLocationCountry": "US"}]}]}
JAZZ = """<ul><li class="list-group-item"><h4><a href="https://acme.applytojob.com/apply/AbCdEf12/Welder">Welder</a></h4>
<ul><li><i class="fa fa-map-marker"></i> Tulsa, OK</li></ul></li></ul>"""
JOBVITE = """<table><tr><td class="jv-job-list-name"><a href="/acme/job/oXYZ">Chef</a></td>
<td class="jv-job-list-location">Portland, OR</td></tr></table>"""
ICIMS = """<div class="row"><a href="https://careers-acme.icims.com/jobs/4321/rn/job?in_iframe=1"><h3>Title RN</h3></a>
<div>US-TX-Houston   Category: Nursing</div></div>"""


def handler(req: httpx.Request):
    u = str(req.url)
    if u in ROUTES:
        return httpx.Response(200, json=ROUTES[u])
    if "/wday/cxs/" in u:
        body = json.loads(req.content)
        return httpx.Response(200, json=WORKDAY if body["offset"] == 0 else {"total": 0, "jobPostings": []})
    if "paylocity" in u:
        return httpx.Response(200, text=PAYLOCITY_HTML)
    if "workable.com/api/v3" in u:
        return httpx.Response(200, json=WORKABLE)
    if "job-requisitions" in u:
        return httpx.Response(200, json=ADP)
    if "LoadSearchResults" in u:
        return httpx.Response(200, json=UKG)
    if "recruitingCEJobRequisitions" in u:
        return httpx.Response(200, json=ORACLE)
    if "applytojob.com/apply" in u:
        return httpx.Response(200, text=JAZZ)
    if "jobs.jobvite.com" in u:
        return httpx.Response(200, text=JOBVITE)
    if "icims.com/jobs/search" in u:
        return httpx.Response(200, text=ICIMS if "pr=0" in u else "<html></html>")
    return httpx.Response(404)


CASES = [
    ("Greenhouse", "https://job-boards.greenhouse.io/acme", 2),
    ("Lever", "https://jobs.lever.co/acme", 1),
    ("Ashby", "https://jobs.ashbyhq.com/acme", 1),
    ("SmartRecruiters", "https://careers.smartrecruiters.com/Acme", 1),
    ("Recruitee", "https://acme.recruitee.com", 1),
    ("BambooHR", "https://acme.bamboohr.com/careers", 1),
    ("BreezyHR", "https://acme.breezy.hr", 1),
    ("Pinpoint", "https://acme.pinpointhq.com", 1),
    ("Rippling", "https://ats.rippling.com/acme/jobs", 1),
    ("Workday", "https://acme.wd5.myworkdayjobs.com/en-US/External", 2),
    ("Paylocity", "https://recruiting.paylocity.com/recruiting/jobs/All/abc", 1),
    ("Workable", "https://apply.workable.com/acme/", 1),
    ("ADP", "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=c1&ccId=19000101_000001", 1),
    ("UltiPro / UKG", "https://recruiting.ultipro.com/ACM1000/JobBoard/guid-1", 1),
    ("Oracle Recruiting", "https://abc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1", 1),
    ("JazzHR", "https://acme.applytojob.com", 1),
    ("Jobvite", "https://jobs.jobvite.com/acme", 1),
    ("iCIMS", "https://careers-acme.icims.com", 1),
]


async def _fetch(ats, url):
    async with Client(transport=httpx.MockTransport(handler), retries=0) as c:
        return await adapters.fetcher_for(ats)(c, url)


@pytest.mark.parametrize("ats,url,n", CASES)
def test_adapter(ats, url, n):
    jobs = asyncio.run(_fetch(ats, url))
    assert len(jobs) == n, jobs
    for j in jobs:
        assert j["key"] and j["title"] and j["url"]


def test_normalize_filters_non_us_and_keeps_us():
    board = {"id": 3, "company": "Acme", "ats": "Workday", "us_share_pct": ""}
    jobs = asyncio.run(_fetch("Workday", "https://acme.wd5.myworkdayjobs.com/External"))
    out = [normalize(board, j) for j in jobs]
    assert out[0]["s"] == "TX" and out[0]["u"] == 1
    assert out[1] is None  # Pune dropped
    assert out[0]["url"] == "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Plano-TX/Sr-Data-Engineer_R100"


def test_icims_location_and_title():
    j = asyncio.run(_fetch("iCIMS", "https://careers-acme.icims.com"))[0]
    assert j["title"] == "RN" and j["loc"].startswith("US-TX-Houston")


def test_unsupported():
    with pytest.raises(adapters.Unsupported):
        asyncio.run(_fetch("Dayforce", "https://jobs.dayforcehcm.com/en-US/x/CANDIDATEPORTAL"))
    with pytest.raises(adapters.Unsupported):
        asyncio.run(_fetch("ADP", "https://myjobs.adp.com/x/cx"))


def test_norm_date():
    t = date(2026, 10, 5)
    assert norm_date(1790000000000, t) == "2026-09-21"
    assert norm_date("-3d", t) == "2026-10-02"
    assert norm_date("2026-09-29T00:00:00", t) == "2026-09-29"
    assert norm_date("9/5/2026", t) == "2026-09-05"
    assert norm_date(None, t) is None


def test_detail_fields_flow_through_normalize():
    from scraper.run import normalize
    board = {"id": 1, "company": "Acme", "ats": "Greenhouse", "us_share_pct": ""}
    raw = {"key": "gh:acme:1", "title": "Engineer", "loc": "Austin, TX", "url": "https://x/1",
           "posted": "2026-10-01", "desc": "<p>Build .NET services.</p>", "pay": "$120,000 – $150,000"}
    job = normalize(board, raw)
    assert job["x"] == "<p>Build .NET services.</p>"
    assert job["p"] == "$120,000 – $150,000"
    bare = normalize(board, {**raw, "desc": None, "pay": None})
    assert "x" not in bare and "p" not in bare


def test_money_range_and_html_unescape():
    from scraper.adapters import _html, _money_range
    assert _money_range(120000, 150000, "USD", "year") == "$120,000 – $150,000 / year"
    assert _money_range(None, None, "USD") is None
    assert _html("&lt;p&gt;hi&lt;/p&gt;") == "<p>hi</p>"
    assert _html("<p>already</p>") == "<p>already</p>"


def test_rippling_detail_joins_company_and_role():
    import asyncio
    from scraper.adapters import rippling_detail

    class FakeClient:
        async def get_json(self, url, **kw):
            assert url.endswith("/board/10fitness/jobs/abc")
            return {"description": {"company": "<p>Mission</p>", "role": "<p>Do things</p>"}}

    raw = {"_rip": ("rip", "10fitness", "abc")}
    assert asyncio.run(rippling_detail(FakeClient(), raw)) == "<p>Mission</p><p>Do things</p>"
