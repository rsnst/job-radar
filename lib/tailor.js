// Pure helpers for tailored application materials. No network, no DOM, so they can be tested with node:test.

export const SYSTEM_PROMPT = `You write job application materials for a candidate.
Use ONLY facts found in the CANDIDATE SOURCE (profile and resume). Never invent employers, titles, dates,
numbers, certifications, degrees, tools, or achievements. You may reword and reorder what is there, and
emphasise the parts that match the job posting. If the posting asks for something the source does not show,
do not claim it; list it under "missing" instead.
Reply with JSON only:
{"resume": "<full tailored resume as plain text, sections separated by blank lines>",
 "cover_letter": "<a cover letter of at most 250 words, plain text, no placeholders>",
 "missing": ["<a fact the posting asks for that the candidate source does not contain>", ...],
 "notes": ["<one short note on a change you made, e.g. 'Moved the Azure work to the top'>", ...]}
Keep "missing" to at most 8 items and "notes" to at most 6.`;

export function buildUserMessage({ source, job }) {
  return `CANDIDATE SOURCE:\n${source}\n\nJOB POSTING (${job.title} at ${job.company}):\n${job.text}`;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");

// Ordinary words that are often capitalised at the start of a sentence or heading. Not flagged.
const COMMON = new Set(("Used Built Led Managed Developed Designed Created Improved Implemented Delivered Supported " +
  "Worked Working Using Experience Experienced Skills Summary Education Work Key Professional Senior Junior " +
  "Engineer Engineering Manager Resume Cover Letter Dear Hiring Role Responsibilities Projects Project Team Teams " +
  "Lead Leads Reduced Increased Worked Partnered Collaborated Maintained Owned Launched Migrated Automated " +
  "The And For With From Into Over Under About Thank Sincerely Regards Best Hello Hi Our Your Their " +
  "This That These Those Also While During Across Through Serving Served Designed Architected Mentored").split(" "));

// Numbers and capitalised terms in the output must come from the source or the posting.
// Anything else is returned as a flag for the user to check. A flag is not proof of an error.
export function verifyAgainst({ source, job, output }) {
  const hay = norm(`${source}\n${job.text}`);
  const flags = [];
  const seen = new Set();
  const numbers = String(output || "").match(/\b\d[\d,.%]*\b/g) || [];
  for (const n of numbers) {
    const key = n.replace(/[,]$/, "").replace(/\.$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!hay.includes(key.toLowerCase())) flags.push({ kind: "number", text: key, message: `The number "${key}" isn't in your profile or resume.` });
  }
  const words = String(output || "").match(/\b[A-Z][A-Za-z0-9+#.]{2,}\b/g) || [];
  for (const w of words) {
    const key = w.replace(/\.$/, "");
    if (seen.has(key) || COMMON.has(key)) continue;
    seen.add(key);
    if (!hay.includes(key.toLowerCase())) flags.push({ kind: "term", text: key, message: `"${key}" isn't in your profile, resume or the posting. Check it.` });
  }
  return flags;
}

// Line diff using a longest-common-subsequence over lines. Good enough for resumes (a few hundred lines).
export function lineDiff(before, after) {
  const a = String(before || "").split("\n");
  const b = String(after || "").split("\n");
  if (a.length * b.length > 250000) return [{ type: "replace", before: a.join("\n"), after: b.join("\n") }];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
    else { out.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

// Map the model's JSON into a clean object. Anything malformed becomes an empty field, never a guess.
export function parseMaterials(raw) {
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== "object") return null;
  const list = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, n) : []);
  const resume = typeof d.resume === "string" ? d.resume.trim().slice(0, 20000) : "";
  const cover = typeof d.cover_letter === "string" ? d.cover_letter.trim().slice(0, 6000) : "";
  if (!resume) return null;
  return { resume, cover, missing: list(d.missing, 8), notes: list(d.notes, 6) };
}

// Fields that must be known before an application can be submitted. A gap is reported, never filled in.
export function profileGaps(details, resumeText) {
  const d = details || {};
  const gaps = [];
  if (!d.contact?.fullName) gaps.push("Full legal name");
  if (!d.contact?.email) gaps.push("Email");
  if (!d.contact?.phone) gaps.push("Phone");
  if (!d.work?.authorizedUS) gaps.push("Work authorization in the US");
  if (!d.work?.needsSponsorship) gaps.push("Whether you need visa sponsorship");
  if (!resumeText) gaps.push("A resume (upload or paste it in My profile)");
  return gaps;
}


// The part of the profile a resume or cover letter may use.
export function minimalProfile(d = {}) {
  const out = {};
  if (d.contact) out.contact = { fullName: d.contact.fullName, email: d.contact.email, phone: d.contact.phone, pronouns: d.contact.pronouns };
  if (d.address) out.location = { city: d.address.city, state: d.address.state, country: d.address.country };
  if (d.links) out.links = d.links;
  if (d.work) out.work = d.work;
  if (d.experience) out.experience = d.experience;
  if (d.education) out.education = d.education;
  if (d.skills) out.skills = d.skills;
  if (d.certifications) out.certifications = d.certifications;
  if (d.languages) out.languages = d.languages;
  if (d.custom) out.answers = d.custom;
  if (d.summary) out.summary = d.summary;
  return out;
}
