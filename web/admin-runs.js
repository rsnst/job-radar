// Admin panel: start a sweep, watch its progress, and see recent runs. Talks only to /api/admin/*.
import { accessToken } from "./account.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = new Intl.NumberFormat("en-US");
const box = () => document.getElementById("admin-runs");

let timer = null;
let busy = false;

async function api(path, opts = {}) {
  const token = await accessToken();
  const r = await fetch(path, {
    ...opts,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

function dur(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const TRIGGER = { schedule: "Daily schedule", workflow_dispatch: "Manual", push: "Code push" };

function outcome(r) {
  if (r.status !== "completed") return r.status === "queued" ? "Queued" : "Running";
  return { success: "Succeeded", failure: "Failed", cancelled: "Cancelled", skipped: "Skipped" }[r.conclusion] || r.conclusion;
}

function render(data, notice) {
  const a = data?.active;
  const s = a?.shards;
  let html = `
    <div class="run-head">
      <div><h3>Scrape sweep</h3><p class="note">Full sweep re-checks every board. It takes about 20 minutes.</p></div>
      <button type="button" id="run-sweep" class="btn primary" ${a ? "disabled" : ""}>${a ? "Sweep running" : "Run full sweep"}</button>
    </div>`;
  if (notice) html += `<p class="note notice" role="status">${esc(notice)}</p>`;
  if (a) {
    const seg = (n, cls) => (n ? `<span class="seg ${cls}" style="flex:${n}" title="${n} ${cls}"></span>` : "");
    html += `
      <div class="bar" role="img" aria-label="${s.done} of ${s.total} shards finished">
        ${seg(s.done, "ok")}${seg(s.running, "running")}${seg(s.queued, "queued")}${seg(s.failed, "failed")}
      </div>
      <p class="note">
        <strong>${s.done} of ${s.total}</strong> shards finished · ${s.running} running · ${s.queued} waiting${s.failed ? ` · <span class="bad">${s.failed} failed</span>` : ""}
        · build: ${esc(a.build)} · elapsed ${dur(a.elapsed)}
      </p>`;
  } else {
    html += `<p class="note">No sweep is running.</p>`;
  }
  const rows = (data?.runs || []).map((r) => `
    <tr>
      <td>${when(r.started)}</td>
      <td>${esc(TRIGGER[r.event] || r.event)}</td>
      <td>${esc(outcome(r))}</td>
      <td>${dur(r.seconds)}</td>
      <td><code>${esc(r.sha)}</code></td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener">Log</a></td>
    </tr>`).join("");
  html += `
    <h3 class="hist-title">Recent runs</h3>
    <div class="table-wrap"><table class="runs-table">
      <thead><tr><th>Started</th><th>Trigger</th><th>Result</th><th>Took</th><th>Commit</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">No runs yet.</td></tr>`}</tbody>
    </table></div>`;
  box().innerHTML = html;
}

async function refresh(notice) {
  if (busy) return;
  busy = true;
  try {
    const data = await api("/api/admin/runs");
    render(data, notice);
    schedule(data.active ? 5000 : 60000);
  } catch (e) {
    box().innerHTML = `<p class="note err-note">${esc(e.message || e)}</p>`;
    schedule(60000);
  } finally {
    busy = false;
  }
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => refresh(), ms);
}

export function startAdminRuns() {
  if (!box()) return;
  refresh();
  if (!box().dataset.wired) {
    box().dataset.wired = "1";
    box().addEventListener("click", async (e) => {
      if (!e.target.closest("#run-sweep")) return;
      if (!confirm("Start a full sweep of every board? It takes about 20 minutes.")) return;
      try {
        await api("/api/admin/run", { method: "POST", body: JSON.stringify({ mode: "full" }) });
        await refresh("Sweep started. The progress bar updates as shards finish.");
      } catch (err) {
        await refresh(err.message || String(err));
      }
    });
  }
}

export function stopAdminRuns() {
  clearTimeout(timer);
  timer = null;
}
