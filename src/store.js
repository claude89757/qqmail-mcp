const now = () => Math.floor(Date.now() / 1000);

/** Small KV facade over the D1 `oauth_store` table (see migrations/0001_oauth_store.sql). */
export function store(env) {
  const db = env.OAUTH_DB;
  return {
    async get(key, type) {
      const row = await db.prepare("SELECT value FROM oauth_store WHERE key=? AND (expires_at IS NULL OR expires_at>?)").bind(key, now()).first();
      if (!row) return null;
      return type === "json" ? JSON.parse(row.value) : row.value;
    },
    async put(key, value, options) {
      const expires = options?.expirationTtl ? now() + options.expirationTtl : null;
      await db
        .prepare("INSERT INTO oauth_store (key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at")
        .bind(key, typeof value === "string" ? value : JSON.stringify(value), expires)
        .run();
    },
    // DELETE ... RETURNING is one SQLite statement: only one concurrent caller wins.
    async consume(key) {
      const row = await db.prepare("DELETE FROM oauth_store WHERE key=? AND (expires_at IS NULL OR expires_at>?) RETURNING value").bind(key, now()).first();
      return row ? JSON.parse(row.value) : null;
    },
    // Keep a spent-token tombstone until expiry so replay revokes its entire family.
    async useRefresh(key, family) {
      return db.prepare("UPDATE oauth_store SET value=json_set(value,'$.used',1,'$.family',?) WHERE key=? AND expires_at>? AND COALESCE(json_extract(value,'$.used'),0)=0 RETURNING value").bind(family, key, now()).first();
    },
    async claim(key, value, ttl) {
      const r = await db.prepare("INSERT OR IGNORE INTO oauth_store (key,value,expires_at) VALUES (?,?,?)").bind(key, JSON.stringify(value), now() + ttl).run();
      return r.meta?.changes === 1;
    },
    async delete(key) {
      await db.prepare("DELETE FROM oauth_store WHERE key=?").bind(key).run();
    },
    async purgeExpired() {
      await db.prepare("DELETE FROM oauth_store WHERE expires_at IS NOT NULL AND expires_at<=?").bind(now()).run();
    },
  };
}
