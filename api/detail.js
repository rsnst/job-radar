// On-demand job descriptions for ATSs whose job list has no description.
//   GET /api/detail?url=<the job's apply URL>  ->  { html }   (html is "" when there is none)
// Only the hosts listed in ROUTES are accepted, so this can't be used as a general proxy.
// Results are cached at the CDN for a day.

const TIMEOUT_MS = 8000;

async function getJson(url) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "job-radar/1.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error", // an allowed host must not be able to bounce us elsewhere
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ats.rippling.com/{slug}/jobs/{uuid}
async function rippling(u) {
  const [slug, , uuid] = u.pathname.split("/").filter(Boolean);
  if (!slug || !uuid) return "";
  const d = await getJson(
    `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(uuid)}`);
  const desc = d.description || {};
  return [desc.company, desc.role].filter((x) => typeof x === "string" && x).join("");
}

// {tenant}.wdN.myworkdayjobs.com/[locale/]{site}{externalPath}
async function workday(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift();
  const [site, ...rest] = parts;
  if (!site || !rest.length) return "";
  const tenant = u.hostname.split(".")[0];
  const d = await getJson(`https://${u.hostname}/wday/cxs/${tenant}/${site}/${rest.join("/")}`);
  return (d.jobPostingInfo && d.jobPostingInfo.jobDescription) || "";
}


// jobs.smartrecruiters.com/{company}/{id}
async function smartrecruiters(u) {
  const [co, id] = u.pathname.split("/").filter(Boolean);
  if (!co || !id) return "";
  const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(co)}/postings/${encodeURIComponent(id)}`);
  const secs = (d.jobAd && d.jobAd.sections) || {};
  return ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
    .map((k) => secs[k] && secs[k].text).filter(Boolean).join("")
    || Object.values(secs).map((x) => x && x.text).filter(Boolean).join("");
}

// {sub}.bamboohr.com/careers/{id}
async function bamboohr(u) {
  const [, id] = u.pathname.split("/").filter(Boolean);
  if (!id) return "";
  const d = await getJson(`https://${u.hostname}/careers/${encodeURIComponent(id)}/detail`);
  return (d.result && d.result.jobOpening && d.result.jobOpening.description) || "";
}

// apply.workable.com/{sub}/j/{shortcode}/
async function workable(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  const sub = parts[0];
  const sc = parts[parts.indexOf("j") + 1];
  if (!sub || !sc) return "";
  const d = await getJson(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(sub)}/jobs/${encodeURIComponent(sc)}`);
  return [d.description, d.requirements, d.benefits].filter((x) => typeof x === "string" && x).join("");
}

// {sub}.pinpointhq.com/en/postings/{uuid}: the board's list already carries the text, so find this job in it
async function pinpoint(u) {
  const list = await getJson(`https://${u.hostname}/postings.json`);
  const j = (list.data || []).find((x) => x.url && new URL(x.url).pathname === u.pathname);
  if (!j) return "";
  return [j.description, j.key_responsibilities, j.skills_knowledge_expertise, j.benefits]
    .filter((x) => typeof x === "string" && x).join("");
}

// Many career pages include a schema.org JobPosting block in the HTML with the full description.
async function jobPostingFromPage(url) {
  const r = await fetch(url, {
    headers: { accept: "text/html", "user-agent": "job-radar/1.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error", // an allowed host must not be able to bounce us elsewhere
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of [].concat(data, data && data["@graph"] || [])) {
      const type = node && node["@type"];
      if ((Array.isArray(type) ? type : [type]).includes("JobPosting") && typeof node.description === "string") {
        return node.description;
      }
    }
  }
  return "";
}

// recruiting.paylocity.com/Recruiting/Jobs/Details/{id}
async function paylocity(u) {
  return jobPostingFromPage(u.href);
}

// {host}/hcmUI/CandidateExperience/en/sites/{site}/job/{id}
async function oracle(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  const site = parts[parts.indexOf("sites") + 1];
  const id = parts[parts.indexOf("job") + 1];
  if (!site || !id) return "";
  const d = await getJson(
    `https://${u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true` +
    `&finder=ById;Id="${encodeURIComponent(id)}",siteNumber=${encodeURIComponent(site)}`);
  const item = (d.items && d.items[0]) || {};
  return [item.ExternalDescriptionStr, item.ExternalQualificationsStr, item.ExternalResponsibilitiesStr]
    .filter((x) => typeof x === "string" && x).join("");
}

const ROUTES = [
  { match: (h) => h === "ats.rippling.com", fetch: rippling },
  { match: (h) => h.endsWith(".myworkdayjobs.com"), fetch: workday },
  { match: (h) => h === "jobs.smartrecruiters.com", fetch: smartrecruiters },
  { match: (h) => h.endsWith(".bamboohr.com"), fetch: bamboohr },
  { match: (h) => h === "apply.workable.com", fetch: workable },
  { match: (h) => h.endsWith(".pinpointhq.com"), fetch: pinpoint },
  { match: (h) => h === "recruiting.paylocity.com", fetch: paylocity },
  { match: (h) => h === "jobs.jobvite.com", fetch: jobPostingFromPage },
  { match: (h) => h.endsWith(".oraclecloud.com"), fetch: oracle },
];

// Best-effort per-IP limit: each serverless instance counts on its own, so it slows casual abuse
// rather than stopping a determined client. The CDN cache already absorbs repeat lookups.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map();

function overLimit(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "?";
  const now = Date.now();
  const t = (hits.get(ip) || []).filter((x) => now - x < WINDOW_MS);
  t.push(now);
  hits.set(ip, t);
  if (hits.size > 10_000) hits.clear(); // bound memory
  return t.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (overLimit(req)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  }
  let u;
  try {
    u = new URL(String(req.query?.url || ""));
  } catch {
    return res.status(400).json({ error: "bad url" });
  }
  if (u.protocol !== "https:") return res.status(400).json({ error: "bad url" });
  const route = ROUTES.find((r) => r.match(u.hostname));
  if (!route) return res.status(404).json({ error: "not supported" });
  try {
    const html = await route.fetch(u);
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({ html });
  } catch {
    return res.status(502).json({ error: "unavailable" });
  }
}
