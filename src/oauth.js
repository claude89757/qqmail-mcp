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
    client_id_metadata_document_supported: true,
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
  try {
    const u = new URL(id);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
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

/** /authorize: Cloudflare Access is the login and consent step; the Worker re-verifies its JWT. */
export async function authorize(req, env, origin, deps = {}) {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const access = await (deps.verifyAccess || verifyAccess)(req, env);
  if (!access.ok) return oauthErr(access.status === 503 ? "server_error" : "access_denied", access.reason, access.status);
  let p;
  try {
    p = await checkAuthQuery(new URL(req.url), env, origin);
  } catch (e) {
    return oauthErr("invalid_request", e.message);
  }
  const code = random();
  await store(env).put("code:" + (await sha(code)), JSON.stringify(p), { expirationTtl: CODE_TTL });
  const url = new URL(p.redirectUri);
  url.searchParams.set("code", code);
  if (p.state) url.searchParams.set("state", p.state);
  return new Response(null, { status: 302, headers: { ...NO_CACHE, Location: url.toString() } });
}

async function issue(env, scope, clientId) {
  const access = random();
  const refresh = random();
  const s = store(env);
  await Promise.all([
    s.put("access:" + (await sha(access)), JSON.stringify({ scope, clientId }), { expirationTtl: ACCESS_TTL }),
    s.put("refresh:" + (await sha(refresh)), JSON.stringify({ scope, clientId }), { expirationTtl: REFRESH_TTL }),
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
    await s.delete(key);
    return issue(env, v.scope, clientId);
  }
  if (grant === "refresh_token") {
    const key = "refresh:" + (await sha(String(p.get("refresh_token") || "")));
    const v = await s.get(key, "json");
    if (!v || v.clientId !== clientId) return oauthErr("invalid_grant", "Refresh token expired");
    await s.delete(key);
    return issue(env, v.scope, clientId);
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
  const enabled = enabledScopes(env);
  return { clientId: data.clientId, scopes: scopes.filter((s) => enabled.includes(s)) };
}
