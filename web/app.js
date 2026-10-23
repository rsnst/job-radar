import { jobsQuery, boardsQuery, detailQuery, PAGE } from "./query.js";
import { startAdminRuns, stopAdminRuns } from "./admin-runs.js";
import { initApply, renderApplyKit, renderTracker } from "./apply.js";
import { initFlow, openApplyEntry, openFlow, setSignInHandler, takePendingApply } from "./flow.js";
import { setPostingLoader } from "./store.js";
import { initIntake, resumeIntake, startIntake } from "./intake.js";
import { mergeImported, parseResume } from "./resume-parse.js";
import { account, initAccount, toggleSave, signIn, signOut, signInWithEmail, signInWithPassword, signUpWithPassword, listSaved, apiFetch } from "./account.js";

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
        ${j.pay ? `<p class="pay-line" title="Pay listed in the posting">${esc(j.pay)}</p>` : '<p class="pay-line none">Pay not listed</p>'}
      </div>
      ${account.enabled ? saveButton(j) : ""}
    </div>
    <div class="meta">
      <span class="place"${j.loc && !j.us ? ' title="The posting didn\'t say which country"' : ""}>${esc(j.loc || "Location not stated")}</span>
      <span>${esc(j.ats)}</span>
      <span>${posted(j.posted)}</span>
    </div>
    <div class="tags">
      ${isNew ? '<span class="badge new">New</span>' : ""}
      ${j.remote ? '<span class="badge remote">Remote</span>' : ""}
      ${contractOf(j.title) ? `<span class="badge contract">${esc(contractOf(j.title))}</span>` : ""}
    </div>
    <div class="card-foot">
      <button type="button" class="apply" data-apply="${j.id}">Apply<span class="sr-only"> for ${esc(j.title)}</span></button>
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
    if (seq === jobsSeq) {
      const msg = String(e.message || e);
      // "malformed" / I/O errors mean the browser read mismatched pieces of the index, usually just after a refresh publishes
      const stale = /malformed|disk I\/O/i.test(msg);
      $("#jobs").innerHTML = `<li class="err">${stale
        ? 'The job index is refreshing, so this search couldn\'t finish. Reload the page in a minute and try again.'
        : `Query failed: ${esc(msg)}`}</li>`;
    }
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
  $("#resume-open").hidden = !account.user;
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
  for (const t of ["jobs", "companies", "saved", "applications", "coverage", "admin"]) $("#tab-" + t).hidden = t !== tab;
  if (tab === "applications") renderTracker();
  if (tab === "saved") loadSaved();
  if (tab === "admin" && account.isAdmin) { renderAdmin(); startAdminRuns(); } else stopAdminRuns();
  if (tab === "companies" && !coLoaded && db) { coLoaded = true; loadCompanies(true); }
  writeHash(S);
}

// ---------- job details panel
let sheetJob = null, sheetReturn = null, detailToken = 0, sheetDescHtml = "";
const chatHistory = [];
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
  // meta.with_details is set only by builds that include the job_details table. Older builds don't, and
  // querying a missing table is what made the Details panel report "Couldn't load".
  if (meta.with_details == null) return "";
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

// The posting's text for this job: the database when it has it, otherwise the employer's own data.
async function postingText(j) {
  let html = await descriptionFor(j.id).catch(() => "");
  if (!html && j.url) html = await liveDescription(j.url).catch(() => "");
  return html || "";
}

