// Assemble the static site: web/* + sql.js-httpvfs runtime into site/ (DB chunks are written by build_db).
import fs from "node:fs";
const out = process.argv[2] || "site";
fs.mkdirSync(`${out}/vendor`, { recursive: true });
fs.cpSync("web", out, { recursive: true }); // pages, scripts, icons/, service worker
const dist = "node_modules/sql.js-httpvfs/dist";
for (const f of ["index.js", "sqlite.worker.js", "sql-wasm.wasm"]) fs.copyFileSync(`${dist}/${f}`, `${out}/vendor/${f}`);
fs.copyFileSync("node_modules/sql.js-httpvfs/LICENSE", `${out}/vendor/LICENSE`);
fs.writeFileSync(`${out}/.nojekyll`, "");
console.log(`site assembled in ${out}/`);
