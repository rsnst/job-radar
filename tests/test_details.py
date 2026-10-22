import asyncio

from scraper.details import describe


class FakeClient:
    def __init__(self, json_map=None, text_map=None):
        self.json_map = json_map or {}
        self.text_map = text_map or {}
        self.calls = []

    async def get_json(self, url, **kw):
        self.calls.append(url)
        return self.json_map[url]

    async def get_text(self, url, **kw):
        self.calls.append(url)
        return self.text_map[url]


def run(c, url, cache=None):
    return asyncio.run(describe(c, url, cache if cache is not None else {}))


def test_rippling_joins_company_and_role():
    api = "https://api.rippling.com/platform/api/ats/v1/board/10fitness/jobs/abc"
    c = FakeClient({api: {"description": {"company": "<p>Us</p>", "role": "<p>Role</p>"}}})
    assert run(c, "https://ats.rippling.com/10fitness/jobs/abc") == "<p>Us</p><p>Role</p>"


def test_workday_strips_locale_and_uses_tenant():
    api = "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Austin/Engineer_R1"
    c = FakeClient({api: {"jobPostingInfo": {"jobDescription": "<p>Build</p>"}}})
    url = "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin/Engineer_R1"
    assert run(c, url) == "<p>Build</p>"


def test_smartrecruiters_prefers_sections_then_falls_back():
    api = "https://api.smartrecruiters.com/v1/companies/acme/postings/123"
    c = FakeClient({api: {"jobAd": {"sections": {"jobDescription": {"text": "<p>Job</p>"},
                                                  "qualifications": {"text": "<ul>Q</ul>"}}}}})
    assert run(c, "https://jobs.smartrecruiters.com/acme/123") == "<p>Job</p><ul>Q</ul>"


def test_pinpoint_fetches_list_once_per_board():
    lst = "https://acme.pinpointhq.com/postings.json"
    c = FakeClient({lst: {"data": [{"url": "https://acme.pinpointhq.com/en/postings/u1",
                                    "description": "<p>D</p>", "benefits": "<p>B</p>"}]}})
    cache = {}
    assert run(c, "https://acme.pinpointhq.com/en/postings/u1", cache) == "<p>D</p><p>B</p>"
    assert run(c, "https://acme.pinpointhq.com/en/postings/u1", cache) == "<p>D</p><p>B</p>"
    assert c.calls.count(lst) == 1


def test_jobvite_reads_jobposting_json_ld():
    page = ('<html><script type="application/ld+json">{"@type":"JobPosting","description":"<p>Hi</p>"}'
            '</script></html>')
    c = FakeClient(text_map={"https://jobs.jobvite.com/acme/job/1": page})
    assert run(c, "https://jobs.jobvite.com/acme/job/1") == "<p>Hi</p>"


def test_jobposting_inside_graph_and_list():
    page = ('<script type="application/ld+json">{"@graph":[{"@type":["WebPage"]},'
            '{"@type":["JobPosting"],"description":"<p>G</p>"}]}</script>')
    c = FakeClient(text_map={"https://recruiting.paylocity.com/Recruiting/Jobs/Details/9": page})
    assert run(c, "https://recruiting.paylocity.com/Recruiting/Jobs/Details/9") == "<p>G</p>"


def test_oracle_joins_three_fields():
    api_prefix = "https://ehgo.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
    url = "https://ehgo.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/77"
    c = FakeClient()
    c.json_map = {}
    # match whatever query string is built: accept any call and return fixed data
    class O(FakeClient):
        async def get_json(self, u, **kw):
            assert u.startswith(api_prefix) and "77" in u and "CX_1" in u
            return {"items": [{"ExternalDescriptionStr": "<p>D</p>", "ExternalQualificationsStr": "<p>Q</p>",
                               "ExternalResponsibilitiesStr": ""}]}
    assert run(O(), url) == "<p>D</p><p>Q</p>"


def test_unknown_host_and_http_are_skipped_without_calls():
    c = FakeClient()
    assert run(c, "https://boards.greenhouse.io/acme/jobs/1") == ""
    assert run(c, "http://ats.rippling.com/a/b/c") == ""
    assert c.calls == []
