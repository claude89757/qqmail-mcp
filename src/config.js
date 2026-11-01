export const NAME = "qqmail-mcp";
export const VERSION = "2.0.2";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const SCOPES = { read: "mail:read", modify: "mail:modify", send: "mail:send" };
export const OFFLINE_SCOPE = "offline_access";

export const IMAP_HOST = "imap.qq.com";
export const IMAP_PORT = 993;
export const SMTP_HOST = "smtp.qq.com";
export const SMTP_PORT = 465;

export const LIMITS = {
  imapTimeoutMs: 25_000,
  sendTimeoutMs: 90_000,
  imapSessionBytes: 48 * 1024 * 1024,
  imapLiteralBytes: 32 * 1024 * 1024,
  searchMax: 50,
  bulkUids: 100,
  bodyFetchBytes: 2 * 1024 * 1024,
  readMaxChars: 100_000,
  inlineAttachmentBytes: 4 * 1024 * 1024,
  outgoingAttachmentBytes: 20 * 1024 * 1024,
  outgoingAttachments: 10,
  recipients: 50,
  downloadTtlSeconds: 15 * 60,
  rawDraftBytes: 25 * 1024 * 1024,
};

export const NO_CACHE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function flag(env, name, fallback) {
  const v = env?.[name];
  if (v === undefined || v === null || v === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(v));
}

/** Scopes this deployment is willing to grant; ENABLE_MODIFY / ENABLE_SEND act as kill switches. */
export function enabledScopes(env) {
  const out = [SCOPES.read];
  if (flag(env, "ENABLE_MODIFY", true)) out.push(SCOPES.modify);
  if (flag(env, "ENABLE_SEND", true)) out.push(SCOPES.send);
  return out;
}
