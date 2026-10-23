import { pickJob, addLink, validAppUrl } from "./pick.js";

const DEFAULT_APP = "https://job-radar-tan.vercel.app";
const $ = (id) => document.getElementById(id);
const store = chrome.storage?.local;

// Runs inside the open page. It only reads: the JobPosting data, the main heading and the page title.
function snapshot() {
  const meta = (p) => document.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.content || "";
  return {
    url: location.href, title: document.title, h1: document.querySelector("h1")?.innerText || "",
    ogTitle: meta("og:title"), siteName: meta("og:site_name"),
    jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.slice(0, 200000)).slice(0, 10),
  };
}

async function main() {
  const saved = (await store.get("appUrl")).appUrl || DEFAULT_APP;
  $("app").value = saved;
  $("app").addEventListener("change", () => { if (validAppUrl($("app").value)) store.set({ appUrl: $("app").value.trim() }); });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:/.test(tab.url || "")) { $("msg").textContent = "Open a job posting on an https page, then click the icon again."; return; }
  let snap;
  try { [{ result: snap }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshot }); }
  catch { $("msg").textContent = "Couldn't read this page. Open the job posting itself and try again."; return; }
  const job = pickJob(snap);
  $("t").value = job.title; $("c").value = job.company; $("u").value = job.url;
  $("src").textContent = `Read from the ${job.source}. Check the title and company.`;
  $("form").hidden = false; $("msg").textContent = "";
  $("add").addEventListener("click", () => {
    const app = $("app").value.trim() || DEFAULT_APP;
    if (!validAppUrl(app)) { $("msg").textContent = "The Job Compass address must start with https://"; $("msg").className = "note err"; return; }
    chrome.tabs.create({ url: addLink(app, { ...job, title: $("t").value.trim(), company: $("c").value.trim() }) });
    window.close();
  });
}
main();
