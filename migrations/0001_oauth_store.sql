-- Key/value store for OAuth clients, codes, tokens and short-lived download links.
-- Already present in production; IF NOT EXISTS makes this safe to apply there.
CREATE TABLE IF NOT EXISTS oauth_store (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_exp ON oauth_store(expires_at);
