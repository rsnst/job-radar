import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJobUrl, cleanIncoming, decodeAdd, encodeAdd, fromShare, incomingFromLocation, atsFromHost } from "../web/jobs-in.js";
import { pickJob, addLink, validAppUrl } from "../extension/pick.js";

test("links: https only, public hosts only, no credentials", () => {
  for (const bad of ["http://example.com/job/1", "javascript:alert(1)", "https://localhost/x", "https://127.0.0.1/x", "https://192.168.1.5/x",
    "https://user:pw@example.com/job", "https://intranet/x", "not a url", ""]) assert.equal(canonicalJobUrl(bad), "", bad);
  assert.match(canonicalJobUrl("https://boards.greenhouse.io/acme/jobs/123?gh_src=abc&utm_source=x&gh_jid=123#apply"), /^https:\/\/boards\.greenhouse\.io\/acme\/jobs\/123\?gh_jid=123$/);
});

test("LinkedIn and Indeed collapse to one stable link per posting", () => {
  const a = canonicalJobUrl("https://www.linkedin.com/jobs/view/senior-data-engineer-at-acme-3912345678/?trackingId=zz&refId=1");
  const b = canonicalJobUrl("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3912345678");
  assert.equal(a, "https://www.linkedin.com/jobs/view/3912345678/");
  assert.equal(a, b);
  assert.equal(canonicalJobUrl("https://www.indeed.com/viewjob?jk=abcdef0123456789&tk=1&from=serp"), "https://www.indeed.com/viewjob?jk=abcdef0123456789");
});

test("ATS label comes from the host", () => {
  assert.equal(atsFromHost("acme.wd5.myworkdayjobs.com"), "Workday");
  assert.equal(atsFromHost("jobs.lever.co"), "Lever");
  assert.equal(atsFromHost("careers.example.org"), "careers.example.org");
});

test("cleanIncoming builds the tracker's job shape and rejects bad links", () => {
  const r = cleanIncoming({ url: "https://jobs.lever.co/acme/abc-123?lever-source=x", title: "  Data   Engineer ", company: "Acme" });
  assert.deepEqual(r.job, { title: "Data Engineer", company: "Acme", url: "https://jobs.lever.co/acme/abc-123", loc: "", ats: "Lever", posted: null, remote: false, pay: "" });
  assert.equal(cleanIncoming({ url: "http://x.com/a", title: "t" }).ok, false);
  assert.equal(cleanIncoming({ url: "https://jobs.lever.co/a/b" }).job.title, "Untitled role");
});

test("extension link round-trips into the app, including non-ASCII", () => {
  const job = { url: "https://jobs.lever.co/acme/abc", title: "Ingénieur données", company: "Café Ünï", loc: "Austin, TX", source: "page data" };
  const link = addLink("https://job-radar-tan.vercel.app/", job);
  assert.match(link, /^https:\/\/job-radar-tan\.vercel\.app\/#add=[A-Za-z0-9_-]+$/);
  const back = decodeAdd(new URL(link).hash);
  assert.deepEqual(back, { url: job.url, title: job.title, company: job.company, loc: job.loc, source: "page data" });
  assert.deepEqual(decodeAdd("#add=" + encodeAdd(job)), back);
  assert.equal(decodeAdd("#add=%%%"), null);
  assert.equal(decodeAdd("#q=nurse"), null);
});

test("phone share target: url param, or a link inside the shared text", () => {
  assert.equal(fromShare("?title=Data+Engineer&url=https%3A%2F%2Fjobs.lever.co%2Fa%2Fb").url, "https://jobs.lever.co/a/b");
  const s = fromShare("?text=" + encodeURIComponent("Check this out https://www.indeed.com/viewjob?jk=abcdef0123456789"));
  assert.equal(s.url, "https://www.indeed.com/viewjob?jk=abcdef0123456789");
  assert.equal(s.title, "Check this out");
  assert.equal(fromShare("?title=nothing"), null);
  assert.equal(incomingFromLocation({ hash: "", search: "?url=https%3A%2F%2Fa.com%2Fj" }).url, "https://a.com/j");
});

test("extension reads JobPosting data first, then falls back to the title", () => {
  const ld = JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite" }, { "@type": "JobPosting", title: "Data <b>Engineer</b>",
    hiringOrganization: { "@type": "Organization", name: "Acme Corp" }, jobLocation: { address: { addressLocality: "Austin", addressRegion: "TX" } } }] });
  const a = pickJob({ url: "https://x.com/j/1", jsonld: ["{bad json", ld], title: "ignored" });
  assert.deepEqual([a.title, a.company, a.loc, a.source], ["Data Engineer", "Acme Corp", "Austin, TX", "page data"]);
  const b = pickJob({ url: "https://x.com/j/2", title: "Senior Analyst - Acme | LinkedIn", jsonld: [] });
  assert.equal(b.title, "Senior Analyst - Acme");
  assert.equal(b.source, "page title");
});

test("extension only accepts an https app address (or localhost for development)", () => {
  assert.ok(validAppUrl("https://job-radar-tan.vercel.app"));
  assert.ok(validAppUrl("http://localhost:8767"));
  assert.ok(!validAppUrl("http://evil.example"));
  assert.ok(!validAppUrl("javascript:alert(1)"));
});
