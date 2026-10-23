# Job Compass Workday Helper

This optional Chrome extension fills clearly labeled Workday text fields from a profile file that the user exports and imports. Profile data is stored in `chrome.storage.local` and is never sent to Job Compass or another server by the extension.

## Install for local development

1. In Job Compass, sign in and open **My profile**.
2. Save the profile and resume, then click **Export profile for Workday helper**. This downloads `job-compass-workday-profile.json` to your device.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
4. Select this `extension/workday-helper` folder.
5. Open the extension menu, choose **Import profile JSON**, and select the downloaded file.
6. Open an employer's Workday job page. Click **Fill matching fields** in the helper panel, then inspect and correct every value.

The extension only runs on `*.myworkdayjobs.com` and `*.myworkday.com`. Its permissions are local extension storage and the Workday page hosts listed in `manifest.json`.

## What it fills

It attempts clear matches for name, contact details, address, profile links, work authorization/sponsorship, and repeated company/title/education text fields. Standard selects are changed only when an option exactly matches a saved value. Unsupported fields remain untouched.

It does not fill checkboxes or radio buttons, equal-opportunity/disability/veteran fields, passwords, verification codes, legal attestations, CAPTCHA, or file upload controls. It never creates an account, reads Gmail, accepts terms, or clicks submit. Download the tailored PDF from the application assistant and choose it yourself in Workday's resume upload step. Review all parsed information before continuing.

Workday pages vary by employer and locale. If the helper reports no match, or a field looks wrong, stop and fill that field manually. The helper is an autofill convenience, not a guarantee that an application is complete.
