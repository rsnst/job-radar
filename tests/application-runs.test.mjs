import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/application-runs.js";

test("application decisions accept numeric database IDs and reject malformed IDs", async (t) => {
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = "https://example.test";
  process.env.SUPABASE_ANON_KEY = "synthetic-test-key";
  t.after(() => {
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = oldKey;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: "test-user" });
    requests.push({ url, opts });
    return Response.json([{ id: 123, user_decision: "approve" }]);
  });
  async function call(method, id) {
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, headers: { authorization: "Bearer test" }, query: { id }, body: { id, decision: "approve" } }, res);
    return res;
  }
  for (const id of [123, "123", "9223372036854775807"]) {
    assert.equal((await call("PATCH", id)).code, 200);
    assert.ok(requests.at(-1).url.includes(`id=eq.${id}&`));
  }
  for (const id of [0, -1, 1.5, {}, "abc", "1&user_id=eq.other", "9223372036854775808", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await call("PATCH", id)).code, 400);
    assert.equal((await call("GET", id)).code, 400);
  }
  assert.equal(requests.length, 3);
});
