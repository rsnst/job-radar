// Pure SQL builders shared by the app and the tests.
// Rows are stored newest-first, so ORDER BY id == newest first and LIMIT stops early.

export const PAGE = 40;

// Turn free text into a safe FTS5 query: each word is a quoted prefix term.
// ".NET" -> "net"*, "C#" -> "c#"*
export function ftsQuery(text) {
  const words = (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#+\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
}

// f = { q, days, board, state, ats, remote, usOnly, newSince, afterId }
// meta = { cutoffs: { "1": maxId, ... } }
export function jobsQuery(f, meta) {
  const where = [];
  const params = [];
  let from = "jobs j";
  const fts = ftsQuery(f.q);
  if (fts) {
    from = "jobs_fts JOIN jobs j ON j.id = jobs_fts.rowid";
    where.push("jobs_fts MATCH ?");
    params.push(fts);
  }
  const idCol = fts ? "jobs_fts.rowid" : "j.id";
  if (f.days && meta?.cutoffs?.[String(f.days)] != null) {
    where.push(`${idCol} <= ${Number(meta.cutoffs[String(f.days)]) | 0}`);
  }
  if (f.board != null && f.board !== "") { where.push("j.board = ?"); params.push(Number(f.board)); }
  if (f.state) { where.push("j.state = ?"); params.push(f.state); }
  if (f.ats) { where.push("j.ats = ?"); params.push(f.ats); }
  if (f.remote) where.push("j.remote = 1");
  if (f.usOnly) where.push("j.us = 1");
  if (f.newSince != null) { where.push("j.seen >= ?"); params.push(f.newSince); }
  if (f.afterId) { where.push(`${idCol} > ?`); params.push(f.afterId); }
  const sql =
    `SELECT j.id, j.title, j.company, j.ats, j.loc, j.state, j.remote, j.us, j.posted, j.seen, j.url, j.board, j.pay ` +
    `FROM ${from}` + (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${idCol} LIMIT ${PAGE}`;
  return { sql, params };
}

// The description for one job (zlib-compressed HTML; inflated in the app). Separate table, read only on demand.
export function detailQuery(id) {
  return { sql: "SELECT body FROM job_details WHERE job_id = ?", params: [Number(id)] };
}

// f = { q, ats, hasJobs, offset }
export function boardsQuery(f) {
  const where = [];
  const params = [];
  let from = "boards b";
  const fts = ftsQuery(f.q);
  if (fts) {
    from = "boards_fts JOIN boards b ON b.id = boards_fts.rowid";
    where.push("boards_fts MATCH ?");
    params.push(fts);
  }
  if (f.ats) { where.push("b.ats = ?"); params.push(f.ats); }
  if (f.hasJobs) where.push("b.jobs > 0");
  const order = fts ? "b.jobs DESC" : "b.jobs DESC, b.id";
  const sql =
    `SELECT b.id, b.company, b.ats, b.url, b.evidence, b.status, b.jobs FROM ${from}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${order} LIMIT ${PAGE} OFFSET ${Number(f.offset) | 0}`;
  return { sql, params };
}

export function boardJobsQuery(boardId) {
  return {
    sql: `SELECT id, title, company, ats, loc, state, remote, us, posted, seen, url, board FROM jobs WHERE board = ? ORDER BY id LIMIT 200`,
    params: [boardId],
  };
}