async function renderDescription(j) {
  const token = ++detailToken;
  const box = $("#sheet-desc");
  box.innerHTML = '<p class="note">Loading description…</p>';
  const readPosting = /^https?:\/\//.test(j.url || "")
    ? ` <a href="${esc(j.url)}" target="_blank" rel="noopener">Read the posting on the employer’s site</a>.` : ".";
  const show = (html) => {
    sheetDescHtml = html;
    box.innerHTML = html
      ? `<h3>About the role</h3><div class="jd-body">${cleanHtml(html)}</div>`
      : `<p class="note">The description isn’t available here, so tailoring can’t check it against the posting.${readPosting}</p>`;
  };
  try {
    const html = await postingText(j);
    if (token === detailToken) show(html);
  } catch {
    if (token !== detailToken) return;
    box.innerHTML = `<p class="note">Couldn’t load the description right now.</p><div class="sheet-actions"><button type="button" class="btn" id="desc-retry">Try again</button></div>`;
    $("#desc-retry").addEventListener("click", () => renderDescription(j));
  }
}

function fmtDay(d) { return new Date(d * 86400000).toISOString().slice(0, 10); }

// ---------- job assistant chat
function chatLine(role, text) {
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.textContent = text; // model output is shown as plain text, never as HTML
  $("#chat-log").appendChild(div);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
}

function showSuggestions() {
  const log = $("#chat-log");
  log.innerHTML = "";
  if (!account.user) {
    chatLine("assistant", "Sign in to use the assistant. It's free.");
    return;
  }
  const picks = sheetJob
    ? ["Summarize this job in three bullets", "What skills does this job need?", "Is this job likely to sponsor a visa?", "Draft two lines I can use to introduce myself"]
    : ["How should I search for .NET roles?", "What should I put in my resume summary?", "How do I find jobs that offer sponsorship?"];
  const wrap = document.createElement("div");
  wrap.className = "chat-suggest";
  for (const text of picks) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", () => {
      $("#chat-input").value = text;
      $("#chat-form").requestSubmit();
    });
    wrap.appendChild(b);
  }
  log.appendChild(wrap);
}

function openChat() {
  $("#chat").hidden = false;
  $("#chat-open").setAttribute("aria-expanded", "true");
  $("#chat-context").textContent = sheetJob
    ? `Reading: ${sheetJob.title}`
    : "Ask anything about jobs or your search.";
  if (!$("#chat-log").children.length) showSuggestions();
  $("#chat-input").focus();
}

function closeChat() {
  $("#chat").hidden = true;
  $("#chat-open").setAttribute("aria-expanded", "false");
  $("#chat-open").focus();
}

async function sendChat(e) {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (!account.user) { chatLine("assistant", "Sign in to use the assistant."); return; }
  input.value = "";
  $("#chat-log .chat-suggest")?.remove();
  chatLine("user", text);
  chatHistory.push({ role: "user", content: text });
  const send = $("#chat-send");
  send.disabled = true;
  chatLine("assistant pending", "Thinking…");
  try {
    const { ok, data } = await apiFetch("/api/chat", { method: "POST", body: {
      messages: chatHistory.slice(-10),
      title: sheetJob?.title || "",
      description: sheetJob ? sheetDescHtml : "",
      useResume: $("#chat-resume").checked,
    } });
    const reply = ok ? data.reply : (data.error || "The assistant didn't answer. Try again.");
    if (ok) chatHistory.push({ role: "assistant", content: reply });
    else chatHistory.pop();
    $("#chat-log .pending")?.remove();
    chatLine("assistant", reply);
  } catch {
    chatHistory.pop();
    $("#chat-log .pending")?.remove();
    chatLine("assistant", "The assistant didn't answer. Check your connection and try again.");
  } finally {
    send.disabled = false;
    input.focus();
  }
}

// ---------- AI fit check and the resume dialog
const fitBox = () => $("#sheet-fit");
const fitNote = (t) => `<p class="note">${esc(t)}</p>`;

function renderFit(j) {
  const box = fitBox();
  box.innerHTML = "";
  box.hidden = !account.enabled;
  if (!account.enabled) return;
  if (!account.user) {
    box.innerHTML = `<h3>How well do you fit?</h3><p><button type="button" class="link" id="fit-signin">Sign in</button> to check this job against your resume.</p>`;
    return;
  }
  box.innerHTML = `<h3>How well do you fit?</h3>
    <div class="sheet-actions">
      <button type="button" class="btn primary" id="fit-check">Check my fit</button>
      <button type="button" class="btn" id="fit-edit">My resume</button>
    </div>
    <div id="fit-result" aria-live="polite"></div>`;
}

