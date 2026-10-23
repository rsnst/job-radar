# Job Compass: add this job (browser extension)

Adds the job you're viewing on LinkedIn, Indeed, Glassdoor or any career page to your Job Compass tracker.

- Click the toolbar icon on a job page. The popup reads the page's job data (or its title), lets you fix the title and company, then opens Job Compass with the job ready to add.
- It runs only when you click the icon (`activeTab`). It has no background process, no host permissions, and sends nothing anywhere until you press **Add**. Only the title, company and link go to your Job Compass, inside the address.
- Job Compass saves it as "Saved". From there it joins the preparation queue and the application assistant like any other job. Nothing is submitted.

## Install (developer mode)
1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose this `extension/` folder.
3. Open the popup's **Job Compass address** if yours isn't `https://job-radar-tan.vercel.app`.

Edge and Brave load it the same way. For the Chrome Web Store, zip this folder's contents.
