# Job Radar

Every open US job on 77,887 company career boards, pulled straight from each company's ATS (Workday, Greenhouse, ADP, Lever, …) and refreshed daily. Search by title, company or city, and filter by state, ATS, remote and posting date. Every result links to the employer's own apply page.

It runs entirely on free GitHub infrastructure, with no server and no database to host:

- **GitHub Actions** refreshes the boards daily across 20 parallel runners: an incremental run (about 12 minutes end to end) six days a week, and a full sweep on Sundays.
- The results are built into one **SQLite** database with full-text search, split into 25 MB chunks.
- **GitHub Pages** serves the chunks. The browser queries the database in place with HTTP range requests ([sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs)), so it downloads only the pages a query touches. Measured on a 1.5M-job, 439 MB build: about 20 KB to show the first 40 jobs, and about 8 MB over a full session of searching.

## Setup (once)

1. Create a repo, push this folder to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Actions → Scrape and deploy → Run workflow.** Set `limit` to `40` for a quick trial (40 boards on each of 20 runners, about 800 total), or `0` for everything.
4. Open `https://<you>.github.io/<repo>/`.

After that it runs every day at 09:17 UTC. Pushing changes under `web/` redeploys the UI in about a minute without re-scraping. The first run has no saved state, so it does a full sweep automatically.

## Daily refresh: incremental runs

A full sweep is about 133k requests. Most of that is re-reading boards that haven't changed, so daily runs skip it:

| | Full sweep (Sundays, or no saved state) | Daily incremental |
|---|---|---|
| Boards empty on their last fetch | fetched | skipped, re-checked once a week |
| Paginated ATSs (Workday, ADP, SmartRecruiters, UKG, Oracle, iCIMS, Workable) | every page | page 1 only; the rest is crawled only if page 1's jobs or the ATS's total count changed |
| Single-request ATSs (Greenhouse, Lever, Ashby, …) | fetched | fetched (one request already returns every job) |
| Requests (estimated from current job counts) | ~133k | ~67k |
| Fetch time per runner (simulated, 1 of 20 shards) | 8–14 min | ~5.5 min |

**What sets the speed.** Each ATS domain gets at most 2 requests/second per runner (4 for Workday, whose tenants are separate sites), so about 40/s across 20 runners. Any 429 response backs off the whole domain. The bottleneck is ADP: about 650 requests per runner on a daily run is about 5.5 minutes. Faster responses don't help; a higher `--rps` would, at the cost of being less polite.

**Time budget.** Daily runners stop starting new requests after 12 minutes. Boards not reached, failed fetches and failed runners keep their previous jobs for up to 3 days, then drop out. The Coverage tab and the run summary on the Actions page show what happened.

**What incremental can miss until Sunday.** A job that closes deep in a big board while another opens there (same total, same page 1). Also a board that was empty and starts hiring: it can wait up to 7 days.

**State** (each board's last result, and the date every job was first seen) is saved in the Actions cache: about 100 MB for 2M jobs. If the cache is evicted, the next run just does a full sweep.

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
scraper/run.py            sharded async runner: full / incremental modes, time budget
scraper/http.py           HTTP client: per-domain rate + concurrency limits, retries, 429 back-off
scraper/state.py          state carried between runs (Actions cache)
scraper/build_db.py       merge this run + last state -> SQLite + FTS5 -> chunks + meta.json
web/                      the app (vanilla JS, no build step)
scripts/serve.py          local server with Range support
scripts/fake_data.py      synthetic jobs for load-testing without network
tests/                    unit tests, incremental-run simulation, e2e browser test
```

## Run locally

```bash
pip install -r requirements.txt && npm ci
python -m scraper.run --ats Greenhouse --limit 100 --out out   # real fetch, 100 boards (full)
# python -m scraper.run --mode incremental --state state ...   # after one build has written state/
python -m scraper.build_db --in out --site site --state state
node scripts/vendor.mjs site
python scripts/serve.py site 8000                               # http://localhost:8000
```

Tests: `pytest tests`, and for the UI `python tests/e2e.py http://localhost:8000` (needs `pip install playwright && playwright install chromium`).

## How "new" works

Each job's first-seen date is carried between runs in the saved state. The app badges jobs first seen today. "New since last visit" uses a timestamp kept in your browser.

## Caveats

- **The adapters were built against each ATS's documented or observed endpoints, but not run against the live sites from the build environment.** Expect a few to need fixes after the first run. The Coverage tab and the Actions log show which ones error, and each adapter is about 20 lines.
- Pagination is capped per board (5–10k jobs) to keep the run polite. Very large Workday tenants may be truncated.
- GitHub's runners use datacenter IPs. If an ATS throttles or blocks them, the timings above stretch out (the 12-minute budget caps the damage) or that ATS's boards fail. The run summary shows rate-limit counts per run. Lower `--rps` if they climb.
- Scheduled workflows can start late when GitHub is busy, often 5–30 minutes.
- GitHub Pages has a ~1 GB site limit. At ~2M jobs the DB is ~600 MB.

## Vercel front end and accounts (optional)

The data stays on GitHub Pages. Vercel serves the UI and proxies `/db/*` and `meta.json` to your Pages site, so the browser makes same-origin requests and needs no CORS setup.

**1. Supabase** (free project, under the Supabase account for sr.jan2997@gmail.com)
- Run `supabase/schema.sql` in the SQL editor.
- Authentication → Providers → enable **Google** (needs a Google OAuth client).
- Authentication → URL configuration: add your Vercel URL to Site URL and Redirect URLs.

**2. Vercel** (Hobby plan, same email)
- Import the GitHub repo `rsnst/job-radar`. The build settings come from `vercel.json`.
- Environment variables (Production and Preview):
  - `SUPABASE_URL`: the project URL
  - `SUPABASE_ANON_KEY`: the anon public key. This is public by design; row-level security protects the data.
- **Never** set `SUPABASE_SERVICE_ROLE_KEY` in Vercel. The build refuses to run if it's present.

**3. Check**
- Open the Vercel URL. The job search should show results (served through the rewrites).
- Sign in, click **Save** on a job, and check the **Saved** tab.

If the GitHub repo name is different from `rsnst/job-radar`, edit the two `destination` URLs in `vercel.json`.

Without the Supabase variables, the site still works as a public search. Sign-in and Save are hidden.
