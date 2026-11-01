import { connect } from "cloudflare:sockets";
import { NAME, VERSION, enabledScopes } from "./config.js";
import { err, json } from "./http.js";
import { authenticate, authorize, metadata, protectedMetadata, register, token, wwwAuthenticate } from "./oauth.js";
import { handleMcp } from "./mcp.js";
import { handleDownload } from "./download.js";

export function health(env) {
  const mailbox = !!(env.QQ_EMAIL && env.QQ_APP_PASSWORD);
  return {
    service: NAME,
    version: VERSION,
    ready: mailbox,
    configured: { mailbox, authorization: "cloudflare_access", access_jwt_verification: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) },
    scopes: enabledScopes(env),
  };
}

export async function route(req, env, deps = {}) {
  const url = new URL(req.url);
  const path = url.pathname;
  const origin = url.origin;
  const sockets = deps.connect || connect;
  if (path === "/health") return json(health(env));
  if (path === "/.well-known/oauth-authorization-server") return json(metadata(origin, env));
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return json(protectedMetadata(origin, env));
  if (path === "/register" && req.method === "POST") return register(req, env);
  if (path === "/authorize") return authorize(req, env, origin, deps);
  if (path === "/token" && req.method === "POST") return token(req, env, origin);
  if (path.startsWith("/download/")) return handleDownload(req, env, sockets);
  if (path === "/mcp" || path === "/mcp/") {
    const auth = await authenticate(req, env);
    if (!auth) return json({ error: "Authentication required" }, 401, { "WWW-Authenticate": wwwAuthenticate(origin, env) });
    return handleMcp(req, { env, connect: sockets, origin }, auth);
  }
  return err("Not found", 404);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      console.error(JSON.stringify({ event: "unhandled", error_type: e?.name || "Error" }));
      return err("Internal service error", 500);
    }
  },
};
