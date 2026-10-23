# Application support by platform

This page says what Job Compass can do on each applicant tracking system (ATS) today.
It is the source of truth for the "Automation" line shown on every application.

## Status key

- **Listed**: Job Compass indexes the platform's public job feed. Shipped.
- **Assisted (manual)**: the app prepares your answers, tailored resume, and cover letter, opens the employer's page, and records each step you confirm. You fill the form, create any account, verify your email, and submit. Shipped.
- **Application worker**: the app-owned worker in `worker/` currently supports Workday only. It fills clearly matched profile fields, uploads a tailored PDF, and can submit after an explicit approval or hands-free opt-in. With the opt-ins in My profile it can also create or sign in to the employer account and complete emailed verification (see below). CAPTCHA/security checks, protected disclosures, legal attestations, and unknown questions stop the run.
- **Automated account creation, email verification, and unattended submission**: built for **Workday only**, off by default, each a separate opt-in. Not verified against live employer sites yet; see `worker/README.md`. Not built for any other platform.

The supported Workday path is **Listed + Worker-assisted** when the worker is deployed. Other platforms are **Listed + Preparation-only**.

## Platforms

| Platform | Listed | Assisted (manual) | Pre-fill |
|---|---|---|---|
| Greenhouse | yes | yes | not built |
| Lever | yes | yes | not built |
| Ashby | yes | yes | not built |
| SmartRecruiters | yes | yes | not built |
| Workday | yes | yes | app-owned Playwright worker (initial support) |
| Workable | yes | yes | not built |
| Recruitee | yes | yes | not built |
| Gem | yes | yes | not built |
| BambooHR | yes | yes | not built |
| BreezyHR | yes | yes | not built |
| Rippling | yes | yes | not built |
| Pinpoint | yes | yes | not built |
| Paylocity | yes | yes | not built |
| ADP | yes | yes | not built |
| UltiPro / UKG | yes | yes | not built |
| Oracle Recruiting | yes | yes | not built |
| JazzHR | yes | yes | not built |
| Jobvite | yes | yes | not built |
| iCIMS | yes | yes | not built |

Any other employer site is treated as **manual only**.

## Policy and site limits

- Workday worker runs require the `application_runs` SQL setup and a continuously running private worker configured with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Account creation and email verification additionally need `supabase/employer_accounts.sql`, `CREDENTIAL_KEY`, `INBOX_DOMAIN` and `INBOUND_SECRET` on the worker. Without them (or without the user's opt-in) the run pauses at the account page.
- Automation never bypasses CAPTCHA, bot checks, rate limits, legal attestations, or identity verification. Those always stop with the user.
- Before any additional pre-fill is enabled for another platform, it needs: a documented terms review, a per-application preview that the user approves, and rate limits that respect the platform.

## Email verification

The worker never connects to a user's Gmail or any personal inbox. When the user opts in to account creation, the worker signs up with a per-user Job Compass address (`jc-<token>@INBOX_DOMAIN`). An inbound-mail webhook on the worker receives mail for that address, accepts only Workday senders, and keeps just the extracted one-time code or `https` Workday verification link (never the message body), which expires after 30 minutes and is cleared once used. If the mail does not arrive in time, the run stops with "email-verification" for the user to finish.

## What is recorded

Each step you confirm is saved to the application's history: account created by you, waiting for verification, verification done, and submitted by you (with a receipt). Passwords for accounts the worker created are stored AES-256-GCM encrypted with a key only the worker holds, are never readable by the web app, and can be removed by the user in My profile. Verification codes are cleared after use and email bodies are never stored.
