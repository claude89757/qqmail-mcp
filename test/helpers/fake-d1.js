/** In-memory stand-in for the D1 queries issued by src/store.js. */
export function fakeD1() {
  const rows = new Map();
  const db = {
    rows,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) {
          args = a;
          return stmt;
        },
        async first() {
          if (sql.startsWith("SELECT value FROM oauth_store")) {
            const [key, now] = args;
            const r = rows.get(key);
            return r && (r.expires_at === null || r.expires_at > now) ? { value: r.value } : null;
          }
          if (sql.startsWith("DELETE FROM oauth_store WHERE key=?")) {
            const [key, now] = args, row = rows.get(key);
            if (!row || (row.expires_at !== null && row.expires_at <= now)) return null;
            rows.delete(key); return { value: row.value };
          }
          if (sql.startsWith("UPDATE oauth_store SET value=json_set")) {
            const [family, key, now] = args, row = rows.get(key);
            if (!row || row.expires_at <= now) return null;
            const value = JSON.parse(row.value);
            if (value.used) return null;
            row.value = JSON.stringify({ ...value, used: 1, family });
            return { value: row.value };
          }
          throw new Error("unexpected first(): " + sql);
        },
        async run() {
          if (sql.startsWith("INSERT OR IGNORE INTO oauth_store")) {
            if (rows.has(args[0])) return { success: true, meta: { changes: 0 } };
            rows.set(args[0], { value: args[1], expires_at: args[2] });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO oauth_store")) rows.set(args[0], { value: args[1], expires_at: args[2] });
          else if (sql.startsWith("DELETE FROM oauth_store WHERE key=?")) rows.delete(args[0]);
          else if (sql.startsWith("DELETE FROM oauth_store WHERE expires_at")) {
            for (const [k, r] of rows) if (r.expires_at !== null && r.expires_at <= args[0]) rows.delete(k);
          } else throw new Error("unexpected run(): " + sql);
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}
