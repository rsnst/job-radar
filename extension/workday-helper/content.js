(() => {
  "use strict";
  const PROFILE_KEY = "jobCompassProfile";
  const SKIP = /password|captcha|verification|security code|one.time code|gender|race|ethnicity|veteran|disability|consent|terms|signature|social security|\bssn\b|resume|upload|cover letter|references|attest|certify|disclosure/i;

  function norm(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
  function firstLast(fullName) {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    return { first: parts[0] || "", last: parts.length > 1 ? parts.slice(1).join(" ") : "" };
  }
  function fieldLabel(el) {
    const labels = [...(el.labels || [])].map((label) => label.innerText || label.textContent || "");
    return norm([el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id, ...labels].filter(Boolean).join(" "));
  }
  function valuesFor(profile) {
    const p = profile?.profile || {};
    const person = firstLast(p.contact?.fullName);
    const exp = p.experience || [], edu = p.education || [];
    const fields = [
      [/\b(full name|legal name)\b/, p.contact?.fullName],
      [/\b(first name|given name)\b/, person.first], [/\b(last name|family name|surname)\b/, person.last],
      [/\b(email|e mail)\b/, p.contact?.email], [/\b(phone|telephone|mobile)\b/, p.contact?.phone],
      [/\b(address line 1|street address|address 1)\b/, p.address?.street], [/\b(address line 2|address 2|apartment|suite)\b/, p.address?.apt],
      [/\bcity\b/, p.address?.city], [/\b(state|province|region)\b/, p.address?.state],
      [/\b(zip|postal code|postcode)\b/, p.address?.zip], [/\bcountry\b/, p.address?.country],
      [/\b(authorized to work|legally authorized|eligible to work|work authorization)\b/, p.work?.authorizedUS],
      [/\b(require|need|needs) sponsorship\b|\bvisa sponsorship\b/, p.work?.needsSponsorship],
      [/\b(linkedin|linked in)\b/, p.links?.linkedin], [/\b(portfolio|personal website|website url)\b/, p.links?.portfolio],
      [/\b(github)\b/, p.links?.github],
    ];
    for (let i = 0; i < exp.length; i++) {
      fields.push([new RegExp(`\\b(company|employer)\\b(?:.*\\b${i + 1}\\b)?`), exp[i].company]);
      fields.push([new RegExp(`\\b(job title|position title|title)\\b(?:.*\\b${i + 1}\\b)?`), exp[i].title]);
      fields.push([new RegExp(`\\b(description|responsibilities|what you did)\\b(?:.*\\b${i + 1}\\b)?`), exp[i].summary]);
    }
    for (let i = 0; i < edu.length; i++) {
      fields.push([new RegExp(`\\b(school|institution|university)\\b(?:.*\\b${i + 1}\\b)?`), edu[i].school]);
      fields.push([new RegExp(`\\b(degree)\\b(?:.*\\b${i + 1}\\b)?`), edu[i].degree]);
      fields.push([new RegExp(`\\b(field of study|major|area of study)\\b(?:.*\\b${i + 1}\\b)?`), edu[i].field]);
      fields.push([new RegExp(`\\b(graduation year|year of graduation)\\b(?:.*\\b${i + 1}\\b)?`), edu[i].year]);
    }
    return fields.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
  }
  function matchValue(el, profile, used = null) {
    const label = fieldLabel(el);
    if (!label || SKIP.test(label)) return null;
    const matches = valuesFor(profile).filter(([pattern]) => pattern.test(label));
    if (!matches.length) return null;
    const key = matches[0][0].source;
    const index = used ? (used[key] || 0) : 0;
    if (used) used[key] = index + 1;
    return String(matches[Math.min(index, matches.length - 1)][1]).trim();
  }
  function setValue(el, value) {
    if (el.disabled || el.readOnly || !el.getClientRects().length) return false;
    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find((o) => norm(o.label || o.textContent) === norm(value) || norm(o.value) === norm(value));
      if (!option) return false;
      el.value = option.value;
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) return false;
      setter.call(el, value);
      if (el.value !== value) return false;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  function fill(profile) {
    const seen = new Set(), used = {};
    let filled = 0, skipped = 0;
    const inputs = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=password]):not([type=file]):not([type=hidden]), textarea, select")];
    for (const el of inputs) {
      const value = matchValue(el, profile, used);
      if (value === null) continue;
      const key = `${fieldLabel(el)}|${value}`;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      if (setValue(el, value)) filled++;
      else skipped++;
    }
    return { filled, skipped };
  }
  function installPanel() {
    if (document.getElementById("jc-workday-helper")) return;
    const panel = document.createElement("aside");
    panel.id = "jc-workday-helper";
    panel.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;width:270px;padding:14px;border:1px solid #c9c0b4;border-radius:12px;background:#fff;color:#25231f;box-shadow:0 8px 32px #0003;font:14px/1.4 system-ui,sans-serif";
    panel.innerHTML = '<strong>Job Compass · Workday</strong><p id="jc-wd-status" style="margin:8px 0;color:#625e57">Ready when you are.</p><button id="jc-wd-fill" type="button" style="width:100%;padding:9px;border:0;border-radius:7px;background:#5c4833;color:#fff;font:inherit;cursor:pointer">Fill matching fields</button><p style="margin:8px 0 0;font-size:11px;color:#625e57">Review all values. Checkboxes, protected disclosures, passwords, uploads, and submit are left to you.</p>';
    document.documentElement.appendChild(panel);
    panel.querySelector("#jc-wd-fill").addEventListener("click", async () => {
      const status = panel.querySelector("#jc-wd-status");
      const { [PROFILE_KEY]: payload } = await chrome.storage.local.get([PROFILE_KEY]);
      if (!payload?.profile) { status.textContent = "Import your profile in the extension menu first."; return; }
      const result = fill(payload);
      status.textContent = result.filled ? `Filled ${result.filled} fields. Review each one before continuing.` : "No clear matches found. Fill the form manually and check the profile.";
    });
  }
  const host = typeof location === "undefined" ? "" : location.hostname;
  if (host.endsWith("myworkdayjobs.com") || host.endsWith("myworkday.com")) {
    globalThis.JobCompassWorkday = { norm, firstLast, valuesFor, fieldLabel, matchValue, fill };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installPanel, { once: true });
    else installPanel();
    chrome.runtime.onMessage.addListener((request, _sender, reply) => {
      if (request?.type !== "JC_WORKDAY_FILL") return;
      chrome.storage.local.get([PROFILE_KEY], ({ [PROFILE_KEY]: payload }) => {
        if (!payload?.profile) { reply({ message: "Import your profile in the extension menu first." }); return; }
        const result = fill(payload);
        reply({ message: result.filled ? `Filled ${result.filled} fields. Review each one before continuing.` : "No clear matches found. Fill the form manually and check the profile." });
      });
      return true;
    });
  }
})();
