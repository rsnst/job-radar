import test from "node:test";
import assert from "node:assert/strict";

test("sweepCancelled marks only queued cancel/reject runs as cancelled", async () => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return new Response(null, { status: 204 }); };
  const { sweepCancelled } = await import("../src/index.js");
  await sweepCancelled();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /status=eq\.queued&user_decision=in\.\(cancel,reject\)$/);
  assert.equal(calls[0].opts.method, "PATCH");
  assert.equal(JSON.parse(calls[0].opts.body).status, "cancelled");
});
