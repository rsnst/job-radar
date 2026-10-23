// Reads a resume's text into profile fields. Pure and local: no network, no AI.
// It only reports what the text actually says. Anything it can't find stays blank, and
// mergeImported() never overwrites a value the user already entered.

const SECTION = {
  summary: /^(professional\s+)?(summary|profile|objective|about( me)?)$/i,
  experience: /^((professional|work|relevant)\s+)?(experience|employment( history)?|work history)$/i,
  education: /^(education( and training)?|academic( background)?)$/i,
  skills: /^((technical|key|core)\s+)?(skills|competencies|technologies)(\s+(and|&)\s+\w+)?$|^core competencies$/i,
  certifications: /^(certifications?|licenses?( (and|&) certifications?)?|certificates?)$/i,
  languages: /^languages$/i,
  other: /^(projects?|awards?|honors?|publications?|volunteer(ing)?|interests|references|activities|achievements)$/i,
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DATE = `(?:${MON}\\s+\\d{4}|\\d{1,2}\\/\\d{4}|\\d{4})`;
const RANGE = new RegExp(`(${DATE})\\s*(?:-|–|—|to)\\s*(${DATE}|present|current|now|today)`, "i");
const TITLE_WORDS = /\b(engineer|developer|analyst|manager|director|lead|architect|consultant|specialist|intern|administrator|designer|scientist|associate|officer|coordinator|assistant|programmer|technician|representative|supervisor|president|head|owner|founder|accountant|nurse|teacher|recruiter|writer|editor|advisor|planner|buyer|clerk|cashier|driver)\b/i;
const SCHOOL_WORDS = /\b(university|college|institute|school|academy|polytechnic)\b/i;
const DEGREE = /\b(bachelor(?:'s)?(?: of [a-z]+)?|master(?:'s)?(?: of [a-z]+)?|b\.?\s?(?:s|a|tech|e)\.?|m\.?\s?(?:s|a|tech|e)\.?|mba|ph\.?\s?d\.?|doctorate|associate(?:'s)?(?: of [a-z]+)?|diploma|certificate)\b/i;

const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const bullet = /^[\s•●▪◦‣⁃*\-–—·▪●○►➤]+/;

function toMonth(token) {
  const t = String(token || "").trim().toLowerCase();
  if (/^(present|current|now|today)$/.test(t)) return "";
  let m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${String(m[1]).padStart(2, "0")}`;
  m = t.match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 4) === "sept" ? "sept" : m[1].slice(0, 3)]) return `${m[2]}-${String(MONTHS[m[1].slice(0, 4) === "sept" ? "sept" : m[1].slice(0, 3)]).padStart(2, "0")}`;
  m = t.match(/^(\d{4})$/);
  return m ? m[1] : "";
}

function sectionOf(line) {
  const t = line.replace(/[:：]\s*$/, "").replace(/^[#*_\s]+|[#*_\s]+$/g, "").trim();
  if (!t || t.length > 40) return null;
  for (const [k, re] of Object.entries(SECTION)) if (re.test(t)) return k;
  return null;
}

export function splitSections(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = { head: [] };
  let cur = "head";
  for (const raw of lines) {
    const line = raw.trim();
    const sec = sectionOf(line);
    if (sec) { cur = sec; out[cur] = out[cur] || []; continue; }
    (out[cur] = out[cur] || []).push(line);
  }
  return out;
}

function contact(text, headLines) {
  const out = { contact: {}, links: {}, address: {} };
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) out.contact.email = email[0].slice(0, 160);
  const phone = text.match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  if (phone) out.contact.phone = phone[0].trim();
  const li = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i);
  if (li) out.links.linkedin = (/^https?:/i.test(li[0]) ? li[0] : "https://" + li[0]).slice(0, 200);
  const gh = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9\-_]+\/?(?![A-Za-z0-9\-_/])/i);
  if (gh) out.links.github = (/^https?:/i.test(gh[0]) ? gh[0] : "https://" + gh[0]).slice(0, 200);
  const other = [...text.matchAll(/https?:\/\/[^\s)>,]+/gi)].map((m) => m[0])
    .find((u) => !/linkedin\.com|github\.com/i.test(u));
  if (other) out.links.portfolio = other.slice(0, 200);
  const top = headLines.slice(0, 12);
  for (const l of top) {
    const m = l.match(/\b([A-Z][A-Za-z.'\- ]{1,30}),\s*([A-Z]{2})\b(?:\s+(\d{5}))?/);
    if (m && !/@/.test(l.slice(0, m.index))) {
      out.address.city = m[1].trim().split(/\s{2,}|[|•·]/).pop().trim();
      out.address.state = m[2];
      if (m[3]) out.address.zip = m[3];
      break;
    }
  }
  const name = top.slice(0, 5).find((l) => {
    const w = l.split(/\s+/);
    return w.length >= 2 && w.length <= 4 && /^[\p{L}][\p{L}.'\- ]+$/u.test(l) && !sectionOf(l) && !/\d|@/.test(l)
      && w.every((x) => /^[\p{Lu}]/u.test(x) || /^(de|van|von|bin|al|jr\.?|sr\.?|ii|iii)$/i.test(x));
  });
  if (name) out.contact.fullName = clean(name, 120);
  return out;
}

const listFrom = (lines, max, len) => {
  const seen = new Set(), out = [];
  for (const l of lines) {
    const body = l.replace(bullet, "").replace(/^[A-Za-z /&+]{2,30}:\s+(?=.)/, "");
    for (const part of body.split(/[,;|•·•]|\s{3,}/)) {
      const t = clean(part.replace(bullet, "").replace(/^[A-Za-z /&+]{2,30}:\s+(?=.)/, ""), len);
      if (t.length >= 2 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
      if (out.length >= max) return out;
    }
  }
  return out;
};

function parseEducation(lines) {
  const entries = [];
  let cur = null;
  const push = () => { if (cur && (cur.school || cur.degree)) entries.push(cur); cur = null; };
  for (const raw of lines) {
    const l = raw.replace(bullet, "").trim();
    if (!l) { push(); continue; }
    const segs = l.split(/\s[|–—-]\s|\s{2,}|,\s+/).map((x) => x.trim()).filter(Boolean);
    const schoolSeg = segs.find((x) => SCHOOL_WORDS.test(x));
    const degreeSeg = segs.find((x) => DEGREE.test(x) && !SCHOOL_WORDS.test(x));
    const year = (l.match(/\b(?:19|20)\d{2}\b/g) || []).pop();
    const gpa = (l.match(/GPA[:\s]*([0-4]\.\d{1,2})/i) || [])[1];
    if (schoolSeg && cur?.school) push();
    if (degreeSeg && cur?.degree) push();
    if (!cur) cur = {};
    if (schoolSeg) cur.school = clean(schoolSeg.replace(/\(?\b(?:19|20)\d{2}\b\)?/g, ""), 120);
    if (degreeSeg) {
      const seg = degreeSeg.replace(/\(?\b(?:19|20)\d{2}\b\)?/g, "").replace(/GPA.*$/i, "").trim();
      const inSplit = seg.split(/\s+in\s+/i);
      if (inSplit.length > 1) { cur.degree = clean(inSplit[0], 120); cur.field = clean(inSplit.slice(1).join(" in "), 120); }
      else {
        const ab = seg.match(/^(b\.?\s?[sa]\.?|m\.?\s?[sa]\.?|ph\.?\s?d\.?)\s+(.+)$/i);
        if (ab) { cur.degree = clean(ab[1], 120); cur.field = clean(ab[2], 120); } else cur.degree = clean(seg, 120);
      }
    }
    if (year && !cur.year) cur.year = year;
    if (gpa && !cur.gpa) cur.gpa = gpa;
  }
  push();
  return entries.slice(0, 10).map((e) => ({ school: e.school || "", degree: e.degree || "", field: e.field || "", gpa: e.gpa || "", year: e.year || "" }));
}

function parseExperience(lines) {
  const entries = [];
  let cur = null, prev = "";
  const flush = () => { if (cur && (cur.company || cur.title)) entries.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(RANGE);
    if (m && !bullet.test(line.slice(0, 2))) {
      flush();
      const head = line.replace(RANGE, " ").replace(/\(\s*\)/g, " ");
      const parts = head.split(/\s+(?:at|@)\s+|\s+[|•·–—]\s+|\s+-\s+|,\s+(?=[A-Z])|\t+|\s{3,}/).map((p) => clean(p.replace(/[,|:()]+$/g, ""), 120)).filter(Boolean);
      if (prev && parts.length < 2) parts.push(clean(prev, 120));
      let title = parts.find((p) => TITLE_WORDS.test(p)) || "";
      let company = parts.find((p) => p !== title && !/^[A-Z]{2}$/.test(p) && !/^[A-Za-z .]+,\s*[A-Z]{2}$/.test(p)) || "";
      if (!title && parts[1]) { title = parts[1]; company = parts[0]; }
      cur = { company, title, start: toMonth(m[1]), end: toMonth(m[2]), current: /present|current|now|today/i.test(m[2]), summary: "" };
    } else if (cur) {
      const t = line.replace(bullet, "").trim();
      if (t) cur.summary += (cur.summary ? "\n" : "") + t;
      if (cur.summary.length > 1500) cur.summary = cur.summary.slice(0, 1500);
    }
    if (line && !bullet.test(line.slice(0, 2)) && !m) prev = line;
  }
  flush();
  return entries.slice(0, 15);
}

// parseResume(text) -> { data: partial profile, found: [what was filled in] }
export function parseResume(text) {
  const src = String(text || "").replace(/\r/g, "");
  const sec = splitSections(src);
  const data = contact(src, sec.head || []);
  for (const k of ["contact", "links", "address"]) if (!Object.keys(data[k]).length) delete data[k];
  const summary = (sec.summary || []).join(" ");
  if (summary.trim()) data.summary = clean(summary, 1500);
  const exp = parseExperience(sec.experience || []);
  if (exp.length) data.experience = exp;
  const edu = parseEducation(sec.education || []);
  if (edu.length) data.education = edu;
  const skills = listFrom(sec.skills || [], 60, 60);
  if (skills.length) data.skills = skills;
  const certs = (sec.certifications || []).map((l) => clean(l.replace(bullet, ""), 120)).filter((l) => l.length > 2).slice(0, 20);
  if (certs.length) data.certifications = certs;
  const langs = listFrom(sec.languages || [], 10, 40);
  if (langs.length) data.languages = langs;
  return { data, found: describe(data) };
}

function describe(d) {
  const out = [];
  const c = d.contact || {};
  if (c.fullName) out.push("name"); if (c.email) out.push("email"); if (c.phone) out.push("phone");
  if (d.address?.city) out.push("city and state");
  for (const k of ["linkedin", "github", "portfolio"]) if (d.links?.[k]) out.push(k);
  if (d.summary) out.push("summary");
  if (d.experience?.length) out.push(`${d.experience.length} job${d.experience.length === 1 ? "" : "s"}`);
  if (d.education?.length) out.push(`${d.education.length} education entr${d.education.length === 1 ? "y" : "ies"}`);
  if (d.skills?.length) out.push(`${d.skills.length} skills`);
  if (d.certifications?.length) out.push(`${d.certifications.length} certification${d.certifications.length === 1 ? "" : "s"}`);
  if (d.languages?.length) out.push("languages");
  return out;
}

const blank = (v) => v === undefined || v === null || String(v).trim() === "";

// Fills only what's blank. Existing text fields are never replaced; lists gain new items;
// jobs and education are imported only when the profile has none, so nothing is duplicated.
export function mergeImported(current, parsed) {
  const out = structuredClone(current || {});
  const filled = [];
  for (const group of ["contact", "links", "address"]) {
    for (const [k, v] of Object.entries(parsed[group] || {})) {
      out[group] = out[group] || {};
      if (blank(out[group][k]) && !blank(v)) { out[group][k] = v; filled.push(`${group}.${k}`); }
    }
  }
  if (blank(out.summary) && !blank(parsed.summary)) { out.summary = parsed.summary; filled.push("summary"); }
  for (const k of ["skills", "certifications", "languages"]) {
    const have = Array.isArray(out[k]) ? out[k].map((s) => String(s).trim()).filter(Boolean) : [];
    const lower = new Set(have.map((s) => s.toLowerCase()));
    const add = (parsed[k] || []).filter((s) => !lower.has(s.toLowerCase()));
    if (add.length) { out[k] = [...have, ...add]; filled.push(k); }
  }
  for (const k of ["experience", "education"]) {
    if ((!out[k] || !out[k].length) && parsed[k]?.length) { out[k] = parsed[k]; filled.push(k); }
  }
  return { profile: out, filled };
}
