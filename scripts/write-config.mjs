// Write site/config.js from build-time environment variables (Vercel project settings).
// Only public values belong here: the Supabase URL and the ANON key. Never the service-role key.
import fs from "node:fs";

const out = process.argv[2] || "site";
const cfg = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
};
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Refusing to build: SUPABASE_SERVICE_ROLE_KEY must not be set in the front-end build.");
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(`${out}/config.js`, `window.JOB_RADAR_CONFIG = ${JSON.stringify(cfg)};\n`);
console.log(`config.js written (accounts ${cfg.supabaseUrl ? "enabled" : "disabled"})`);
