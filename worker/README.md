# Job Compass application worker

This is the app-owned browser worker used by the Apply flow. It runs separately from the static/Vercel web UI because ATS pages are cross-origin and a normal web page cannot control them. It polls `public.application_runs`, opens supported Workday links in a private Chromium context, fills clear profile matches, uploads the saved tailored resume, and either waits for an in-app approval or submits when the user explicitly enabled hands-free submission in My profile.

## First-release limits

- Workday links on `*.myworkdayjobs.com` and `*.myworkday.com` only.
- Account creation, sign-in and email verification are opt-in (My profile → “Create employer accounts for me”). Without the opt-in, or without the settings below, the worker stops at the account page.
- Verified only against mock pages in `worker/test/`. Real Workday tenants vary; expect to adjust selectors after a supervised first run.
- A terms box on an account sign-up stops the run unless the user also turned on "Accept the employer's account terms for me"; that opt-in ticks only a plain terms/privacy box and records it on the run. Other legal checkboxes always stop.
- CAPTCHA/security checks, required checkboxes/attestations, and unknown required answers stop the run. It does not bypass them or guess.
- The worker keeps the browser session open while an application awaits approval. Run one worker instance per deployment; if the process restarts, the user may need to retry the run.
- Do not expose the Supabase service-role key to the browser or frontend.

## Configure

1. Apply `supabase/application_runs.sql` to the same Supabase project as Job Compass.
2. Build the worker image from the repository root:

   ```sh
   docker build -f worker/Dockerfile -t job-compass-worker .
   ```

3. For account creation and email verification, also apply `supabase/employer_accounts.sql`, then set:
   - `CREDENTIAL_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). Losing it makes stored passwords unreadable; leaking it exposes them. Keep it only on the worker.
   - `INBOX_DOMAIN`: a domain whose inbound mail your provider forwards (as JSON) to the worker's `POST /inbound`.
   - `INBOUND_SECRET`: shared secret the provider sends as `Authorization: Bearer ...` (or the Basic-auth password). `INBOUND_PORT` defaults to 8787; put it behind HTTPS.
   - Optional: `CHROMIUM_PATH` (use an existing Chromium), `VERIFY_WAIT_MS` (default 120000).

4. Run one private worker container with the backend-only environment variables:

   ```sh
   docker run --restart unless-stopped \
     -e SUPABASE_URL='https://YOUR_PROJECT.supabase.co' \
     -e SUPABASE_SERVICE_ROLE_KEY='YOUR_SERVICE_ROLE_KEY' \
     job-compass-worker
   ```

The only listener is the optional inbound-mail webhook (enabled when `INBOUND_SECRET` and `INBOX_DOMAIN` are set). Logs contain run IDs and error summaries, not profile values or credentials. Workday URLs are host-checked before navigation.

## Read-only probe

`node src/probe.js <workday-job-url> [--deep]` opens a Workday job page and reports what the worker would recognise
(Apply button, sign-in vs create-account form, CAPTCHA, and how each checkbox is classified). It never types,
signs in, creates an account or submits. `--deep` only clicks "Apply" / "Apply Manually" (navigation) to reach the
sign-up screen and stops there. It exits with a list of any non-GET requests the page made (expected: none).
