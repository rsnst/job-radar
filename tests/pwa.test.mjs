import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const exists = (p) => fs.existsSync(new URL(`../${p}`, import.meta.url));

test("web manifest: installable, with a share target for phone share sheets", () => {
  const m = JSON.parse(read("web/manifest.webmanifest"));
  assert.equal(m.display, "standalone");
  assert.equal(m.share_target.method, "GET");
  assert.deepEqual(m.share_target.params, { title: "title", text: "text", url: "url" });
  const sizes = m.icons.filter((i) => i.type === "image/png").map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  for (const i of m.icons) assert.ok(exists(`web/${i.src}`), i.src);
});

test("service worker: every shell file exists, and live data is never cached", () => {
  const sw = read("web/sw.js");
  const files = JSON.parse(sw.match(/const FILES = (\[.*?\]);/s)[1]);
  for (const f of files) if (f !== "./") assert.ok(exists(`web/${f}`), `${f} listed in sw.js but missing`);
  const skip = new RegExp(sw.match(/test\(url\.pathname\)|\.test\(url\.pathname\)/) ? sw.match(/if \((\/.*?\/)\.test\(url\.pathname\)\)/)[1].slice(1, -1) : "$^");
  for (const p of ["/db/db.sqlite3.20261023053401.000", "/api/applications", "/meta.json", "/config.js"]) assert.ok(skip.test(p), p);
  assert.ok(!skip.test("/app.js"));
});

test("extension: Manifest V3, asks only for activeTab, scripting and storage, no host access", () => {
  const m = JSON.parse(read("extension/manifest.json"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.background, undefined);
  for (const f of [m.action.default_popup, ...Object.values(m.icons), "pick.js", "popup.js"]) assert.ok(exists(`extension/${f}`), f);
});

test("the site build copies the icons folder and the service worker", () => {
  assert.match(read("scripts/vendor.mjs"), /fs\.cpSync\("web", out, \{ recursive: true \}\)/);
});
