import { jobsQuery, boardsQuery, PAGE } from "./query.js";
import { account, initAccount, toggleSave, signIn, signOut, listSaved } from "./account.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = new Intl.NumberFormat("en-US");

let meta, db, worker;
const jobById = new Map(); // job id -> row, for the save buttons

// ---------- state <-> URL hash
const JOB_KEYS = ["q", "days", "state", "ats", "remote", "fresh", "usonly", "board", "bname"];
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { tab: p.get("tab") || "jobs", ...Object.fromEntries(JOB_KEYS.map((k) => [k, p.get(k) || ""])) };
}
function writeHash(s) {
  const p = new URLSearchParams();
  if (s.tab && s.tab !== "jobs") p.set("tab", s.tab);
  for (const k of JOB_KEYS) if (s[k]) p.set(k, s[k]);
  const h = p.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname);
}
let S = readHash();

// ---------- last-visit tracking for "new since last visit"
function visitWindow(today) {
  let v = {};
  try { v = JSON.parse(localStorage.getItem("jr.visit") || "{}"); } catch {}
  if (v.cur !== today) {
    v = { prev: v.cur ?? null, cur: today };
    try { localStorage.setItem("jr.visit", JSON.stringify(v)); } catch {}
  }
  return v.prev == null ? today : v.prev + 1; // first visit: "new today"
}
let newSince;

