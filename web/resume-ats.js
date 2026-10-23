// Makes a resume safe for applicant-tracking parsers, and reports what a parser would trip on.
// Pure text in, text out: the wording is never changed, only layout, symbols and heading names.

export const HEADINGS = [
  ["SUMMARY", /^(professional\s+)?(summary|profile|objective|about( me)?)$/i],
  ["WORK EXPERIENCE", /^((professional|work|relevant)\s+)?(experience|employment( history)?|work history)$/i],
  ["EDUCATION", /^(education( and training)?|academic( background)?)$/i],
  ["SKILLS", /^((technical|key|core)\s+)?(skills|competencies|technologies)(\s+(and|&)\s+\w+)?$/i],
  ["CERTIFICATIONS", /^(certifications?|licenses?( (and|&) certifications?)?|certificates?)$/i],
  ["PROJECTS", /^projects?$/i],
  ["LANGUAGES", /^languages$/i],
];

export function canonicalHeading(line) {
  const t = String(line || "").replace(/[:：]\s*$/, "").replace(/^[#*_\s]+|[#*_\s]+$/g, "").trim();
  if (!t || t.length > 40) return null;
  const hit = HEADINGS.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

const SYMBOLS = /[•●▪◦‣⁃○►➤✓✔★☆■□→➔]/g;
const INVISIBLE = new RegExp("[\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\ufeff\\u00ad]", "g");
const EMOJI = /[\p{Extended_Pictographic}\p{Private_Use}]/gu;

export function atsNormalize(text) {
  const lines = String(text || "").replace(/\r/g, "").replace(INVISIBLE, "").split("\n").map((raw) => {
    let l = raw.replace(/\t+/g, "   ")
      .replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'").replace(/[–—−]/g, "-").replace(/…/g, "...").replace(/ /g, " ")
      .replace(EMOJI, "");
    l = l.replace(/^\s*[•●▪◦‣⁃○►➤*·▪●○►➤]+\s*/, "- ");
    l = l.replace(SYMBOLS, "").replace(/\s{3,}/g, " | ").replace(/[ ]{2,}/g, " ").replace(/\s+$/, "");
    const h = canonicalHeading(l);
    return h || l;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

const DATE_RANGE = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\b(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:present|current|now|(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2})/i;

// A short list a person can act on. Each item: { ok, label, detail }.
export function atsCheck(text) {
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n");
  const head = lines.slice(0, 15).join("\n");
  const out = [];
  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(head);
  const hasPhone = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(head);
  out.push({ ok: hasEmail && hasPhone, label: "Contact details at the top",
    detail: hasEmail && hasPhone ? "Email and phone found." : `Add your ${[!hasEmail && "email", !hasPhone && "phone"].filter(Boolean).join(" and ")} near the top.` });
  const found = new Set(lines.map(canonicalHeading).filter(Boolean));
  const need = ["WORK EXPERIENCE", "EDUCATION", "SKILLS"].filter((h) => !found.has(h));
  out.push({ ok: !need.length, label: "Standard section headings",
    detail: need.length ? `Missing: ${need.map((h) => h.toLowerCase()).join(", ")}. Parsers look for these names.` : "Experience, education and skills headings found." });
  out.push({ ok: DATE_RANGE.test(raw), label: "Dates on each role",
    detail: DATE_RANGE.test(raw) ? "Date ranges found." : "No date ranges found. Add start and end dates like 'Mar 2021 - Present'." });
  const risky = (raw.match(SYMBOLS) || []).length + (raw.match(EMOJI) || []).length + (raw.match(/\t/g) || []).length + lines.filter((l) => /\S\s{3,}\S/.test(l)).length;
  out.push({ ok: risky === 0, label: "Plain layout",
    detail: risky ? `${risky} symbol${risky === 1 ? "" : "s"}, tab${risky === 1 ? "" : "s"} or column gap${risky === 1 ? "" : "s"} that parsers misread. The download replaces them.` : "No special symbols or column gaps." });
  const words = raw.split(/\s+/).filter(Boolean).length;
  out.push({ ok: words > 0 && words <= 1100, label: "Length",
    detail: words > 1100 ? `${words} words is over two pages. Trim older roles.` : `${words} words.` });
  return out;
}
