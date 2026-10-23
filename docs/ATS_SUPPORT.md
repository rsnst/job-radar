# Application support by platform

This page says what Job Compass can do on each applicant tracking system (ATS) today.
It is the source of truth for the "Automation" line shown on every application.

## Status key

- **Listed**: Job Compass indexes the platform's public job feed. Shipped.
- **Assisted (manual)**: the app prepares your answers, tailored resume, and cover letter, opens the employer's page, and records each step you confirm. You fill the form, create any account, verify your email, and submit. Shipped.
- **Application worker**: the app-owned worker in `worker/` currently supports Workday only. It fills clearly matched profile fields, uploads a tailored PDF, and can submit after an explicit approval or hands-free opt-in. Sign-in/account creation, Gmail verification, CAPTCHA/security checks, protected disclosures, legal attestations, and unknown questions stop the run.
- **Automated account creation, email verification, or submission**: **not built for any platform.** Not planned for the web app.

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

- Workday worker runs require the `application_runs` SQL setup and a continuously running private worker configured with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The first release does not create accounts or read Gmail, and pauses when an application requires those steps. Never attempt to bypass CAPTCHA or other security controls.
- Automation never bypasses CAPTCHA, bot checks, rate limits, legal attestations, or identity verification. Those always stop with the user.
- Before any additional pre-fill is enabled for another platform, it needs: a documented terms review, a per-application preview that the user approves, and rate limits that respect the platform.

## Gmail verification

Not implemented. The app does not connect to Gmail, read email, or handle verification codes. When a site sends a verification email, the tracker shows "Waiting for the verification email" for you to record, and you check your inbox yourself.

## What is recorded

Each step you confirm is saved to the application's history: account created by you, waiting for verification, verification done, and submitted by you (with a receipt). The app never stores passwords, verification codes, or email contents.
