import { base64UrlEncode, enc } from "./bytes.js";
import { NO_CACHE, OFFLINE_SCOPE, SCOPES, enabledScopes } from "./config.js";
import { json, oauthErr } from "./http.js";
import { store } from "./store.js";
import { verifyAccess } from "./access.js";

const KNOWN_SCOPES = [SCOPES.read, SCOPES.modify, SCOPES.send, OFFLINE_SCOPE];
const ACCESS_TTL = 86400;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 300;

export function random() {
  return crypto.randomUUID() + crypto.randomUUID();
}

export async function sha(s) {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s)))));
}

function constantTimeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let v = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) v |= (x[i] || 0) ^ (y[i] || 0);
  return v === 0;
}

function clean(s, max = 150) {
  return typeof s === "string" ? s.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : "";
}

/** Any HTTPS redirect, Cursor's custom scheme, or http loopback (localhost / 127.0.0.1). No credentials or fragments. */
export function redirectAllowed(v) {
  try {
    const u = new URL(v);
    if (u.username || u.password || u.hash) return false;
    if (v === "cursor://anysphere.cursor-mcp/oauth/callback") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

export function resource(origin) {
  return origin + "/mcp";
}

export function metadata(origin, env) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/authorize",
    token_endpoint: origin + "/token",
    registration_endpoint: origin + "/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...enabledScopes(env), OFFLINE_SCOPE],
    client_id_metadata_document_supported: false,
  };
}

export function protectedMetadata(origin, env) {
  return { resource: resource(origin), authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: enabledScopes(env) };
}

export function wwwAuthenticate(origin, env) {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${enabledScopes(env).join(" ")}"`;
}

/**
 * Validates a requested scope string. An omitted scope grants every enabled mail scope.
 * mail:read is always required; disabled scopes are dropped rather than rejected.
 */
export function grantScopes(requested, env) {
  const enabled = enabledScopes(env);
  const asked = String(requested || "").trim() ? String(requested).trim().split(/\s+/) : [...enabled];
  if (!asked.every((s) => KNOWN_SCOPES.includes(s)) || !asked.includes(SCOPES.read)) throw new Error("Unsupported scope");
  return [...new Set(asked.filter((s) => s === OFFLINE_SCOPE || enabled.includes(s)))].join(" ");
}

export async function validClient(env, id, redirect) {
  if (!redirectAllowed(redirect) || typeof id !== "string" || !id || id.length > 600) return false;
  const saved = await store(env).get("client:" + id, "json");
  if (saved) return Array.isArray(saved.redirect_uris) && saved.redirect_uris.includes(redirect);
  // URL-shaped IDs are not proof of client ownership. Use registered clients only.
  return false;
}

