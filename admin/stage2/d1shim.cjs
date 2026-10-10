// Shared in-memory D1 shim (node:sqlite) for local Worker tests. Applies the repo schema + all admin migrations.
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const root = path.join(__dirname, "..", "..");

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  const files = ["db/schema.sql", "db/membership-schema.sql", ...fs.readdirSync(path.join(root, "admin/migrations")).sort().map((f) => "admin/migrations/" + f)];
  for (const f of files) sqlite.exec(fs.readFileSync(path.join(root, f), "utf8"));
  const bound = (sql, a) => {
    const st = sqlite.prepare(sql);
    return {
      async first() { return st.get(...a) ?? null; },
      async all() { return { results: st.all(...a) }; },
      async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; },
      _exec() { if (/^\s*(select|with)/i.test(sql)) { st.all(...a); return { meta: { changes: 0 } }; } const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; },
    };
  };
  const D1 = {
    prepare(sql) { return { ...bound(sql, []), bind: (...a) => bound(sql, a) }; },
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try { const out = stmts.map((s) => s._exec()); sqlite.exec("COMMIT"); return out; }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
  };
  return { sqlite, D1, q: (sql, ...a) => sqlite.prepare(sql).all(...a), one: (sql, ...a) => sqlite.prepare(sql).get(...a) };
}
module.exports = { makeDb, root };