// ---------- formatting
function ago(day) {
  if (day == null) return "";
  const d = meta.today - day;
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}
function updated(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// ---------- DB
async function query(q) {
  return db.query(q.sql, q.params);
}
async function showBytes() {
  try {
    const s = await worker.worker.getStats();
    if (s) $("#bytes").textContent = `Fetched ${(s.totalFetchedBytes / 1048576).toFixed(1)} MB of ${(s.totalBytes / 1048576).toFixed(0)} MB`;
  } catch {}
}

// ---------- Jobs tab
let jobsSeq = 0, lastId = 0, jobsDone = false, jobsLoading = false;

function jobFilters() {
  return {
    q: S.q, days: S.days, state: S.state, ats: S.ats, board: S.board,
    remote: S.remote === "1", usOnly: S.usonly === "1",
    newSince: S.fresh === "1" ? newSince : null,
  };
}

function saveButton(j) {
  jobById.set(j.id, j);
  const on = account.saved.has(j.url);
  return `<button type="button" class="save${on ? " on" : ""}" data-save="${j.id}" aria-pressed="${on}">${on ? "Saved" : "Save"}</button>`;
}

function refreshSaveButtons() {
  for (const b of document.querySelectorAll("button[data-save]")) {
    const j = jobById.get(Number(b.dataset.save));
    const on = j && account.saved.has(j.url);
    b.classList.toggle("on", !!on);
    b.setAttribute("aria-pressed", String(!!on));
    b.textContent = on ? "Saved" : "Save";
  }
}

function jobCard(j) {
  const isNew = j.seen >= newSince;
  return `<li class="card">
    <p class="t"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></p>
    <div class="co"><button type="button" data-board="${j.board}" data-name="${esc(j.company)}">${esc(j.company)}</button></div>
    <div class="meta">
      ${isNew ? '<span class="badge new">NEW</span>' : ""}
      ${j.remote ? '<span class="badge remote">REMOTE</span>' : ""}
      <span>${esc(j.loc || "Location not listed")}</span>
      ${j.us ? "" : '<span class="badge unk" title="Location didn\'t say which country">LOC?</span>'}
      <span>${esc(j.ats)}</span>
      <span>${ago(j.posted)}</span>
      ${account.enabled ? saveButton(j) : ""}
    </div>
  </li>`;
}

async function loadJobs(reset) {
  if (reset) {
    jobsSeq++; lastId = 0; jobsDone = false;
    $("#jobs").innerHTML = '<li class="skeleton"></li>'.repeat(4);
  }
  if (jobsDone || (jobsLoading && !reset)) return;
  const seq = jobsSeq;
  jobsLoading = true;
  $("#jobs-more").textContent = reset ? "" : "Loading…";
  try {
    const rows = await query(jobsQuery({ ...jobFilters(), afterId: lastId }, meta));
    if (seq !== jobsSeq) return;
    if (reset) { $("#jobs").innerHTML = ""; jobById.clear(); }
    if (!rows.length && !lastId) {
      $("#jobs").innerHTML = '<li class="empty">No jobs match. Try fewer filters or a shorter search.</li>';
    }
    $("#jobs").insertAdjacentHTML("beforeend", rows.map(jobCard).join(""));
    if (rows.length) lastId = rows[rows.length - 1].id;
    jobsDone = rows.length < PAGE;
    $("#jobs-more").innerHTML = jobsDone ? (lastId ? "That's everything." : "") : '<button type="button" id="more-btn">Load more</button>';
  } catch (e) {
    if (seq === jobsSeq) $("#jobs").innerHTML = `<li class="err">Query failed: ${esc(e.message || e)}</li>`;
  } finally {
    if (seq === jobsSeq) jobsLoading = false;
    showBytes();
  }
}

function syncJobControls() {
  $("#q").value = S.q;
  for (const k of ["days", "state", "ats"]) $("#" + k).value = S[k];
  $("#remote").checked = S.remote === "1";
  $("#fresh").checked = S.fresh === "1";
  $("#usonly").checked = S.usonly === "1";
  const bar = $("#company-filter");
  if (S.board) {
    bar.hidden = false;
    bar.innerHTML = `<span class="pill">${esc(S.bname || "Company")} <button type="button" aria-label="Clear company">×</button></span>`;
  } else bar.hidden = true;
}

// ---------- Companies tab
let coSeq = 0, coOffset = 0, coDone = false;
function coRow(b) {
  const st = { ok: "fetched", error: "fetch failed", unsupported: "not indexed", not_run: "not run" }[b.status] || b.status;
  return `<li class="card">
    <div class="co-row">
      <div><p class="t">${esc(b.company)}</p>
        <div class="meta"><span>${esc(b.ats)}</span><span class="badge st-${esc(b.status)}">${esc(st)}</span>${b.evidence ? `<span>${esc(b.evidence)}</span>` : ""}</div></div>
      <div class="n">${fmt.format(b.jobs)}<small>US jobs</small></div>
    </div>
    <div class="co-actions">
      ${b.jobs ? `<button type="button" data-board="${b.id}" data-name="${esc(b.company)}">See jobs</button>` : ""}
      <a href="${esc(b.url)}" target="_blank" rel="noopener">Open board ↗</a>
    </div>
  </li>`;
}
async function loadCompanies(reset) {
  if (reset) { coSeq++; coOffset = 0; coDone = false; $("#companies").innerHTML = '<li class="skeleton"></li>'.repeat(4); }
  if (coDone) return;
  const seq = coSeq;
  try {
    const rows = await query(boardsQuery({ q: $("#cq").value, ats: $("#cats").value, hasJobs: $("#hasjobs").checked, offset: coOffset }));
    if (seq !== coSeq) return;
    if (reset) $("#companies").innerHTML = rows.length ? "" : '<li class="empty">No companies match.</li>';
    $("#companies").insertAdjacentHTML("beforeend", rows.map(coRow).join(""));
    coOffset += rows.length;
    coDone = rows.length < PAGE;
    $("#co-more").innerHTML = coDone ? "" : '<button type="button" id="co-more-btn">Load more</button>';
  } catch (e) {
    if (seq === coSeq) $("#companies").innerHTML = `<li class="err">Query failed: ${esc(e.message || e)}</li>`;
  } finally { showBytes(); }
}

// ---------- Coverage tab
function renderCoverage() {
  const r = meta.run;
  if (r) {
    const o = r.outcome || {};
    const mins = (r.fetch_seconds / 60).toFixed(1);
    const parts = [
      `Last run (${r.mode === "full" ? "full sweep" : "daily incremental"})` +
        (r.shards ? `: ${fmt.format(r.requests)} requests in ${mins} min across ${r.shards} runners` : ""),
      o.fetched != null && `${fmt.format(o.fetched)} boards fully fetched`,
      o.page1_unchanged && `${fmt.format(o.page1_unchanged)} unchanged after page 1`,
      o.skipped_empty && `${fmt.format(o.skipped_empty)} empty boards skipped (re-checked weekly)`,
      (o.error || o.error_kept_last) && `${fmt.format((o.error || 0) + (o.error_kept_last || 0))} failed`,
      r.throttled && `${fmt.format(r.throttled)} rate-limit responses`,
    ].filter(Boolean);
    $("#run").textContent = parts.join(" · ") + ".";
  }
  const rows = Object.entries(meta.by_ats);
  const max = Math.max(1, ...rows.map(([, a]) => a.jobs));
  $("#coverage").innerHTML = `<thead><tr><th>ATS</th><th>Boards</th><th>Fetched</th><th>Failed</th><th>Not indexed</th><th>US jobs</th></tr></thead><tbody>` +
    rows.map(([name, a]) => `<tr><td>${esc(name)}</td><td>${fmt.format(a.boards)}</td><td>${fmt.format(a.ok)}</td><td>${fmt.format(a.error || 0)}</td><td>${fmt.format(a.unsupported)}</td>
      <td>${fmt.format(a.jobs)}<span class="bar" style="width:${Math.max(2, Math.round((a.jobs / max) * 60))}px"></span></td></tr>`).join("") + "</tbody>";
}

// ---------- Saved tab (needs an account)
async function loadSaved() {
  const box = $("#saved");
  const msg = $("#saved-msg");
  if (!account.enabled) { msg.textContent = "Accounts aren't configured for this site."; box.innerHTML = ""; return; }
  if (!account.user) {
    msg.innerHTML = 'Sign in with Google to save jobs and see them here. <button type="button" class="link" id="saved-signin">Sign in</button>';
    box.innerHTML = "";
    return;
  }
  msg.textContent = "Loading…";
  try {
    const rows = await listSaved();
    msg.textContent = rows.length ? `${rows.length} saved` : "No saved jobs yet. Use Save on any job.";
    box.innerHTML = rows.map((r) => `<li class="card">
      <p class="t"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></p>
      <div class="meta"><span>${esc(r.company)}</span>${r.loc ? `<span>${esc(r.loc)}</span>` : ""}<span>saved ${esc(r.created_at.slice(0, 10))}</span></div>
      <div class="meta"><button type="button" class="link" data-unsave="${esc(r.url)}">Remove</button></div>
    </li>`).join("");
  } catch (e) {
    msg.textContent = `Couldn't load saved jobs: ${e.message || e}`;
  }
}

function updateAuthUI() {
  const b = $("#auth");
  b.hidden = !account.enabled;
  b.textContent = account.user ? "Sign out" : "Sign in";
  b.dataset.mode = account.user ? "out" : "in";
}

// ---------- tabs
let coLoaded = false;
function showTab(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const t of ["jobs", "companies", "saved", "coverage"]) $("#tab-" + t).hidden = t !== tab;
  if (tab === "saved") loadSaved();
  if (tab === "companies" && !coLoaded && db) { coLoaded = true; loadCompanies(true); }
  writeHash(S);
}

