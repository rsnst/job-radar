// Employer-account passwords: AES-256-GCM, key held only by the worker (CREDENTIAL_KEY, 32 bytes, base64).
// The web app and API never see the key or a decrypted password. The user can delete an entry at any time.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function loadKey(raw = process.env.CREDENTIAL_KEY) {
  const buf = Buffer.from(String(raw || ""), "base64");
  return buf.length === 32 ? buf : null;
}

export function encryptSecret(plain, key) {
  if (!key) throw new Error("CREDENTIAL_KEY is not set.");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

export function decryptSecret(token, key) {
  if (!key) throw new Error("CREDENTIAL_KEY is not set.");
  const [v, iv, tag, ct] = String(token || "").split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unreadable stored credential.");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

// 20 chars with every class Workday-style policies ask for. Generated per employer, never reused.
export function generatePassword() {
  const sets = ["abcdefghjkmnpqrstuvwxyz", "ABCDEFGHJKMNPQRSTUVWXYZ", "23456789", "!#$%*+-=?"];
  const all = sets.join("");
  const pick = (s) => s[randomBytes(1)[0] % s.length];
  const chars = [...sets.map(pick), ...Array.from({ length: 16 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) { const j = randomBytes(1)[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}
