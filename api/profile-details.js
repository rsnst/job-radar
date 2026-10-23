// GET: the signed-in user's full profile.  PUT { data }: save it after cleaning every field.
// Only known fields are kept, each capped in length, so the stored JSON stays small and predictable.
import { currentUser, restHeaders } from "../lib/supa.js";
import { cleanAutoApply } from "../web/autoapply.js";

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const yn = (v) => (v === "yes" || v === "no" ? v : "");
const pick = (v, options) => (options.includes(v) ? v : "");

const EEO = {
  gender: ["female", "male", "non-binary", "decline"],
  ethnicity: ["hispanic", "asian", "black", "white", "native", "pacific", "two-or-more", "decline"],
  veteran: ["veteran", "not-veteran", "decline"],
  disability: ["yes", "no", "decline"],
};

export function cleanProfile(input) {
  const d = input && typeof input === "object" ? input : {};
  const c = d.contact || {}, l = d.links || {}, w = d.work || {}, a = d.address || {}, e = d.eeo || {};
  const arr = (v, n, fn) => (Array.isArray(v) ? v.slice(0, n).map(fn).filter(Boolean) : []);
  const eeo = {};
  for (const k of Object.keys(EEO)) eeo[k] = pick(e[k], EEO[k]);
  return {
    contact: {
      fullName: str(c.fullName, 120), preferredName: str(c.preferredName, 60), pronouns: str(c.pronouns, 40),
      email: str(c.email, 160), phone: str(c.phone, 40),
    },
    address: {
      street: str(a.street, 160), apt: str(a.apt, 40), city: str(a.city, 80), state: str(a.state, 60),
      zip: str(a.zip, 12), country: str(a.country, 60),
    },
    eeo,
    links: {
      linkedin: str(l.linkedin, 200), github: str(l.github, 200),
      portfolio: str(l.portfolio, 200), other: str(l.other, 200),
    },
    work: {
      authorizedUS: yn(w.authorizedUS), needsSponsorship: yn(w.needsSponsorship),
      willingToRelocate: yn(w.willingToRelocate),
      workType: pick(w.workType, ["remote", "hybrid", "onsite", "any"]),
      noticePeriod: str(w.noticePeriod, 60), startDate: str(w.startDate, 40),
      salaryMin: str(w.salaryMin, 20), salaryMax: str(w.salaryMax, 20),
      visaStatus: str(w.visaStatus, 80), clearance: str(w.clearance, 60),
      over18: yn(w.over18), backgroundCheck: yn(w.backgroundCheck), drugTest: yn(w.drugTest),
      formerEmployee: str(w.formerEmployee, 200), howHeard: str(w.howHeard, 120),
    },
    experience: arr(d.experience, 15, (e) => {
      const x = { company: str(e?.company, 120), title: str(e?.title, 120), start: str(e?.start, 20),
        end: str(e?.end, 20), current: e?.current === true, summary: str(e?.summary, 1500) };
      return x.company || x.title ? x : null;
    }),
    education: arr(d.education, 10, (e) => {
      const x = { school: str(e?.school, 120), degree: str(e?.degree, 120), field: str(e?.field, 120), gpa: str(e?.gpa, 10), year: str(e?.year, 10) };
      return x.school || x.degree ? x : null;
    }),
    skills: arr(d.skills, 60, (s) => str(s, 60)),
    certifications: arr(d.certifications, 20, (s) => str(s, 120)),
    languages: arr(d.languages, 10, (s) => str(s, 40)),
    references: arr(d.references, 3, (r) => {
      const x = { name: str(r?.name, 120), title: str(r?.title, 120), company: str(r?.company, 120),
        email: str(r?.email, 160), phone: str(r?.phone, 40) };
      return x.name ? x : null;
    }),
    custom: arr(d.custom, 25, (q) => {
      const x = { question: str(q?.question, 300), answer: str(q?.answer, 1500) };
      return x.question ? x : null;
    }),
    summary: str(d.summary, 1500),
    autoApply: cleanAutoApply(d.autoApply),
  };
}

export default async function handler(req, res) {
  const ctx = await currentUser(req);
  if (!ctx) return res.status(401).json({ error: "Sign in first." });
  const rest = `${ctx.url}/rest/v1/profile_details`;

  if (req.method === "GET") {
    const r = await fetch(`${rest}?select=data,updated_at&user_id=eq.${ctx.id}`, { headers: restHeaders(ctx) });
    if (!r.ok) return res.status(502).json({ error: "Couldn't load your profile." });
    const [row] = await r.json();
    return res.status(200).json({ data: cleanProfile(row?.data), updated_at: row?.updated_at || null });
  }

  if (req.method === "PUT") {
    if (!req.body || typeof req.body.data !== "object") return res.status(400).json({ error: "Send the profile as data." });
    const data = cleanProfile(req.body.data);
    const u = await fetch(`${rest}?on_conflict=user_id`, {
      method: "POST",
      headers: restHeaders(ctx, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ user_id: ctx.id, data, updated_at: new Date().toISOString() }),
    });
    return u.ok ? res.status(200).json({ data }) : res.status(502).json({ error: "Couldn't save your profile." });
  }

  return res.status(405).end();
}
