// Pure rules for the application flow: the fields an application asks for, what is still missing,
// and the synthetic demo data. No DOM and no network, so the app and the tests share one copy.

// Demo jobs use a demo:// address, which no browser or network call can reach. Real jobs use https.
export const DEMO_SCHEME = "demo://";
export const isDemoJob = (j) => !!j && (j.demo === true || String(j.url || "").startsWith(DEMO_SCHEME));

export const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Returns a new object with one field set. The input is never changed.
export function setPath(obj, path, value) {
  const out = structuredClone(obj ?? {});
  const keys = path.split(".");
  let cur = out;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return out;
}

// The questions an application form asks, in the order most forms ask them.
// kind "yn" stores "yes" or "no". required fields block the review step until answered.
export const FIELDS = [
  { path: "contact.fullName", label: "Full legal name", kind: "text", required: true },
  { path: "contact.email", label: "Email", kind: "text", required: true },
  { path: "contact.phone", label: "Phone", kind: "text", required: true },
  { path: "address.city", label: "City", kind: "text", required: true },
  { path: "address.state", label: "State", kind: "text", required: true },
  { path: "address.zip", label: "ZIP code", kind: "text", required: false },
  { path: "address.country", label: "Country", kind: "text", required: false },
  { path: "work.authorizedUS", label: "Authorized to work in the US", kind: "yn", required: true },
  { path: "work.needsSponsorship", label: "Needs visa sponsorship", kind: "yn", required: true },
  { path: "work.noticePeriod", label: "Notice period", kind: "text", required: false },
  { path: "work.startDate", label: "Earliest start date", kind: "text", required: false },
  { path: "work.salaryMin", label: "Desired salary, minimum (USD)", kind: "text", required: false },
  { path: "work.salaryMax", label: "Desired salary, maximum (USD)", kind: "text", required: false },
  { path: "work.howHeard", label: "How did you hear about us", kind: "text", required: false },
  { path: "work.backgroundCheck", label: "Willing to pass a background check", kind: "yn", required: false },
];

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== "";
export const missingRequired = (profile) => FIELDS.filter((f) => f.required && !filled(getPath(profile, f.path))).map((f) => f.label);
export const missingOptional = (profile) => FIELDS.filter((f) => !f.required && !filled(getPath(profile, f.path))).map((f) => f.label);

// Applies the answers the applicant typed in. Blank answers are ignored, so nothing is invented.
export function applyAnswers(profile, answers) {
  let out = structuredClone(profile);
  for (const f of FIELDS) {
    const v = answers[f.path];
    if (filled(v)) out = setPath(out, f.path, String(v).trim());
  }
  return out;
}

// Synthetic applicant for the demo. Every value is fake, and the example domains are reserved.
// Two required answers are left blank on purpose, so the "Needs your answer" path gets exercised.
export const DEMO_PROFILE = {
  contact: { fullName: "Demo Applicant (synthetic)", preferredName: "", pronouns: "", email: "demo.applicant@example.invalid", phone: "555-0100" },
  address: { street: "100 Example Way", apt: "", city: "Demo City", state: "ST", zip: "00000", country: "United States" },
  eeo: {},
  links: { linkedin: "", github: "", portfolio: "", other: "" },
  work: {
    authorizedUS: "yes", needsSponsorship: "", willingToRelocate: "no", workType: "hybrid",
    noticePeriod: "", startDate: "", salaryMin: "", salaryMax: "", visaStatus: "", clearance: "",
    over18: "yes", backgroundCheck: "", drugTest: "", formerEmployee: "", howHeard: "",
  },
  experience: [{ company: "Demo Analytics Co (synthetic)", title: "Data Analyst", start: "2021-03", end: "2024-06", current: false,
    summary: "Built synthetic reporting pipelines in Python and SQL and presented monthly results to operations leads." }],
  education: [{ school: "Demo University (synthetic)", degree: "B.S.", field: "Statistics", gpa: "", year: "2020" }],
  skills: ["Python", "SQL", "Data pipelines", "Stakeholder reporting"],
  certifications: [], languages: ["English"], references: [], custom: [],
  summary: "Synthetic applicant used to test the application flow.",
  autoApply: {},
};

