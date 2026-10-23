// Usage counters are incremented atomically by an authenticated-only RPC in the
// usage_guard schema. Browser clients have no direct write access to the tables.
export async function consumeAiUsage(ctx, kind) {
  const response = await fetch(`${ctx.url}/rest/v1/rpc/consume_ai_usage`, {
    method: "POST",
    headers: {
      apikey: ctx.key,
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
      "Content-Profile": "usage_guard",
      "Accept-Profile": "usage_guard",
    },
    body: JSON.stringify({ p_kind: kind }),
  });
  if (!response.ok) throw new Error("Couldn't update usage. Apply supabase/usage_limits.sql and expose usage_guard in the Supabase Data API.");
  const n = await response.json();
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Usage counter returned an invalid value.");
  return n;
}

export async function useQuota(ctx, kind, daily) {
  try {
    const n = await consumeAiUsage(ctx, kind);
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(daily) || 1)));
    return { ok: true, allowed: n <= limit };
  } catch {
    return { ok: false, allowed: false };
  }
}
