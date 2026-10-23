// Runs in the Workday page. Only clear text/select matches are filled. Checkboxes,
// passwords, protected disclosures, attestations, CAPTCHA and unknown questions stay untouched.
export async function fillWorkdayPage(page, profile) {
  return page.evaluate((p) => {
    const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    const skip = /password|captcha|verification|security code|one time code|gender|race|ethnicity|veteran|disability|consent|terms|signature|social security|\bssn\b|attest|certify|disclosure/i;
    const nameParts = String(p.contact.fullName || "").trim().split(/\s+/).filter(Boolean);
    const first = nameParts[0] || "", last = nameParts.slice(1).join(" ");
    const values = [
      [/\b(full name|legal name)\b/, p.contact.fullName], [/\b(first name|given name)\b/, first], [/\b(last name|family name|surname)\b/, last],
      [/\b(email|e mail)\b/, p.contact.email], [/\b(phone|telephone|mobile)\b/, p.contact.phone],
      [/\b(address line 1|street address|address 1)\b/, p.address.street], [/\b(address line 2|address 2|apartment|suite)\b/, p.address.apt],
      [/\bcity\b/, p.address.city], [/\b(state|province|region)\b/, p.address.state], [/\b(zip|postal code|postcode)\b/, p.address.zip], [/\bcountry\b/, p.address.country],
      [/\b(authorized to work|legally authorized|eligible to work|work authorization)\b/, p.work.authorizedUS],
      [/\b(require|need|needs) sponsorship\b|\bvisa sponsorship\b/, p.work.needsSponsorship],
      [/\blinkedin\b/, p.links.linkedin], [/\b(github)\b/, p.links.github], [/\b(portfolio|personal website|website url)\b/, p.links.portfolio],
    ].filter(([, v]) => v !== undefined && v !== null && String(v).trim());
    for (const e of p.experience || []) {
      values.push([/\b(company|employer)\b/, e.company]);
      values.push([/\b(job title|position title)\b/, e.title]);
      values.push([/\b(description|responsibilities|what you did)\b/, e.summary]);
    }
    for (const e of p.education || []) {
      values.push([/\b(school|institution|university)\b/, e.school]);
      values.push([/\bdegree\b/, e.degree]);
      values.push([/\b(field of study|major|area of study)\b/, e.field]);
      values.push([/\b(graduation year|year of graduation)\b/, e.year]);
    }
    const els = [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="password"]):not([type="file"]):not([type="hidden"]),textarea,select')];
    const used = new Map(), filled = [], missing = [];
    const labelOf = (el) => norm([el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id,
      ...(el.labels ? [...el.labels].map((x) => x.innerText || x.textContent || "") : [])].filter(Boolean).join(" "));
    for (const el of els) {
      const label = labelOf(el);
      const required = el.required || el.getAttribute("aria-required") === "true" || el.closest("[aria-required=true]");
      if (!label || skip.test(label) || el.disabled || el.readOnly || !el.getClientRects().length) continue;
      const hits = values.filter(([rx, v]) => rx.test(label) && v !== undefined && v !== null && String(v).trim());
      if (!hits.length) { if (required && !String(el.value || "").trim()) missing.push(label); continue; }
      const key = hits[0][0].source, n = used.get(key) || 0; used.set(key, n + 1);
      const value = String(hits[Math.min(n, hits.length - 1)][1]).trim();
      if (el instanceof HTMLSelectElement) {
        const option = [...el.options].find((o) => norm(o.label || o.textContent) === norm(value) || norm(o.value) === norm(value));
        if (!option) { if (required) missing.push(label); continue; }
        el.value = option.value;
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (!setter) { if (required) missing.push(label); continue; }
        setter.call(el, value);
      }
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      if (String(el.value) === value) filled.push({ label, value });
      else if (required) missing.push(label);
    }
    // Work authorization and sponsorship are structured profile answers, so clear
    // yes/no radio groups can be filled. Other radio questions stay for the user.
    const radios = [...document.querySelectorAll('input[type="radio"]:not(:disabled)')];
    const groups = new Map();
    for (const radio of radios) {
      if (!radio.getClientRects().length) continue;
      const key = radio.name || radio.id;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(radio);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const question = norm([
        first.closest("fieldset")?.querySelector("legend")?.textContent,
        first.getAttribute("aria-label"), first.getAttribute("name"),
        first.closest("[role=radiogroup]")?.getAttribute("aria-label"),
      ].filter(Boolean).join(" "));
      const required = group.some((el) => el.required || el.getAttribute("aria-required") === "true" || el.closest("[aria-required=true]"));
      const target = /authorized to work|eligible to work|work authorization|legally authorized/.test(question)
        ? p.work.authorizedUS
        : /need.*sponsorship|require.*sponsorship|visa sponsorship/.test(question) ? p.work.needsSponsorship : "";
      if (target !== "yes" && target !== "no") { if (required) missing.push(question || "Required radio answer"); continue; }
      const option = group.find((el) => {
        const text = norm([el.value, el.getAttribute("aria-label"), ...(el.labels ? [...el.labels].map((x) => x.textContent) : [])].filter(Boolean).join(" "));
        return target === "yes" ? /(^| )(yes|authorized|eligible)( |$)/.test(text) && !/not authorized|no /.test(text)
          : /(^| )(no|not authorized|not eligible)( |$)/.test(text);
      });
      if (!option) { if (required) missing.push(question || "Required radio answer"); continue; }
      option.click();
      if (option.checked) filled.push({ label: question || "Work authorization", value: target });
      else if (required) missing.push(question || "Required radio answer");
    }
    const unique = new Map(filled.map((x) => [x.label, x]));
    return { filled: [...unique.values()], missing: [...new Set(missing)] };
  }, profile);
}

