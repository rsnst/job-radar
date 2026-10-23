// Verification email handling. Mail arrives at a per-user alias (jc-<token>@INBOX_DOMAIN) through an inbound
// webhook; Job Compass never connects to the user's own inbox. Only an extracted code or a verification link
// is kept (never the body), and only from Workday senders. Pure functions here, storage in inbound.js.

const WORKDAY_HOST = /(^|\.)(myworkday\.com|myworkdayjobs\.com|workday\.com)$/i;

export function senderAllowed(from) {
  const m = String(from || "").match(/@([a-z0-9.-]+)>?\s*$/i);
  return !!m && WORKDAY_HOST.test(m[1]);
}

export function linkAllowed(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && WORKDAY_HOST.test(u.hostname);
  } catch { return false; }
}

// A one-time code (4-8 digits, near a "code" word) or a verify/confirm/activate link. Code wins when both.
export function extractVerification(subject, text) {
  const body = `${subject || ""}\n${String(text || "").slice(0, 20000)}`;
  const code = body.match(/(?:verification|security|confirmation|one[- ]time|access)?\s*code\b[^0-9]{0,40}(\d{4,8})\b/i)
    || body.match(/\b(\d{6})\b[^\n]{0,40}(?:is your|verification code)/i);
  if (code) return { code: code[1], link: "" };
  const links = [...body.matchAll(/https:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0].replace(/[.,;]+$/, ""));
  const link = links.find((l) => linkAllowed(l) && /verif|confirm|activate|validate/i.test(l));
  return link ? { code: "", link } : null;
}

// "jc-abc123@inbox.example.com" -> "abc123" when the domain matches INBOX_DOMAIN.
export function aliasToken(to, domain) {
  const list = Array.isArray(to) ? to : String(to || "").split(",");
  for (const entry of list) {
    const m = String(entry).match(/jc-([a-z0-9]{12,40})@([a-z0-9.-]+)/i);
    if (m && m[2].toLowerCase() === String(domain || "").toLowerCase()) return m[1].toLowerCase();
  }
  return "";
}