function renderFitResult(r) {
  const li = (xs) => xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  return `<p class="score">${esc(String(r.score))}/100</p>
    <p>${esc(r.summary || "")}</p>
    ${r.matched.length ? `<h3>You match</h3>${li(r.matched)}` : ""}
    ${r.missing.length ? `<h3>Not on your resume</h3>${li(r.missing)}` : ""}
    ${r.evidence.length ? `<h3>From the posting</h3>${r.evidence.map((q) => `<blockquote>“${esc(q)}”</blockquote>`).join("")}` : ""}
    <p class="note">${r.cached ? "Saved from an earlier check. " : ""}AI can be wrong. Check the posting before you decide.</p>`;
}

async function runFitCheck() {
  const job = sheetJob;
  if (!job) return;
  const out = $("#fit-result");
  const btn = $("#fit-check");
  btn.disabled = true; btn.textContent = "Checking…";
  out.innerHTML = fitNote("Comparing your resume with this job…");
  try {
    let html = sheetDescHtml;
    if (!html) html = await descriptionFor(job.id);
    if (!html && job.url) html = await liveDescription(job.url).catch(() => "");
    const { ok, status, data } = await apiFetch("/api/fit", { method: "POST", body: { url: job.url, title: job.title, description: html || "" } });
    if (job !== sheetJob) return;
    if (status === 409 && data.needsProfile) { out.innerHTML = fitNote("Add your resume first."); showProfile(); return; }
    out.innerHTML = ok ? renderFitResult(data) : fitNote(data.error || "The check didn't work. Try again.");
  } catch {
    if (job === sheetJob) out.innerHTML = fitNote("The check didn't work. Try again.");
  } finally {
    if (job === sheetJob) { btn.disabled = false; btn.textContent = "Check my fit"; }
  }
}

function setProfileMsg(t) { $("#profile-msg").textContent = t; }
function updateProfileCount() { $("#profile-count").textContent = $("#profile-text").value.length.toLocaleString(); }

// ---------- full profile: contact, links, work authorization, experience, education, skills, summary
const ROW_FIELDS = {
  exp: [["company", "Company"], ["title", "Title"], ["start", "Start", "2021-03"], ["end", "End", "2024-06"],
        ["current", "I work here now", "", "check"], ["summary", "What you did", "", "area"]],
  edu: [["school", "School"], ["degree", "Degree"], ["field", "Field of study"], ["gpa", "GPA (optional)"], ["year", "Graduation year"]],
  ref: [["name", "Name"], ["title", "Title"], ["company", "Company"], ["email", "Email"], ["phone", "Phone"]],
  qa: [["question", "Question", "", "area"], ["answer", "Your answer", "", "area"]],
};
const ROW_LISTS = { exp: "pf-exp", edu: "pf-edu", ref: "pf-ref", qa: "pf-qa" };
const ROW_DATA = { exp: "experience", edu: "education", ref: "references", qa: "custom" };
const TEXT_LISTS = ["skills", "certifications", "languages"];

function profileRow(kind, item = {}) {
  const row = document.createElement("div");
  row.className = "pf-row";
  const fields = ROW_FIELDS[kind].map(([k, label, ph = "", type = ""]) => {
    if (type === "check") return `<label class="pf-check wide"><input type="checkbox" data-k="${k}" ${item[k] ? "checked" : ""}> ${label}</label>`;
    if (type === "area") return `<label class="pf-field wide"><span>${label}</span><textarea data-k="${k}" rows="2">${esc(item[k] || "")}</textarea></label>`;
    return `<label class="pf-field"><span>${label}</span><input data-k="${k}" placeholder="${esc(ph)}" value="${esc(item[k] || "")}"></label>`;
  });
  row.innerHTML = `<div class="pf-grid">${fields.join("")}</div><button type="button" class="link pf-remove">Remove</button>`;
  row.querySelector(".pf-remove").addEventListener("click", () => row.remove());
  return row;
}

