"""Headless-browser smoke test of the built site.

    python scripts/serve.py site 8765 &
    python tests/e2e.py http://localhost:8765 screenshots/
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
out = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
out.mkdir(parents=True, exist_ok=True)
errors: list[str] = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        errors.append(msg)


def settle(pg, sel="#jobs"):
    pg.wait_for_function(
        f"""() => document.querySelectorAll('{sel} .card, {sel} .empty, {sel} .err').length
                 && !document.querySelector('{sel} .skeleton')""", timeout=60000)


def titles(pg):
    return pg.eval_on_selector_all("#jobs .card .t", "els => els.map(e => e.textContent.trim())")


def run(width, height, mobile, tag):
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": width, "height": height}, is_mobile=mobile,
                            device_scale_factor=2 if mobile else 1, has_touch=mobile)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        pg.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text[:200]}"))
        net = {"bytes": 0, "reqs": 0}

        def on_resp(r):
            if "/db/db.sqlite3." in r.url:
                net["reqs"] += 1
                try:
                    net["bytes"] += len(r.body())
                except Exception:
                    pass
        pg.on("response", on_resp)

        pg.goto(base)
        settle(pg)
        check(len(titles(pg)) == 40, f"[{tag}] latest jobs load (40)")
        check("US jobs" in pg.inner_text("#stats"), f"[{tag}] stats line")
        print(f"     first paint: {net['reqs']} range requests, {net['bytes'] // 1024} KB of DB")
        pg.screenshot(path=str(out / f"{tag}-1-latest.png"))

        pg.fill("#q", ".net developer")
        pg.wait_for_timeout(900)
        settle(pg)
        t = titles(pg)
        check(t and all(".net" in x.lower() for x in t), f"[{tag}] search '.net developer' -> {len(t)} .NET titles")

        pg.select_option("#state", "TX")
        pg.wait_for_timeout(400)
        settle(pg)
        metas = pg.eval_on_selector_all("#jobs .card .meta", "els => els.map(e => e.textContent)")
        check(metas and all("TX" in m for m in metas), f"[{tag}] state=TX filter ({len(metas)} rows)")
        check("state=TX" in pg.evaluate("location.hash"), f"[{tag}] filters persisted in URL")

        pg.select_option("#days", "7")
        pg.wait_for_timeout(400)
        settle(pg)
        check(len(titles(pg)) > 0, f"[{tag}] posted past week + search + state")
        pg.screenshot(path=str(out / f"{tag}-2-search.png"))

        pg.click("#reset")
        pg.wait_for_timeout(400)
        settle(pg)
        pg.evaluate("scrollTo(0, document.body.scrollHeight)")
        try:
            pg.wait_for_function("document.querySelectorAll('#jobs .card').length >= 80", timeout=30000)
        except Exception:
            pass
        links = pg.eval_on_selector_all("#jobs .card .t a", "a => a.map(x => x.href)")
        check(len(links) >= 80, f"[{tag}] infinite scroll loads page 2 ({len(links)})")
        check(len(set(links)) == len(links), f"[{tag}] no duplicate jobs across pages")

        pg.evaluate("scrollTo(0, 0)")
        pg.click("#jobs .card .co button")
        pg.wait_for_timeout(400)
        settle(pg)
        cos = set(pg.eval_on_selector_all("#jobs .card .co button", "b => b.map(x => x.textContent)"))
        pill = pg.inner_text("#company-filter")
        check(len(cos) == 1 and pill.startswith(next(iter(cos))), f"[{tag}] company drill-down: {cos}")

        pg.click('.tabs button[data-tab="companies"]')
        settle(pg, "#companies")
        check(len(pg.query_selector_all("#companies .card")) == 40, f"[{tag}] companies list loads")
        pg.fill("#cq", "bank")
        pg.wait_for_timeout(900)
        settle(pg, "#companies")
        names = pg.eval_on_selector_all("#companies .card .t", "e => e.map(x => x.textContent)")
        check(names and all("bank" in n.lower() for n in names), f"[{tag}] company search 'bank' ({len(names)})")
        pg.screenshot(path=str(out / f"{tag}-3-companies.png"))

        pg.click('.tabs button[data-tab="coverage"]')
        check(len(pg.query_selector_all("#coverage tbody tr")) > 20, f"[{tag}] coverage table")
        pg.screenshot(path=str(out / f"{tag}-4-coverage.png"), full_page=True)

        overflow = pg.evaluate("document.documentElement.scrollWidth > innerWidth + 1")
        check(not overflow, f"[{tag}] no horizontal page scroll")

        pg.emulate_media(color_scheme="dark")
        pg.click('.tabs button[data-tab="jobs"]')
        pg.wait_for_timeout(300)
        pg.screenshot(path=str(out / f"{tag}-5-dark.png"))
        print(f"     total: {net['reqs']} range requests, {net['bytes'] // 1024} KB of DB")
        b.close()


run(390, 844, True, "mobile")
run(1280, 860, False, "desktop")
if errors:
    print("\n".join(errors))
    sys.exit(1)
print("ALL PASSED")