// ---------- wiring
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function setJob(patch) { Object.assign(S, patch); writeHash(S); syncJobControls(); loadJobs(true); }

function wire() {
  document.querySelector(".tabs").addEventListener("click", (e) => { const t = e.target.closest("button")?.dataset.tab; if (t) showTab(t); });
  $("#jobs-form").addEventListener("submit", (e) => { e.preventDefault(); $("#q").blur(); });
  $("#q").addEventListener("input", debounce(() => setJob({ q: $("#q").value.trim() }), 300));
  for (const k of ["days", "state", "ats"]) $("#" + k).addEventListener("change", () => setJob({ [k]: $("#" + k).value }));
  for (const k of ["remote", "fresh", "usonly"]) $("#" + k).addEventListener("change", () => setJob({ [k]: $("#" + k).checked ? "1" : "" }));
  $("#reset").addEventListener("click", () => setJob(Object.fromEntries(JOB_KEYS.map((k) => [k, ""]))));
  $("#company-filter").addEventListener("click", (e) => { if (e.target.closest("button")) setJob({ board: "", bname: "" }); });
  const pickBoard = (e) => {
    const b = e.target.closest("button[data-board]");
    if (!b) return;
    e.preventDefault();
    setJob({ board: b.dataset.board, bname: b.dataset.name, q: "", state: "", ats: "", days: "", remote: "", fresh: "", usonly: "" });
    showTab("jobs");
    scrollTo({ top: 0 });
  };
  $("#auth").addEventListener("click", () => (account.user ? signOut() : signIn()));
  $("#saved").addEventListener("click", async (e) => {
    const u = e.target.closest("button[data-unsave]");
    if (!u) return;
    const row = { url: u.dataset.unsave };
    await toggleSave(row).catch((err) => alert(`Couldn't remove: ${err.message || err}`));
    loadSaved();
  });
  $("#tab-saved").addEventListener("click", (e) => { if (e.target.id === "saved-signin") signIn(); });
  const onSave = async (e) => {
    const b = e.target.closest("button[data-save]");
    if (!b) return;
    const j = jobById.get(Number(b.dataset.save));
    if (!j) return;
    b.disabled = true;
    try { await toggleSave({ url: j.url, title: j.title, company: j.company, loc: j.loc }); }
    catch (err) { alert(`Couldn't save: ${err.message || err}`); }
    finally { b.disabled = false; refreshSaveButtons(); }
  };
  $("#jobs").addEventListener("click", onSave);
  $("#jobs").addEventListener("click", pickBoard);
  $("#companies").addEventListener("click", pickBoard);
  $("#jobs-more").addEventListener("click", (e) => { if (e.target.id === "more-btn") loadJobs(false); });
  $("#co-more").addEventListener("click", (e) => { if (e.target.id === "co-more-btn") loadCompanies(false); });
  $("#co-form").addEventListener("submit", (e) => { e.preventDefault(); $("#cq").blur(); });
  $("#cq").addEventListener("input", debounce(() => loadCompanies(true), 300));
  $("#cats").addEventListener("change", () => loadCompanies(true));
  $("#hasjobs").addEventListener("change", () => loadCompanies(true));
  // infinite scroll
  const io = new IntersectionObserver((ents) => {
    if (!ents.some((e) => e.isIntersecting)) return;
    if (S.tab === "jobs" && !jobsDone && lastId) loadJobs(false);
    if (S.tab === "companies" && !coDone && coOffset) loadCompanies(false);
  }, { rootMargin: "600px" });
  io.observe($("#jobs-more"));
  io.observe($("#co-more"));
}

