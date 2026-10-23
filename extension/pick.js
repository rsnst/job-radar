// Turns what the popup read from the open page into a job. Pure: it never touches the network.
// It uses the page's own JobPosting data when there is any, then falls back to the page title.

const SITE_SUFFIX = /\s*[|\-–—]\s*(linkedin|indeed(?:\.com)?|glassdoor|ziprecruiter|greenhouse|lever|workday|ashby|jobs?)\b.*$/i;
const str = (v, n) => (typeof v === "string" ? v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");

function* walk(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  if (node && typeof node === "object") { yield node; if (node["@graph"]) yield* walk(node["@graph"]); }
}

function place(loc) {
  const l = Array.isArray(loc) ? loc[0] : loc;
  const a = l?.address;
  if (!a) return typeof l?.name === "string" ? str(l.name, 120) : "";
  return [a.addressLocality, a.addressRegion].map((x) => str(typeof x === "string" ? x : x?.name, 60)).filter(Boolean).join(", ");
}

export function pickJob(snap = {}) {
  let found = null;
  for (const text of snap.jsonld || []) {
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    for (const n of walk(data)) {
      const t = [].concat(n["@type"] || []);
      if (t.includes("JobPosting")) { found = n; break; }
    }
    if (found) break;
  }
  if (found) {
    const org = found.hiringOrganization;
    return {
      url: snap.url, title: str(found.title, 200), company: str(typeof org === "string" ? org : org?.name, 200),
      loc: place(found.jobLocation), source: "page data",
    };
  }
  const raw = str(snap.h1, 200) || str(snap.ogTitle, 200) || str(snap.title, 200);
  return { url: snap.url, title: raw.replace(SITE_SUFFIX, "").trim() || raw, company: str(snap.siteName, 100) && !/linkedin|indeed|glassdoor/i.test(snap.siteName) ? str(snap.siteName, 100) : "", loc: "", source: "page title" };
}

// Same encoding the app reads from "#add=": base64url of {u,t,c,l,s}.
export function addLink(appUrl, job) {
  const json = JSON.stringify({ u: job.url, t: job.title, c: job.company, l: job.loc, s: job.source });
  const b = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${String(appUrl).replace(/\/+$/, "")}/#add=${b}`;
}

export function validAppUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch { return false; }
}
