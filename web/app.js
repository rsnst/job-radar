import { jobsQuery, boardsQuery, detailQuery, PAGE } from "./query.js";
import { startAdminRuns, stopAdminRuns } from "./admin-runs.js";
import { account, initAccount, toggleSave, signIn, signOut, signInWithEmail, signInWithPassword, signUpWithPassword, listSaved } from "./account.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = new Intl.NumberFormat("en-US");

let meta, db, worker;
const jobById = new Map(); // job id -> row, for the save buttons

// ---------- state <-> URL hash
const JOB_KEYS = ["q", "days", "state", "ats", "sort", "remote", "fresh", "usonly", "board", "bname"];
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { tab: p.get("tab") || "jobs", ...Object.fromEntries(JOB_KEYS.map((k) => [k, p.get(k) || ""])) };
}
function writeHash(s) {
  // A sign-in link returns its token in the hash. Keep it until Supabase has read it.
  if (/(^|[#&])(access_token|error|error_code)=/.test(location.hash)) return;
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
  returning = v.prev != null;
  return v.prev == null ? today : v.prev + 1; // first visit: "new today"
}
let newSince;
let returning = false; // true once this browser has visited before, so "New" means something

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
let jobsSeq = 0, lastId = 0, loaded = 0, jobsDone = false, jobsLoading = false;
const emptyJobs = () => '<li class="empty"><p>No jobs match these filters.</p><button type="button" class="btn" data-clear>Clear filters</button></li>';

function jobFilters() {
  return {
    q: S.q, days: S.days, state: S.state, ats: S.ats, board: S.board, sort: S.sort,
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

// Some boards publish placeholder names like "ADP employer (cid b77db729)". Show the real name.
function displayName(name) {
  const s = String(name || "").replace(/\s+employer\s*\(cid[^)]*\)/i, "").replace(/\s*\(cid[^)]*\)/i, "").trim();
  return s || String(name || "");
}

// A calm warm monogram per company, so every card has a stable visual anchor
function monogram(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const words = String(name || "").replace(/[^\p{L} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const letters = (words.slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
  return { letters, hue: 14 + (h % 36) }; // warm range: rust → amber
}

// "today", "3d ago", "2mo ago"; say so plainly when the feed has no date
function posted(day) {
  return day == null ? "Date not listed" : ago(day);
}

// Contract type that the title already states, e.g. "FTC" or "12 months"
function contractOf(title) {
  const m = String(title || "").match(/\b(FTC|fixed[- ]term|contract|temporary|internship|part[- ]time|seasonal)\b|\b\d+\s*months?\b/i);
  if (!m) return "";
  return m[1] ? m[1].replace(/^./, (c) => c.toUpperCase()) : m[0];
}

function jobCard(j) {
  jobById.set(j.id, j); // the details panel and save buttons look jobs up by id
  const co = displayName(j.company);
  const isNew = returning && j.seen >= newSince;
  const m = monogram(co);
  return `<li class="card">
    <div class="card-head">
      <span class="mono" style="--h:${m.hue}" aria-hidden="true">${esc(m.letters)}</span>
      <div class="card-title">
        <p class="t"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></p>
        <div class="co"><button type="button" data-board="${j.board}" data-name="${esc(co)}">${esc(co)}</button></div>
        ${j.pay ? `<p class="pay-line" title="Pay listed in the posting">${esc(j.pay)}</p>` : ""}
      </div>
      ${account.enabled ? saveButton(j) : ""}
    </div>
    <div class="meta">
      <span class="place"${j.loc && !j.us ? ' title="The posting didn\'t say which country"' : ""}>${esc(j.loc || "Location not stated")}</span>
      <span>${esc(j.ats)}</span>
      <span>${j.pd ? posted(j.posted) : (j.seen != null ? "First seen " + ago(j.seen) : "Date not listed")}</span>
    </div>
    <div class="tags">
      ${isNew ? '<span class="badge new">New</span>' : ""}
      ${j.remote ? '<span class="badge remote">Remote</span>' : ""}
      ${contractOf(j.title) ? `<span class="badge contract">${esc(contractOf(j.title))}</span>` : ""}
    </div>
    <div class="card-foot">
      <a class="apply" href="${esc(j.url)}" target="_blank" rel="noopener">Apply<span class="sr-only"> for ${esc(j.title)}</span></a>
      <button type="button" class="details" data-detail="${j.id}">Details</button>
    </div>
  </li>`;
}

async function loadJobs(reset) {
  if (reset) {
    jobsSeq++; lastId = 0; loaded = 0; jobsDone = false;
    $("#jobs").innerHTML = '<li class="skeleton"></li>'.repeat(4);
    $("#count").textContent = "";
  }
  if (jobsDone || (jobsLoading && !reset)) return;
  const seq = jobsSeq;
  jobsLoading = true;
  $("#jobs-more").textContent = reset ? "" : "Loading…";
  try {
    const rows = await query(jobsQuery({ ...jobFilters(), afterId: lastId, offset: loaded }, meta));
    if (seq !== jobsSeq) return;
    if (reset) { $("#jobs").innerHTML = ""; jobById.clear(); }
    if (!rows.length && !loaded) $("#jobs").innerHTML = emptyJobs();
    $("#jobs").insertAdjacentHTML("beforeend", rows.map(jobCard).join(""));
    if (rows.length) lastId = rows[rows.length - 1].id;
    loaded += rows.length;
    jobsDone = rows.length < PAGE;
    $("#count").textContent = !loaded ? "" : jobsDone ? `${fmt.format(loaded)} job${loaded === 1 ? "" : "s"}` : `Showing ${fmt.format(loaded)} so far`;
    $("#jobs-more").innerHTML = jobsDone ? (loaded ? "That's everything." : "") : '<button type="button" id="more-btn">Load more</button>';
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
  $("#sort").value = S.sort || "newest";
  // On phones the filters sit behind a button; show how many are active on it
  const active = [S.days, S.state, S.ats, S.remote, S.fresh, S.usonly, S.sort].filter(Boolean).length;
  $("#filters-toggle").textContent = active ? `Filters · ${active}` : "Filters";
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
      <div><p class="t">${esc(displayName(b.company))}</p>
        <div class="meta"><span>${esc(b.ats)}</span><span class="badge st-${esc(b.status)}">${esc(st)}</span>${b.evidence ? `<span>${esc(b.evidence)}</span>` : ""}</div></div>
      <div class="n">${fmt.format(b.jobs)}<small>US jobs</small></div>
    </div>
    <div class="co-actions">
      ${b.jobs ? `<button type="button" data-board="${b.id}" data-name="${esc(displayName(b.company))}">See jobs</button>` : ""}
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
  $("#admin-tab").hidden = !account.isAdmin;
  if (!account.isAdmin && S.tab === "admin") showTab("jobs");
}

// ---------- admin panel: numbers from the last scrape (meta.json)
function renderAdmin() {
  const r = meta.run || {};
  const n = (v) => (v == null ? "—" : fmt.format(v));
  const rows = [
    ["Last run mode", r.mode ?? "—"],
    ["Shards reporting", n(r.shards)],
    ["Requests", n(r.requests)],
    ["Throttled (429)", n(r.throttled)],
    ["Fetch time (slowest shard, s)", n(Math.round(r.fetch_seconds || 0))],
    ["Boards", n(meta.boards)],
    ["Boards OK", n(meta.boards_ok)],
    ["Boards with jobs", n(meta.boards_with_jobs)],
    ["Boards error", n(meta.boards_error)],
    ["Boards unsupported", n(meta.boards_unsupported)],
    ["Jobs", n(meta.jobs)],
    ["Jobs with pay", meta.with_pay == null ? "—" : n(meta.with_pay)],
    ["Jobs with description", meta.with_details == null ? "—" : n(meta.with_details)],
    ["Outcome", Object.entries(r.outcome || {}).map(([k, v]) => `${k}: ${fmt.format(v)}`).join(" · ") || "—"],
  ];
  const ats = Object.entries(meta.by_ats || {}).map(([name, a]) =>
    `<tr><td>${esc(name)}</td><td>${n(a.boards)}</td><td>${n(a.ok)}</td><td>${n(a.error)}</td><td>${n(a.unsupported)}</td><td>${n(a.jobs)}</td></tr>`).join("");
  $("#admin-body").innerHTML = `
    <dl class="facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <div class="table-wrap"><table><thead><tr><th>ATS</th><th>Boards</th><th>OK</th><th>Error</th><th>Unsupported</th><th>Jobs</th></tr></thead><tbody>${ats}</tbody></table></div>`;
}

// ---------- sign-in dialog
function openSignIn() {
  $("#signin-msg").textContent = "";
  $("#signin-dialog").showModal();
  $("#signin-email").focus();
}

// ---------- tabs
let coLoaded = false;
function showTab(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const t of ["jobs", "companies", "saved", "coverage", "admin"]) $("#tab-" + t).hidden = t !== tab;
  if (tab === "saved") loadSaved();
  if (tab === "admin" && account.isAdmin) { renderAdmin(); startAdminRuns(); } else stopAdminRuns();
  if (tab === "companies" && !coLoaded && db) { coLoaded = true; loadCompanies(true); }
  writeHash(S);
}

// ---------- job details panel
let sheetJob = null, sheetReturn = null, detailToken = 0;
const detailCache = new Map(); // job id -> description HTML ("" when the posting has none)

// Inflate a zlib-compressed BLOB from job_details into HTML text.
async function inflate(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(stream).text();
}

// Keep only harmless formatting tags. Everything else is dropped or unwrapped; links must be http(s).
const KEEP = new Set(["P", "BR", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "H1", "H2", "H3", "H4", "H5", "H6", "A", "DIV", "SPAN"]);
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "IMG", "SVG", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "LINK", "META"]);
function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html"); // inert: scripts and images don't run or load
  const walk = (node) => {
    for (const el of [...node.childNodes]) {
      if (el.nodeType !== 1) continue;
      if (DROP.has(el.tagName)) { el.remove(); continue; }
      walk(el);
      if (!KEEP.has(el.tagName)) {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
        continue;
      }
      for (const a of [...el.attributes]) if (!(el.tagName === "A" && a.name === "href")) el.removeAttribute(a.name);
      if (el.tagName === "A") {
        if (/^https?:\/\//i.test(el.getAttribute("href") || "")) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener nofollow"); }
        else el.removeAttribute("href");
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

async function descriptionFor(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  const rows = await query(detailQuery(id));
  const body = rows.length && rows[0].body ? await inflate(rows[0].body) : "";
  detailCache.set(id, body);
  return body;
}

// Fallback for ATSs whose list has no description: ask the site's own function for the posting's text.
async function liveDescription(url) {
  const r = await fetch(`/api/detail?url=${encodeURIComponent(url)}`);
  if (!r.ok) return "";
  return (await r.json()).html || "";
}

async function renderDescription(j) {
  const token = ++detailToken;
  const box = $("#sheet-desc");
  box.innerHTML = '<p class="note">Loading description…</p>';
  try {
    let html = await descriptionFor(j.id);
    if (!html && j.url) html = await liveDescription(j.url).catch(() => "");
    if (token !== detailToken) return;
    box.innerHTML = html
      ? `<h3>About the role</h3><div class="jd-body">${cleanHtml(html)}</div>`
      : '<p class="note">The description isn’t available here yet. Use Apply to read the full posting on the employer’s site.</p>';
  } catch {
    if (token === detailToken) box.innerHTML = '<p class="note">Couldn’t load the description. Use Apply to read the full posting.</p>';
  }
}

function fmtDay(d) { return new Date(d * 86400000).toISOString().slice(0, 10); }
function openSheet(j) {
  if (!j) return;
  sheetJob = j;
  sheetReturn = document.activeElement;
  $("#sheet-title").textContent = j.title;
  $("#sheet-body").innerHTML = [
    ["Company", displayName(j.company)],
    ["Location", j.loc || "Not listed"],
    ["Remote", j.remote ? "Yes" : "No"],
    ["State", j.state || "Not listed"],
    ["Pay", j.pay || "Not listed"],
    ["Source", j.ats],
    ["Posted", j.pd && j.posted != null ? `${fmtDay(j.posted)} (${ago(j.posted)})` : "Not listed by the employer"],
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  $("#sheet-apply").href = j.url;
  $("#sheet").hidden = false;
  updateSheetSave();
  renderDescription(j);
  $("#sheet-close").focus();
}
function closeSheet() {
  $("#sheet").hidden = true;
  sheetJob = null;
  detailToken++;
  if (sheetReturn && sheetReturn.focus) sheetReturn.focus();
}
function updateSheetSave() {
  const b = $("#sheet-save");
  b.hidden = !account.enabled;
  const on = !!sheetJob && account.saved.has(sheetJob.url);
  b.textContent = on ? "Saved" : "Save job";
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
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
  $("#sort").addEventListener("change", () => setJob({ sort: $("#sort").value === "newest" ? "" : $("#sort").value }));
  $("#filters-toggle").addEventListener("click", () => {
    const open = $("#filters").classList.toggle("open");
    $("#filters-toggle").setAttribute("aria-expanded", String(open));
  });
  $("#jobs").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) setJob(Object.fromEntries(JOB_KEYS.map((k) => [k, ""])));
  });
  $("#company-filter").addEventListener("click", (e) => { if (e.target.closest("button")) setJob({ board: "", bname: "" }); });
  const pickBoard = (e) => {
    const b = e.target.closest("button[data-board]");
    if (!b) return;
    e.preventDefault();
    setJob({ board: b.dataset.board, bname: b.dataset.name, q: "", state: "", ats: "", days: "", remote: "", fresh: "", usonly: "" });
    showTab("jobs");
    scrollTo({ top: 0 });
  };
  $("#auth").addEventListener("click", () => (account.user ? signOut() : openSignIn()));
  $("#signin-close").addEventListener("click", () => $("#signin-dialog").close());
  const authMsg = (t) => { $("#signin-msg").textContent = t; };
  const credentials = () => {
    const email = $("#signin-email").value.trim();
    const password = $("#signin-password").value;
    if (!email || !$("#signin-email").checkValidity()) { authMsg("Enter a valid email address."); return null; }
    if (password.length < 8) { authMsg("Use a password of at least 8 characters."); return null; }
    return { email, password };
  };
  $("#signin-pass").addEventListener("click", async () => {
    const c = credentials(); if (!c) return;
    authMsg("Signing in…");
    try {
      await signInWithPassword(c.email, c.password);
      $("#signin-dialog").close();
    } catch (e) {
      authMsg(`Couldn’t sign in: ${e.message || e}`);
    }
  });
  $("#signup-pass").addEventListener("click", async () => {
    const c = credentials(); if (!c) return;
    authMsg("Creating your account…");
    try {
      const r = await signUpWithPassword(c.email, c.password);
      if (r.needsConfirm) authMsg("Account created. Open the confirmation link we emailed you, then sign in.");
      else $("#signin-dialog").close();
    } catch (e) {
      authMsg(`Couldn’t create the account: ${e.message || e}`);
    }
  });
  $("#signin-send").addEventListener("click", async () => {
    const email = $("#signin-email").value.trim();
    const msg = $("#signin-msg");
    if (!email || !$("#signin-email").checkValidity()) { msg.textContent = "Enter a valid email address."; return; }
    msg.textContent = "Sending…";
    try {
      await signInWithEmail(email);
      msg.textContent = "Check your email for the sign-in link.";
    } catch (e) {
      msg.textContent = `Couldn’t send the link: ${e.message || e}`;
    }
  });
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
  $("#jobs").addEventListener("click", (e) => {
    const d = e.target.closest("button[data-detail]");
    if (d) openSheet(jobById.get(Number(d.dataset.detail)));
  });
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });
  $("#sheet-save").addEventListener("click", async () => {
    if (!sheetJob) return;
    const b = $("#sheet-save");
    b.disabled = true;
    try { await toggleSave({ url: sheetJob.url, title: sheetJob.title, company: sheetJob.company, loc: sheetJob.loc }); }
    catch (err) { alert(`Couldn't save: ${err.message || err}`); }
    finally { b.disabled = false; refreshSaveButtons(); updateSheetSave(); }
  });
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
  $("#stats").innerHTML = `${fmt.format(meta.jobs)} US jobs · ${fmt.format(meta.boards_with_jobs)} companies hiring<span class="upd"> · updated ${updated(meta.generated_at)}</span>`;
  for (const s of meta.states) $("#state").insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`);
  for (const [a, v] of Object.entries(meta.by_ats)) {
    if (v.jobs) $("#ats").insertAdjacentHTML("beforeend", `<option>${esc(a)}</option>`);
    $("#cats").insertAdjacentHTML("beforeend", `<option>${esc(a)}</option>`);
  }
  renderCoverage();
  syncJobControls();
  account.onChange = () => { updateAuthUI(); refreshSaveButtons(); updateSheetSave(); if (S.tab === "saved") loadSaved(); };
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