async function main() {
  try {
    meta = await (await fetch("meta.json", { cache: "no-cache" })).json();
  } catch {
    $("#stats").textContent = "No data yet — the first daily scrape hasn't finished.";
    return;
  }
  newSince = visitWindow(meta.today);
  $("#fresh-label").textContent = newSince >= meta.today ? "New today" : "New since last visit";
  $("#stats").textContent = `${fmt.format(meta.jobs)} US jobs · ${fmt.format(meta.boards_with_jobs)} companies hiring · updated ${updated(meta.generated_at)}`;
  for (const s of meta.states) $("#state").insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`);
  for (const [a, v] of Object.entries(meta.by_ats)) {
    if (v.jobs) $("#ats").insertAdjacentHTML("beforeend", `<option>${esc(a)}</option>`);
    $("#cats").insertAdjacentHTML("beforeend", `<option>${esc(a)}</option>`);
  }
  renderCoverage();
  syncJobControls();
  account.onChange = () => { updateAuthUI(); refreshSaveButtons(); if (S.tab === "saved") loadSaved(); };
  initAccount().then(() => { updateAuthUI(); refreshSaveButtons(); });
  wire();
  showTab(S.tab);
  $("#jobs").innerHTML = '<li class="skeleton"></li>'.repeat(4);
  try {
    worker = await window.createDbWorker(
      [{ from: "jsonconfig", configUrl: new URL(`db/config.json?v=${meta.version}`, location.href).toString() }],
      new URL("vendor/sqlite.worker.js", location.href).toString(),
      new URL("vendor/sql-wasm.wasm", location.href).toString(),
      256 * 1024 * 1024,
    );
    db = worker.db;
  } catch (e) {
    $("#jobs").innerHTML = `<li class="err">Couldn't open the job database: ${esc(e.message || e)}</li>`;
    return;
  }
  loadJobs(true);
  if (S.tab === "companies") { coLoaded = true; loadCompanies(true); }
}
main();
