// App-shell cache so Job Compass opens offline and installs on a phone.
// The job database (/db/, meta.json) and every /api call always go to the network: they are never cached here.
const SHELL = "jc-shell-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "account.js", "apply.js", "flow.js", "flow-model.js", "store.js", "query.js", "intake.js", "jobs-in.js", "resume-parse.js", "resume-ats.js", "docx-lite.js", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (/^\/(db\/|api\/|meta\.json|config\.js)/.test(url.pathname)) return; // live data and config: network only
  // Network first, so a new deploy shows up immediately; the cache is only the offline fallback.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match("index.html"))));
});
