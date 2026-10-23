// Daily limits are counted by the database (supabase/hardening.sql) so parallel requests can't slip past them.
import { restHeaders } from "./supa.js";
export async function useQuota(ctx, kind, daily) {
  const r = await fetch(`${ctx.url}/rest/v1/rpc/use_quota`, { method: "POST", headers: restHeaders(ctx), body: JSON.stringify({ kind, daily }) });
  return r.ok ? { ok: true, allowed: (await r.json()) === true } : { ok: false, allowed: false };
}
// Give the allowance back when the AI call itself failed.
export async function refundQuota(ctx, kind) {
  await fetch(`${ctx.url}/rest/v1/rpc/refund_quota`, { method: "POST", headers: restHeaders(ctx), body: JSON.stringify({ kind }) }).catch(() => {});
}
