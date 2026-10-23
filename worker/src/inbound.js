// Inbound-mail webhook. Runs inside the worker (the only place with the service-role key).
// POST /inbound with Authorization: Bearer <INBOUND_SECRET> (or HTTP Basic with the secret as password).
// Accepts {to, from, subject, text} or Postmark-style {To, From, Subject, TextBody}.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { aliasToken, extractVerification, senderAllowed } from "./mail.js";

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function authorized(header, secret) {
  if (!secret) return false;
  const h = String(header || "");
  if (h.startsWith("Bearer ")) return same(h.slice(7), secret);
  if (h.startsWith("Basic ")) return same(Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":"), secret);
  return false;
}

// The user's alias address, created on first use.
export async function ensureAlias(rest, userId, domain) {
  const uid = encodeURIComponent(userId);
  const [row] = await rest(`mail_aliases?select=token&user_id=eq.${uid}&limit=1`);
  if (row) return `jc-${row.token}@${domain}`;
  const token = randomBytes(9).toString("hex");
  await rest("mail_aliases?on_conflict=user_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ user_id: userId, token }) });
  const [made] = await rest(`mail_aliases?select=token&user_id=eq.${uid}&limit=1`);
  return `jc-${made.token}@${domain}`;
}

export async function storeInbound(rest, mail, domain) {
  const token = aliasToken(mail.to, domain);
  if (!token) return { stored: false, reason: "unknown-recipient" };
  if (!senderAllowed(mail.from)) return { stored: false, reason: "sender-not-allowed" };
  const found = extractVerification(mail.subject, mail.text);
  if (!found) return { stored: false, reason: "no-code-or-link" };
  const [alias] = await rest(`mail_aliases?select=user_id&token=eq.${encodeURIComponent(token)}&limit=1`);
  if (!alias) return { stored: false, reason: "unknown-recipient" };
  await rest("inbound_mail", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
    user_id: alias.user_id, sender: String(mail.from).slice(0, 200), subject: String(mail.subject || "").slice(0, 200), code: found.code, link: found.link,
  }) });
  return { stored: true };
}

// Newest unused, unexpired code or link for the user that arrived after `since` (ISO). Marks it used.
export async function takeVerification(rest, userId, since) {
  const uid = encodeURIComponent(userId);
  const now = new Date().toISOString();
  const rows = await rest(`inbound_mail?select=id,code,link&user_id=eq.${uid}&consumed=eq.false&created_at=gte.${encodeURIComponent(since)}&expires_at=gt.${encodeURIComponent(now)}&order=created_at.desc&limit=1`);
  if (!rows?.[0]) return null;
  await rest(`inbound_mail?id=eq.${rows[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ consumed: true, code: "", link: "" }) });
  return { code: rows[0].code, link: rows[0].link };
}

export function startInboundServer({ rest, secret = process.env.INBOUND_SECRET, domain = process.env.INBOX_DOMAIN, port = Number(process.env.INBOUND_PORT) || 8787 } = {}) {
  if (!secret || !domain) return null;
  const server = http.createServer(async (req, res) => {
    const end = (status, body = "") => { res.writeHead(status, { "content-type": "text/plain" }); res.end(body); };
    if (req.method !== "POST" || new URL(req.url, "http://x").pathname !== "/inbound") return end(404);
    if (!authorized(req.headers.authorization, secret)) return end(401);
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 400_000) return end(413); }
    let p; try { p = JSON.parse(raw); } catch { return end(400); }
    const to = p.to ?? p.To ?? p.ToFull?.map?.((x) => x.Email) ?? "";
    try {
      const r = await storeInbound(rest, { to, from: p.from ?? p.From ?? "", subject: p.subject ?? p.Subject ?? "", text: p.text ?? p.TextBody ?? "" }, domain);
      return end(200, r.stored ? "stored" : r.reason);   // 200 either way, so providers don't retry mail we ignore
    } catch { return end(500); }
  });
  server.listen(port);
  return server;
}
