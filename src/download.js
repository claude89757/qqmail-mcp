import { LIMITS, NO_CACHE } from "./config.js";
import { MailError } from "./errors.js";
import { err } from "./http.js";
import { openImap } from "./imap.js";
import { random, sha } from "./oauth.js";
import { store } from "./store.js";

const ACTIVE_TYPES = /^(text\/html|text\/xml|application\/xhtml\+xml|application\/xml|image\/svg\+xml|application\/javascript|text\/javascript)$/i;

/** Stores a short-lived, unguessable link to one attachment; only a hash of the token is persisted. */
export async function createDownloadLink(ctx, target) {
  const ttl = Number(ctx.env.DOWNLOAD_TTL_SECONDS) > 0 ? Math.min(Number(ctx.env.DOWNLOAD_TTL_SECONDS), 3600) : LIMITS.downloadTtlSeconds;
  const token = random().replace(/-/g, "");
  await store(ctx.env).put("dl:" + (await sha(token)), JSON.stringify(target), { expirationTtl: ttl });
  return {
    url: `${ctx.origin}/download/${token}/${encodeURIComponent(target.filename)}`,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

export function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** GET /download/<token>[/<name>] streams the decoded attachment straight from IMAP. */
export async function handleDownload(req, env, connect) {
  if (req.method !== "GET" && req.method !== "HEAD") return err("Method not allowed", 405);
  const token = new URL(req.url).pathname.split("/")[2] || "";
  if (!/^[0-9a-f]{64}$/.test(token)) return err("Not found", 404);
  const target = await store(env).get("dl:" + (await sha(token)), "json");
  if (!target) return err("Download link expired or invalid", 404);
  const type = ACTIVE_TYPES.test(target.content_type) ? "application/octet-stream" : target.content_type || "application/octet-stream";
  const headers = {
    ...NO_CACHE,
    "Content-Type": type,
    "Content-Disposition": contentDisposition(target.filename || "attachment"),
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (req.method === "HEAD") return new Response(null, { headers });
  let session;
  try {
    session = await openImap(env, connect);
    await session.open(target.folder);
    const { stream } = await session.streamSection(target.uid, target.section, target.encoding);
    return new Response(stream, { headers });
  } catch (e) {
    session?.close();
    return err(e instanceof MailError ? e.message : "Could not fetch the attachment", 502);
  }
}
