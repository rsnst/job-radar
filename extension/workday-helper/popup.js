const $ = (s) => document.querySelector(s);
const status = $("#status"), message = $("#message"), fill = $("#fill"), clear = $("#clear");
let profile = null;

function usablePayload(data) {
  return data && data.format === "job-compass-workday-profile" && data.version === 1
    && data.profile && typeof data.profile === "object" && !Array.isArray(data.profile);
}
function showProfile(p) {
  profile = p || null;
  const name = profile?.profile?.contact?.fullName || "Profile imported";
  status.textContent = profile ? `${name} · saved only in this browser` : "No profile imported";
  fill.disabled = !profile;
  clear.disabled = !profile;
}
chrome.storage.local.get(["jobCompassProfile"], ({ jobCompassProfile }) => showProfile(jobCompassProfile || null));

$("#file").addEventListener("change", async (event) => {
  message.textContent = "";
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!usablePayload(data)) throw new Error("Choose a Job Compass Workday profile export.");
    await chrome.storage.local.set({ jobCompassProfile: data });
    showProfile(data);
    message.textContent = "Imported locally. Open a Workday application and click Fill matching fields.";
  } catch (error) {
    message.textContent = error.message || "Could not read that profile file.";
  } finally { event.target.value = ""; }
});

fill.addEventListener("click", async () => {
  message.textContent = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/([a-z0-9-]+\.)*(myworkdayjobs|myworkday)\.com\//i.test(tab.url || "")) {
    message.textContent = "Open a Workday jobs page first.";
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "JC_WORKDAY_FILL" });
    message.textContent = result?.message || "Check the page for the fill summary.";
  } catch {
    message.textContent = "Reload the Workday page, then try again.";
  }
});

clear.addEventListener("click", async () => {
  await chrome.storage.local.remove("jobCompassProfile");
  showProfile(null);
  message.textContent = "Removed the locally saved profile.";
});