function readRows(container, kind) {
  const keys = ROW_FIELDS[kind].map((f) => f[0]);
  return [...container.querySelectorAll(".pf-row")].map((row) => {
    const o = {};
    for (const k of keys) {
      const el = row.querySelector(`[data-k="${k}"]`);
      o[k] = !el ? "" : el.type === "checkbox" ? el.checked : el.value.trim();
    }
    return o;
  });
}

const ARRAY_FIELDS = ["skills", "certifications", "languages", "autoApply.keywords", "autoApply.excludeKeywords", "autoApply.companies", "autoApply.excludeCompanies", "autoApply.locations"];
const getPath = (o, path) => path.split(".").reduce((v, p) => v?.[p], o);
function setPath(o, path, value) {
  const parts = path.split(".");
  let t = o;
  for (const p of parts.slice(0, -1)) t = t[p] = t[p] || {};
  t[parts[parts.length - 1]] = value;
}

function fillProfileForm(d) {
  for (const el of $("#profile-form").querySelectorAll("[name]")) {
    const v = getPath(d, el.name);
    if (el.type === "checkbox") { el.checked = v === true || (el.name === "autoApply.remoteOk" && v === undefined); continue; }
    if (ARRAY_FIELDS.includes(el.name)) { el.value = (v || []).join(", "); continue; }
    el.value = v ?? "";
  }
  for (const kind of Object.keys(ROW_LISTS)) {
    $(`#${ROW_LISTS[kind]}`).replaceChildren(...(d[ROW_DATA[kind]] || []).map((item) => profileRow(kind, item)));
  }
}

function readProfileForm() {
  const out = {};
  for (const el of $("#profile-form").querySelectorAll("[name]")) {
    if (el.type === "checkbox") { setPath(out, el.name, el.checked); continue; }
    if (el.name === "autoApply.minSalary") { setPath(out, el.name, Number(el.value) || 0); continue; }
    if (ARRAY_FIELDS.includes(el.name)) { setPath(out, el.name, el.value.split(",")); continue; }
    setPath(out, el.name, el.value.trim());
  }
  for (const kind of Object.keys(ROW_LISTS)) {
    out[ROW_DATA[kind]] = readRows($(`#${ROW_LISTS[kind]}`), kind);
  }
  return out;
}

async function saveProfileDetails() {
  setProfileMsg("Saving profile…");
  const { ok, data } = await apiFetch("/api/profile-details", { method: "PUT", body: { data: readProfileForm() } });
  if (!ok) { setProfileMsg(data.error || "Couldn't save your profile."); return; }
  fillProfileForm(data.data || {});
  setProfileMsg("Profile saved.");
}

async function showProfile() {
  setProfileMsg("Loading…");
  $("#profile-dialog").showModal();
  const [details, resume] = await Promise.all([apiFetch("/api/profile-details"), apiFetch("/api/profile")]);
  if (details.ok) fillProfileForm(details.data.data || {});
  if (!resume.ok) { setProfileMsg(resume.data.error || "Couldn't load your resume."); return; }
  $("#profile-text").value = resume.data.text || "";
  updateProfileCount();
  setProfileMsg(resume.data.text ? "" : "Fill in what you can, add your resume, then save.");
  $("#profile-form").scrollTop = 0;
}

async function saveProfile(text) {
  setProfileMsg("Saving…");
  const { ok, data } = await apiFetch("/api/profile", { method: "PUT", body: { text } });
  if (!ok) { setProfileMsg(data.error || "Couldn't save your resume."); return false; }
  $("#profile-text").value = data.text || "";
  updateProfileCount();
  setProfileMsg(data.text ? "Saved." : "Deleted.");
  return true;
}

