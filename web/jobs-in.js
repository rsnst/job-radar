// Jobs that arrive from outside the index: the browser extension, the phone's share sheet, or a pasted link.
// Pure and strict: only plain https links to public hosts are accepted, tracking junk is stripped, and nothing
// here fetches or submits anything.

const TRACKING = /^(utm_.*|trk|trackingid|refid|ref|referrer|fbclid|gclid|mc_cid|mc_eid|lever-source|lever-origin|gh_src|source|src|vjs|from|tk|ad|cmp)$/i;
const SITES = [
  [/(^|\.)linkedin\.com$/i, "LinkedIn"], [/(^|\.)indeed\.com$/i, "Indeed"], [/(^|\.)glassdoor\.com$/i, "Glassdoor"],
  [/(^|\.)myworkdayjobs\.com$/i, "Workday"], [/(^|\.)greenhouse\.io$/i, "Greenhouse"], [/(^|\.)lever\.co$/i, "Lever"],
  [/(^|\.)ashbyhq\.com$/i, "Ashby"], [/(^|\.)icims\.com$/i, "iCIMS"], [/(^|\.)smartrecruiters\.com$/i, "SmartRecruiters"],
  [/(^|\.)bamboohr\.com$/i, "BambooHR"], [/(^|\.)paylocity\.com$/i, "Paylocity"], [/(^|\.)ultipro\.com$/i, "UltiPro / UKG"],
  [/(^|\.)oraclecloud\.com$/i, "Oracle Recruiting"], [/(^|\.)adp\.com$/i, "ADP"], [/(^|\.)ziprecruiter\.com$/i, "ZipRecruiter"],
  [/(^|\.)workable\.com$/i, "Workable"], [/(^|\.)jobvite\.com$/i, "Jobvite"],
];
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

export function atsFromHost(host) {
  const h = String(host || "").toLowerCase();
  return (SITES.find(([re]) => re.test(h)) || [null, h.replace(/^www\./, "")])[1];
}

function publicHost(h) {
  if (!h || !h.includes(".")) return false;
  if (/^(localhost|.*\.local|.*\.internal|.*\.test|.*\.invalid)$/i.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  if (h.startsWith("[")) return false;
  return true;
}

// One stable link per posting, so adding the same job twice finds the first one.
export function canonicalJobUrl(input) {
  let u;
  try { u = new URL(String(input || "").trim()); } catch { return ""; }
  if (u.protocol !== "https:" || u.username || u.password || !publicHost(u.hostname)) return "";
  const host = u.hostname.toLowerCase();
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const id = (u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/) || [])[1] || u.searchParams.get("currentJobId");
    if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
  }
  if (/(^|\.)indeed\.com$/.test(host)) {
    const jk = u.searchParams.get("jk") || u.searchParams.get("vjk");
    if (jk && /^[a-z0-9]{8,32}$/i.test(jk)) return `https://${host}/viewjob?jk=${jk}`;
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = "";
  const out = u.toString();
  return out.length <= 2000 ? out : "";
}

// -> { ok: true, job } or { ok: false, error }. The job has the same shape the tracker stores.
export function cleanIncoming(raw = {}) {
  const url = canonicalJobUrl(raw.url);
  if (!url) return { ok: false, error: "That isn't a usable job link. It has to be a public https address." };
  const host = new URL(url).hostname;
  const ats = atsFromHost(host);
  const job = {
    title: str(raw.title, 200) || "Untitled role",
    company: str(raw.company, 200),
    url, loc: str(raw.loc, 200), ats: str(ats, 40), posted: null, remote: false, pay: "",
  };
  return { ok: true, job, source: str(raw.source, 40) || ats };
}

// ---- #add=<base64url JSON> (extension) and the Web Share Target query (phone share sheet)
const b64 = {
  enc: (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
};

export function encodeAdd(job) {
  return b64.enc(JSON.stringify({ u: job.url, t: job.title, c: job.company, l: job.loc, s: job.source }));
}

export function decodeAdd(hash) {
  const m = String(hash || "").match(/(?:^#|&)add=([A-Za-z0-9_-]+)/);
  if (!m || m[1].length > 6000) return null;
  try {
    const o = JSON.parse(b64.dec(m[1]));
    return { url: o.u, title: o.t, company: o.c, loc: o.l, source: o.s };
  } catch { return null; }
}

const URL_IN_TEXT = /https:\/\/[^\s<>"']+/i;
export function fromShare(search) {
  const p = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const text = p.get("text") || "";
  const url = p.get("url") || (text.match(URL_IN_TEXT) || [])[0] || "";
  if (!url) return null;
  const title = (p.get("title") || text.replace(URL_IN_TEXT, "")).trim();
  return { url, title, company: "", source: "Shared" };
}

export function incomingFromLocation(loc) {
  return decodeAdd(loc.hash) || fromShare(loc.search);
}