export async function register(req, env) {
  let p;
  try {
    p = await req.json();
  } catch {
    return oauthErr("invalid_client_metadata", "Invalid JSON");
  }
  if (!Array.isArray(p.redirect_uris) || p.redirect_uris.length < 1 || p.redirect_uris.length > 10 || !p.redirect_uris.every(redirectAllowed))
    return oauthErr("invalid_redirect_uri", "Redirect URI not allowed");
  if (p.token_endpoint_auth_method && p.token_endpoint_auth_method !== "none") return oauthErr("invalid_client_metadata", "PKCE public client required");
  const obj = {
    client_id: "qqmcp-" + random(),
    client_name: clean(p.client_name || "MCP Client", 100),
    redirect_uris: p.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  await store(env).put("client:" + obj.client_id, JSON.stringify(obj));
  return json(obj, 201);
}

export async function checkAuthQuery(url, env, origin) {
  const q = url.searchParams;
  const clientId = q.get("client_id") || "";
  const redirectUri = q.get("redirect_uri") || "";
  if (!(await validClient(env, clientId, redirectUri))) throw new Error("Client or redirect URI not allowed");
  const challenge = q.get("code_challenge") || "";
  if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !/^[a-zA-Z0-9_-]{43,128}$/.test(challenge)) throw new Error("PKCE S256 required");
  const scope = grantScopes(q.get("scope"), env);
  if (q.get("resource") && q.get("resource") !== resource(origin)) throw new Error("Invalid resource");
  const state = q.get("state") || "";
  if (state.length > 512) throw new Error("State too long");
  return { clientId, redirectUri, challenge, state, scope };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/** Access authenticates the owner; a separate, CSRF-protected POST grants consent. */
export async function authorize(req, env, origin, deps = {}) {
  if (!["GET", "POST"].includes(req.method)) return json({ error: "Method not allowed" }, 405);
  const access = await (deps.verifyAccess || verifyAccess)(req, env);
  if (!access.ok) return oauthErr(access.status === 503 ? "server_error" : "access_denied", access.reason, access.status);
  const s = store(env);
  const cookieName = new URL(origin).protocol === "https:" ? "__Host-qqmcp-consent" : "qqmcp-consent";
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;
  let p;
  if (req.method === "GET") {
    try { p = await checkAuthQuery(new URL(req.url), env, origin); }
    catch (e) { return oauthErr("invalid_request", e.message); }
    const nonce = random();
    await s.put("consent:" + await sha(nonce), { ...p, owner: access.email, origin }, { expirationTtl: CODE_TTL });
    const client = await s.get("client:" + p.clientId, "json");
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>QQ 邮箱授权确认</title><body><main><h1>允许应用访问你的 QQ 邮箱？</h1><p>应用：<strong>${escapeHtml(client?.client_name || p.clientId)}</strong></p><p>回调地址：<code>${escapeHtml(p.redirectUri)}</code></p><p>请求权限：<strong>${escapeHtml(p.scope)}</strong></p><p>mail:read 可读取邮件；mail:modify 可修改、移动和删除；mail:send 可发送邮件。仅批准你主动连接且信任的应用。</p><form method="post" action="/authorize"><input type="hidden" name="consent" value="${escapeHtml(nonce)}"><button name="decision" value="allow" type="submit">确认授权</button> <button name="decision" value="deny" type="submit">拒绝</button></form></main></body></html>`;
    return new Response(html, { headers: { ...NO_CACHE, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", "X-Frame-Options": "DENY", "Set-Cookie": `${cookieName}=${nonce}; ${cookieFlags}; Max-Age=${CODE_TTL}` } });
  }
  if (req.headers.get("Origin") !== origin) return oauthErr("access_denied", "Consent origin mismatch", 403);
  let form;
  try { form = await req.formData(); } catch { return oauthErr("invalid_request", "Invalid consent form"); }
  const nonce = String(form.get("consent") || "");
  const cookie = (req.headers.get("Cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(cookieName + "="))?.slice(cookieName.length + 1) || "";
  if (!nonce || !cookie || !constantTimeEqual(nonce, cookie)) return oauthErr("access_denied", "Consent cookie mismatch", 403);
  const key = "consent:" + await sha(nonce);
  p = await s.get(key, "json");
  if (!p || p.owner !== access.email || p.origin !== origin) return oauthErr("access_denied", "Consent expired or identity changed", 403);
  if (!(await s.consume(key))) return oauthErr("access_denied", "Consent already used", 403);
  const headers = { ...NO_CACHE, "Set-Cookie": `${cookieName}=; ${cookieFlags}; Max-Age=0` };
  const url = new URL(p.redirectUri);
  if (form.get("decision") === "allow") {
    if (!(await validClient(env, p.clientId, p.redirectUri))) return oauthErr("invalid_client", "Client no longer registered");
    const code = random();
    await s.put("code:" + await sha(code), { ...p, resource: resource(origin) }, { expirationTtl: CODE_TTL });
    url.searchParams.set("code", code);
  } else url.searchParams.set("error", "access_denied");
  if (p.state) url.searchParams.set("state", p.state);
  return new Response(null, { status: 302, headers: { ...headers, Location: url.toString() } });
}

async function issue(env, scope, clientId, audience, family = random()) {
  const access = random();
  const refresh = random();
  const s = store(env);
  await Promise.all([
    s.put("access:" + (await sha(access)), JSON.stringify({ scope, clientId, resource: audience, family }), { expirationTtl: ACCESS_TTL }),
    s.put("refresh:" + (await sha(refresh)), JSON.stringify({ scope, clientId, resource: audience, family }), { expirationTtl: REFRESH_TTL }),
    s.purgeExpired().catch(() => {}),
  ]);
  return json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_TTL, scope });
}

export async function token(req, env, origin) {
  let p;
  try {
    p = await req.formData();
  } catch {
    return oauthErr("invalid_request", "Malformed form");
  }
  const grant = String(p.get("grant_type") || "");
  const clientId = String(p.get("client_id") || "");
  const s = store(env);
  if (grant === "authorization_code") {
    const key = "code:" + (await sha(String(p.get("code") || "")));
    const v = await s.get(key, "json");
    if (!v || v.clientId !== clientId || v.redirectUri !== String(p.get("redirect_uri") || "")) return oauthErr("invalid_grant", "Code expired or incorrect");
    const verifier = String(p.get("code_verifier") || "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !constantTimeEqual(await sha(verifier), v.challenge)) return oauthErr("invalid_grant", "PKCE validation failed");
    if (p.get("resource") && p.get("resource") !== resource(origin)) return oauthErr("invalid_target", "Resource mismatch");
    if (!(await s.consume(key))) return oauthErr("invalid_grant", "Code already used");
    return issue(env, v.scope, clientId, v.resource || resource(origin));
  }
  if (grant === "refresh_token") {
    const key = "refresh:" + (await sha(String(p.get("refresh_token") || "")));
    const v = await s.get(key, "json");
    if (!v || v.clientId !== clientId) return oauthErr("invalid_grant", "Refresh token expired");
    if (p.get("resource") && p.get("resource") !== resource(origin)) return oauthErr("invalid_target", "Resource mismatch");
    if (v.resource && v.resource !== resource(origin)) return oauthErr("invalid_target", "Token audience mismatch");
    const family = v.family || await sha(key);
    if (await s.get("revoked:" + family)) return oauthErr("invalid_grant", "Token family revoked");
    let scope = v.scope;
    if (p.get("scope")) {
      const requested = String(p.get("scope")).trim().split(/\s+/);
      if (!requested.includes(SCOPES.read) || requested.some(x => !v.scope.split(/\s+/).includes(x))) return oauthErr("invalid_scope", "Scope escalation refused");
      scope = [...new Set(requested)].join(" ");
    }
    if (!(await s.useRefresh(key, family))) {
      await s.put("revoked:" + family, "1", { expirationTtl: 2 * REFRESH_TTL });
      return oauthErr("invalid_grant", "Refresh replay detected; reconnect this client");
    }
    return issue(env, scope, clientId, v.resource || resource(origin), family);
  }
  return oauthErr("unsupported_grant_type", "Expected authorization_code or refresh_token");
}

/** Returns the token's effective scopes (intersected with what is currently enabled), or null. */
export async function authenticate(req, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  const data = await store(env).get("access:" + (await sha(m[1])), "json");
  const scopes = String(data?.scope || "").split(/\s+/);
  if (!scopes.includes(SCOPES.read)) return null;
  if (data.resource && data.resource !== resource(new URL(req.url).origin)) return null;
  if (data.family && await store(env).get("revoked:" + data.family)) return null;
  const enabled = enabledScopes(env);
  return { clientId: data.clientId, scopes: scopes.filter((s) => enabled.includes(s)) };
}