// Synthetic posting. It names one skill the demo profile lacks, so the "check these" path is exercised too.
export const DEMO_JOB = {
  id: "demo-job",
  demo: true,
  title: "Senior Analyst (synthetic demo role)",
  company: "Demo Company (synthetic)",
  url: "demo://synthetic-job/senior-analyst",
  ats: "Demo mock ATS",
  loc: "Demo City, ST",
  state: "ST",
  remote: false,
  us: true,
  posted: null,
  pay: "",
  description: "<p>Synthetic posting for testing the application flow. No real employer is involved.</p>"
    + "<ul><li>Build reporting pipelines in Python and SQL.</li><li>Build dashboards in Tableau for operations leads.</li>"
    + "<li>Communicate findings to non-technical stakeholders.</li></ul>",
};

// Plain-text resume built only from the profile. Demo output uses this, never a real applicant's data.
export function resumeText(p) {
  const lines = [p.contact?.fullName || "", [p.contact?.email, p.contact?.phone].filter(Boolean).join(" · "), ""];
  if (p.summary) lines.push("Summary", p.summary, "");
  if (p.skills?.length) lines.push("Skills", p.skills.join(", "), "");
  if (p.experience?.length) {
    lines.push("Experience");
    for (const e of p.experience) lines.push(`${e.title || ""}, ${e.company || ""} (${e.start || ""} to ${e.current ? "present" : e.end || ""})`, e.summary || "");
    lines.push("");
  }
  if (p.education?.length) {
    lines.push("Education");
    for (const e of p.education) lines.push(`${e.degree || ""} ${e.field || ""}, ${e.school || ""}${e.year ? " " + e.year : ""}`.trim());
  }
  return lines.join("\n").trim();
}

// Canned tailoring for the demo: rebuilds the same facts for the job, with no AI call and no network.
export function buildDemoDraft(profile, job) {
  const original = resumeText(profile);
  const tailored = [
    original.split("\n")[0],
    `Tailored for: ${job.title}, ${job.company} (demo)`,
    "",
    ...original.split("\n").slice(1),
  ].join("\n");
  const name = profile.contact?.fullName || "";
  const cover = [
    "Dear hiring team,",
    "",
    `I am applying for ${job.title} at ${job.company}. ${profile.summary || ""}`.trim(),
    "",
    profile.experience?.[0]?.summary ? `In my last role: ${profile.experience[0].summary}` : "",
    "",
    "Sincerely,",
    name,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  return {
    resume: tailored,
    cover,
    originalResume: original,
    missing: ["Tableau (named in the posting, not in this profile)"],
    flags: [{ message: "Demo flag: the posting names Tableau. It isn't in this profile, so the draft doesn't claim it." }],
    notes: ["Demo draft: built in your browser from synthetic data. No AI call was made."],
    profileGaps: missingRequired(profile),
  };
}

// Steps the applicant confirms themselves. The app records them; it never performs them.
export const STEP_LABEL = {
  account_created_by_user: "You recorded: account created (done by you, outside this app)",
  verification_waiting: "You recorded: waiting for the verification email (you check your own inbox)",
  verification_done: "You recorded: email verified (done by you, outside this app)",
  submitted_by_user: "You recorded: application submitted on the employer's site (done by you)",
};

// What the app can do on each platform today. Nothing here is automated yet; see docs/ATS_SUPPORT.md.
export function supportText(ats) {
  const name = ats ? String(ats) : "This employer's site";
  return `${name}: the app doesn't fill or submit this form. You complete the account and application steps yourself. Pre-fill isn't built for this platform yet.`;
}

// Which posting text a draft is checked against. The employer's text wins. Pasted text is used only when
// there is none, and it is labelled as unverified. Returns { text, source } with source "" when there is nothing.
export function draftSource({ posting = "", pasted = "" } = {}) {
  const p = String(posting || "").trim();
  if (p) return { text: p, source: "employer" };
  const q = String(pasted || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (q) return { text: q, source: "pasted" };
  return { text: "", source: "" };
}

// What still stops the applicant from opening the employer's form. Each blocker says where to fix it.
// A tailored resume version is required here, so the applicant always has a reviewed resume on record.
// The cover letter is optional and is never a blocker.
export function reviewBlockers({ profile, resumeSaved }) {
  const out = [];
  const req = missingRequired(profile);
  if (req.length) out.push({ step: "answers", text: `Answer the required questions: ${req.join(", ")}.` });
  if (!resumeSaved) out.push({ step: "materials", text: "Save a tailored resume version first: open Materials, draft it, review it, and save it." });
  return out;
}