// Resume files are read in the browser; the server only stores the resulting text.
const RESUME_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_LIBS = {
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  docx: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
};
const loadedLibs = {};
function loadScript(src) {
  if (!loadedLibs[src]) loadedLibs[src] = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.async = true; el.onload = resolve;
    el.onerror = () => { delete loadedLibs[src]; reject(new Error("load")); };
    document.head.appendChild(el);
  });
  return loadedLibs[src];
}

async function textFromPdf(file) {
  await loadScript(RESUME_LIBS.pdf);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = RESUME_LIBS.pdfWorker;
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    let line = "", out = "";
    for (const item of content.items) {
      if (item.hasEOL) { out += line + "\n"; line = ""; }
      line += item.str + (item.hasEOL ? "" : " ");
    }
    pages.push(out + line);
  }
  return pages.join("\n\n");
}

async function textFromDocx(file) {
  await loadScript(RESUME_LIBS.docx);
  const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}

function cleanResumeText(t) {
  return String(t || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readResumeFile(file) {
  if (!file) return;
  const name = file.name || "file";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const isPdf = file.type === "application/pdf" || ext === "pdf";
  const isDocx = ext === "docx" || file.type.includes("wordprocessingml");
  const isText = ext === "txt" || ext === "md" || file.type.startsWith("text/");
  if (!isPdf && !isDocx && !isText) {
    setProfileMsg("That file type isn't supported. Use PDF, Word (.docx), or a text file, or paste the text.");
    return;
  }
  if (file.size > RESUME_MAX_BYTES) {
    setProfileMsg("That file is over 5 MB. Try a smaller PDF, or paste the text.");
    return;
  }
  setProfileMsg(`Reading ${name}…`);
  try {
    const raw = isPdf ? await textFromPdf(file) : isDocx ? await textFromDocx(file) : await file.text();
    const text = cleanResumeText(raw);
    if (text.length < 40) {
      setProfileMsg(isPdf
        ? "No text found in that PDF. It may be a scan. Try a Word file or paste the text."
        : "That file has almost no text. Try another file or paste the text.");
      return;
    }
    const clipped = text.length > 20000;
    $("#profile-text").value = clipped ? text.slice(0, 20000) : text;
    updateProfileCount();
    setProfileMsg(`Read ${name}. Check the text below, then save it, or choose Fill profile from this resume.` + (clipped ? " It was trimmed to 20,000 characters." : ""));
    $("#profile-text").focus();
  } catch {
    setProfileMsg("Couldn't read that file. Try another format, or paste the text.");
  }
}

// Copies what the resume text says into blank profile fields. Nothing is saved until the person saves.
function importFromResume() {
  const text = $("#profile-text").value;
  if (text.trim().length < 40) return setProfileMsg("Add your resume first: upload a file or paste the text above.");
  const { data, found } = parseResume(text);
  if (!found.length) return setProfileMsg("Couldn't find profile details in that text. Fill them in by hand.");
  const form = $("#profile-form");
  const before = new Map([...form.querySelectorAll("[name]")].map((el) => [el, el.type === "checkbox" ? el.checked : el.value]));
  const listWasEmpty = Object.fromEntries(Object.keys(ROW_LISTS).map((k) => [k, !$(`#${ROW_LISTS[k]}`).children.length]));
  const { profile, filled } = mergeImported(readProfileForm(), data);
  if (!filled.length) return setProfileMsg("Everything this resume says is already in your profile. Nothing changed.");
  fillProfileForm(profile);
  for (const el of form.querySelectorAll("[name]")) {
    const now = el.type === "checkbox" ? el.checked : el.value;
    if (now !== before.get(el)) { el.classList.add("imported"); el.addEventListener("input", () => el.classList.remove("imported"), { once: true }); }
  }
  for (const k of Object.keys(ROW_LISTS)) if (listWasEmpty[k]) for (const row of $(`#${ROW_LISTS[k]}`).children) row.classList.add("imported");
  setProfileMsg(`Filled ${filled.length} blank section${filled.length === 1 ? "" : "s"} from your resume (${found.join(", ")}). Highlighted fields are new: check them, then choose Save profile. Existing entries weren't changed. Work authorization, EEO and salary are never read from a resume.`);
}

function setupResumeUpload() {
  const drop = $("#resume-drop");
  const input = $("#profile-file");
  input.addEventListener("change", () => { readResumeFile(input.files[0]); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => readResumeFile(e.dataTransfer.files[0]));
}

function openSheet(j) {
  if (!j) return;
  sheetJob = j;
  sheetReturn = document.activeElement;
  sheetDescHtml = "";
  $("#sheet-title").textContent = j.title;
  $("#sheet-body").innerHTML = [
    ["Company", displayName(j.company)],
    ["Location", j.loc || "Not listed"],
    ["Remote", j.remote ? "Yes" : "No"],
    ["State", j.state || "Not listed"],
    ["Pay", j.pay || "Not listed"],
    ["Source", j.ats],
    ["Posted", j.posted != null ? `${fmtDay(j.posted)} (${ago(j.posted)})` : "Not listed"],
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  $("#sheet").hidden = false;
  updateSheetSave();
  renderDescription(j);
  renderFit(j);
  renderApplyKit(j);
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
  $("#sheet-fit").addEventListener("click", (e) => {
    const id = e.target.id;
    if (id === "fit-signin") signIn();
    else if (id === "fit-check") runFitCheck();
    else if (id === "fit-edit") showProfile();
  });
  $("#profile-text").addEventListener("input", updateProfileCount);
  $("#chat-open").addEventListener("click", openChat);
  $("#chat-close").addEventListener("click", closeChat);
  $("#chat-form").addEventListener("submit", sendChat);
  $("#profile-import").addEventListener("click", importFromResume);
  $("#profile-save").addEventListener("click", () => saveProfile($("#profile-text").value.trim()));
  $("#profile-delete").addEventListener("click", () => { if (confirm("Delete your resume? This can't be undone.")) saveProfile(""); });
  $("#profile-close").addEventListener("click", () => $("#profile-dialog").close());
  setupResumeUpload();
  $("#resume-open").addEventListener("click", showProfile);
  $("#pf-save").addEventListener("click", saveProfileDetails);
  setPostingLoader((job) => (job.id != null ? postingText(job) : liveDescription(job.url).catch(() => "")));
  setSignInHandler(() => openSignIn());
  initApply();
  initFlow();
  initIntake({ openSignIn, openApply: openApplyEntry, showTab });
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
    const kind = b.dataset.add;
    $(`#${ROW_LISTS[kind]}`).appendChild(profileRow(kind));
  }));
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
    const a = e.target.closest("button[data-apply]");
    if (a) openApplyEntry(jobById.get(Number(a.dataset.apply)));
  });
  $("#sheet-apply").addEventListener("click", () => { if (sheetJob) openApplyEntry(sheetJob); });
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
  document.addEventListener("keydown", (e) => {
    // Escape closes the dialog on top first. The details panel closes only when no dialog is open.
    if (e.key === "Escape" && !$("#sheet").hidden && !document.querySelector("dialog[open]")) closeSheet();
  });
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
  account.onChange = () => {
    updateAuthUI(); refreshSaveButtons(); updateSheetSave();
    if (S.tab === "saved") loadSaved();
    if (S.tab === "applications") renderTracker();
    // Someone who chose a job, signed in, and came back returns to that job's application.
    const pending = account.user ? takePendingApply() : null;
    if (pending) openFlow(pending); else resumeIntake();
  };
  // The add-a-job dialog waits for accounts to be ready, so it knows whether to ask for sign-in.
  initAccount().then(() => { updateAuthUI(); refreshSaveButtons(); }).finally(startIntake);
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
// The app shell works offline and installs on a phone. The job database and every /api call always go to the network.
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
