// Auto-apply criteria: which saved jobs go into the preparation queue. Pure functions, no network.
// Matching only PREPARES a packet. Account creation and hands-free submission are separate, off-by-default opt-ins.

export const DEFAULT_AUTOAPPLY = {
  enabled: false,
  createAccounts: false,   // opt in to the worker creating employer accounts (alias address, encrypted password)
  autoSubmit: false,       // opt in to the worker submitting after all required fields are verified
  keywords: [],          // a job title must contain at least one of these (case-insensitive). Empty = any title.
  excludeKeywords: [],   // a job title containing any of these is skipped.
  companies: [],         // if set, the company must match one of these. Empty = any company.
  excludeCompanies: [],
  locations: [],         // if set, the job's location must mention one of these (or be remote when remoteOk). Empty = any.
  remoteOk: true,
  minSalary: 0,          // yearly USD. 0 = no floor. Jobs with no listed pay are kept, and marked as such.
};

const list = (v, max = 30, len = 80) =>
  (Array.isArray(v) ? v : String(v || "").split(","))
    .map((x) => String(x || "").trim().slice(0, len)).filter(Boolean).slice(0, max);

export function cleanAutoApply(input = {}) {
  const d = input && typeof input === "object" ? input : {};
  const min = Math.max(0, Math.min(1000000, Math.round(Number(d.minSalary) || 0)));
  return {
    enabled: d.enabled === true,
    createAccounts: d.createAccounts === true,
    autoSubmit: d.autoSubmit === true,
    keywords: list(d.keywords), excludeKeywords: list(d.excludeKeywords),
    companies: list(d.companies), excludeCompanies: list(d.excludeCompanies),
    locations: list(d.locations), remoteOk: d.remoteOk !== false, minSalary: min,
  };
}

// The first salary figure in a pay string, as a yearly USD amount. "$90k – $120k / year" -> 90000.
// Hourly rates are multiplied by 2080. Returns null when nothing usable is listed.
export function yearlyFromPay(pay) {
  const s = String(pay || "");
  const m = s.match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (m[2]) n *= 1000;
  if (/hour|\/\s*hr|per hour/i.test(s)) n *= 2080;
  return n >= 1000 ? Math.round(n) : null;
}

// Returns { match: boolean, reasons: string[] }. The reasons are shown to the user, so every skip is explained.
export function matchJob(job = {}, settings = DEFAULT_AUTOAPPLY) {
  const s = cleanAutoApply(settings);
  const reasons = [];
  const title = String(job.title || "").toLowerCase();
  const company = String(job.company || "").toLowerCase();
  const loc = String(job.loc || "").toLowerCase();
  if (!s.enabled) return { match: false, reasons: ["Auto-apply criteria are off."] };
  if (s.keywords.length && !s.keywords.some((k) => title.includes(k.toLowerCase()))) reasons.push("Title doesn't match your keywords.");
  if (s.excludeKeywords.some((k) => title.includes(k.toLowerCase()))) reasons.push("Title contains an excluded word.");
  if (s.companies.length && !s.companies.some((c) => company.includes(c.toLowerCase()))) reasons.push("Company isn't on your include list.");
  if (s.excludeCompanies.some((c) => company.includes(c.toLowerCase()))) reasons.push("Company is on your exclude list.");
  if (s.locations.length) {
    const ok = s.locations.some((l) => loc.includes(l.toLowerCase())) || (s.remoteOk && job.remote === true);
    if (!ok) reasons.push("Location doesn't match.");
  }
  if (s.minSalary) {
    const y = yearlyFromPay(job.pay);
    if (y !== null && y < s.minSalary) reasons.push("Listed pay is below your minimum.");
  }
  return { match: reasons.length === 0, reasons };
}
