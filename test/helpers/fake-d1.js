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
          throw new Error("unexpected first(): " + sql);
        },
        async run() {
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
