# Job Compass application worker

This is the app-owned browser worker used by the Apply flow. It runs separately from the static/Vercel web UI because ATS pages are cross-origin and a normal web page cannot control them. It polls `public.application_runs`, opens supported Workday links in a private Chromium context, fills clear profile matches, uploads the saved tailored resume, and either waits for an in-app approval or submits when the user explicitly enabled hands-free submission in My profile.

## First-release limits

- Workday links on `*.myworkdayjobs.com` and `*.myworkday.com` only.
- Account creation/sign-in and Gmail OTP retrieval are not implemented yet. The worker stops and reports when an account page appears; it cannot hand that headless session to the user.
- CAPTCHA/security checks, required checkboxes/attestations, and unknown required answers stop the run. It does not bypass them or guess.
- The worker keeps the browser session open while an application awaits approval. Run one worker instance per deployment; if the process restarts, the user may need to retry the run.
- Do not expose the Supabase service-role key to the browser or frontend.

## Configure

1. Apply `supabase/application_runs.sql` to the same Supabase project as Job Compass.
2. Build the worker image from the repository root:

   ```sh
   docker build -f worker/Dockerfile -t job-compass-worker .
   ```

3. Run one private worker container with the backend-only environment variables:

   ```sh
   docker run --restart unless-stopped \
     -e SUPABASE_URL='https://YOUR_PROJECT.supabase.co' \
     -e SUPABASE_SERVICE_ROLE_KEY='YOUR_SERVICE_ROLE_KEY' \
     job-compass-worker
   ```

The worker has no public HTTP listener. Logs contain run IDs and error summaries, not profile values or credentials. Workday URLs are host-checked before navigation.
