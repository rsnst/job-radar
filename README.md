# Job Radar

Every open US job on 77,887 company career boards, pulled straight from each company's ATS (Workday, Greenhouse, ADP, Lever, …) and refreshed daily. Search by title, company or city, and filter by state, ATS, remote and posting date. Every result links to the employer's own apply page.

It runs entirely on free GitHub infrastructure, with no server and no database to host:

- **GitHub Actions** fetches all boards daily in 16 parallel shards.
- The results are built into one **SQLite** database with full-text search, split into 25 MB chunks.
- **GitHub Pages** serves the chunks. The browser queries the database in place with HTTP range requests ([sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs)), so it downloads only the pages a query touches. Measured on a 1.5M-job, 439 MB build: about 20 KB to show the first 40 jobs, and about 8 MB over a full session of searching.

## Setup (once)

1. Create a repo, push this folder to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Actions → Scrape and deploy → Run workflow.** Set `limit` to `50` for a quick trial (50 boards per shard), or `0` for everything.
4. Open `https://<you>.github.io/<repo>/`.

After that it runs every day at 09:17 UTC. Pushing changes under `web/` redeploys the UI in about a minute without re-scraping.

## Coverage

| Fetched (public JSON/HTML feeds) | Listed in Companies only, jobs not indexed yet |
|---|---|
| Workday, ADP (WorkforceNow), Paylocity, SmartRecruiters, Greenhouse, BambooHR, Ashby, Workable, BreezyHR, Lever, Rippling, UKG/UltiPro, JazzHR, iCIMS, Jobvite, Oracle HCM, Pinpoint, Gem, Recruitee | Dayforce, SAP SuccessFactors, Zoho Recruit, Taleo, ADP MyJobs, BrassRing, Phenom, Polymer, Hireology, CareerPlug, Dover |

The **Coverage** tab shows, per ATS, how many boards were fetched, failed or are unsupported on the latest run. Check it after the first run (see the caveat below).

Only jobs located in the US, or with no stated location, are kept. "US confirmed" filters to jobs whose location explicitly parses as US.

## Layout

```
data/boards.csv.gz        the 77,887 boards (company, ATS, board URL)
scraper/adapters.py       one fetcher per ATS -> raw jobs
scraper/location.py       US / non-US / unknown + state parsing
scraper/run.py            sharded async runner (per-host rate limits, retries)
scraper/build_db.py       merge shards -> SQLite + FTS5 -> chunks + meta.json
web/                      the app (vanilla JS, no build step)
scripts/serve.py          local server with Range support
scripts/fake_data.py      synthetic jobs for load-testing without network
tests/                    adapter + location unit tests, e2e browser test
```

## Run locally

```bash
pip install -r requirements.txt && npm ci
python -m scraper.run --ats Greenhouse --limit 100 --out out   # real fetch, 100 boards
python -m scraper.build_db --in out --site site --state state
node scripts/vendor.mjs site
python scripts/serve.py site 8000                               # http://localhost:8000
```

Tests: `pytest tests`, and for the UI `python tests/e2e.py http://localhost:8000` (needs `pip install playwright && playwright install chromium`).

## How "new" works

Each job's first-seen date is carried between runs in `state/first_seen.tsv.gz`, published alongside the site. The app badges jobs first seen today. "New since last visit" uses a timestamp kept in your browser.

## Caveats

- **The adapters were built against each ATS's documented or observed endpoints, but not run against the live sites from the build environment.** Expect a few to need fixes after the first run. The Coverage tab and the Actions log show which ones error, and each adapter is about 20 lines.
- Pagination is capped per board (5–10k jobs) to keep the run polite. Very large Workday tenants may be truncated.
- Requests are rate-limited per host, but heavy daily scraping can still hit an ATS's terms or blocks. Lower `--per-host` in the workflow if you see 429s.
- GitHub Pages has a ~1 GB site limit. At ~2M jobs the DB is ~600 MB.
