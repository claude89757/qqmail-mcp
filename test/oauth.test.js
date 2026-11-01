import { beforeEach, describe, expect, it } from "vitest";
import { route } from "../src/index.js";
import { grantScopes, redirectAllowed, sha } from "../src/oauth.js";
import { verifyAccess, clearAccessKeyCache } from "../src/access.js";
import { base64UrlEncode, enc } from "../src/bytes.js";
import { TOOLS, listTools } from "../src/tools.js";
import { fakeD1 } from "./helpers/fake-d1.js";

const ORIGIN = "https://qqmail.example.com";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-123";

function env(extra = {}) {
  return { OAUTH_DB: fakeD1(), QQ_EMAIL: "me@qq.com", QQ_APP_PASSWORD: "pw", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra };
}

async function pkce() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await sha(verifier) };
}

async function makeKeys() {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
  const sign = async (payload, header = { alg: "RS256", kid: "k1" }) => {
    const h = base64UrlEncode(enc.encode(JSON.stringify(header)));
    const p = base64UrlEncode(enc.encode(JSON.stringify(payload)));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, enc.encode(`${h}.${p}`)));
    return `${h}.${p}.${base64UrlEncode(sig)}`;
  };
  const fetchImpl = async (url) => {
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  };
  return { sign, fetchImpl };
}

const now = () => Math.floor(Date.now() / 1000);

describe("redirect allowlist", () => {
  it.each([
    ["https://chatgpt.com/connector_platform_oauth_redirect", true],
    ["https://grok.com/oauth/callback?x=1", true],
    ["cursor://anysphere.cursor-mcp/oauth/callback", true],
    ["http://localhost:6274/oauth/callback", true],
    ["http://127.0.0.1:33418/callback", true],
    ["http://example.com/callback", false],
    ["http://localhost.evil.com/cb", false],
    ["https://user:pass@example.com/cb", false],
    ["https://example.com/cb#frag", false],
    ["cursor://other/callback", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
  ])("%s -> %s", (uri, allowed) => expect(redirectAllowed(uri)).toBe(allowed));
});

describe("scopes", () => {
  it("defaults to every enabled scope and honours kill switches", () => {
    expect(grantScopes("", {})).toBe("mail:read mail:modify mail:send");
    expect(grantScopes(null, { ENABLE_SEND: "false" })).toBe("mail:read mail:modify");
    expect(grantScopes("mail:read mail:send offline_access", { ENABLE_SEND: "0" })).toBe("mail:read offline_access");
    expect(() => grantScopes("mail:send", {})).toThrow();
    expect(() => grantScopes("mail:read openid", {})).toThrow();
  });

  it("filters tools by scope", () => {
    const names = (s) => listTools(s).map((t) => t.name);
    expect(names(["mail:read"])).toEqual(["check_mail_connection", "list_folders", "search_emails", "read_email", "list_attachments", "download_attachment"]);
    expect(names(["mail:read", "mail:modify", "mail:send"])).toHaveLength(TOOLS.length);
  });

  it("publishes valid tool schemas", () => {
    for (const t of listTools(["mail:read", "mail:modify", "mail:send"])) {
      expect(t.name).toMatch(/^[a-z_]{3,64}$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required || []) expect(t.inputSchema.properties).toHaveProperty(r);
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      expect(JSON.parse(JSON.stringify(t))).toEqual(t);
    }
  });
});

describe("Cloudflare Access JWT verification", () => {
  let keys;
  beforeEach(async () => {
    clearAccessKeyCache();
    keys = await makeKeys();
  });
  const req = (jwt, host = "qqmail.example.com") => new Request(`https://${host}/authorize`, { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });
  const claims = (extra = {}) => ({ aud: [AUD], iss: `https://${TEAM}`, exp: now() + 600, iat: now(), email: "owner@example.com", ...extra });

  it("accepts a valid token", async () => {
    const r = await verifyAccess(req(await keys.sign(claims())), env({ ACCESS_ALLOWED_EMAILS: "Owner@example.com" }), { fetchImpl: keys.fetchImpl });
    expect(r).toEqual({ ok: true, email: "owner@example.com" });
  });

  it("rejects requests that bypassed Access (no header), e.g. via workers.dev", async () => {
    const r = await verifyAccess(req(null, "qqmail-mcp.someone.workers.dev"), env(), { fetchImpl: keys.fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed when Access is not configured", async () => {
    const r = await verifyAccess(req(await keys.sign(claims())), env({ ACCESS_AUD: "" }), { fetchImpl: keys.fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it.each([
    ["wrong audience", { aud: ["other"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: now() - 3600 }],
    ["email not allowed", { email: "intruder@example.com" }],
  ])("rejects %s", async (_, extra) => {
    const r = await verifyAccess(req(await keys.sign(claims(extra))), env({ ACCESS_ALLOWED_EMAILS: "owner@example.com" }), { fetchImpl: keys.fetchImpl });
    expect(r.ok).toBe(false);
  });

  it("rejects a forged signature", async () => {
    const other = await makeKeys();
    const r = await verifyAccess(req(await other.sign(claims())), env(), { fetchImpl: keys.fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "Invalid Access token signature" });
  });

  it("allows the local-dev bypass only on localhost", async () => {
    const e = env({ ALLOW_INSECURE_LOCAL_AUTHORIZE: "true" });
    expect((await verifyAccess(new Request("http://localhost:8787/authorize"), e)).ok).toBe(true);
    expect((await verifyAccess(new Request("https://qqmail.example.com/authorize"), e, { fetchImpl: keys.fetchImpl })).ok).toBe(false);
  });
});

describe("OAuth flow end to end", () => {
  async function connectClient(e, { scope, redirect = "https://chatgpt.com/connector_platform_oauth_redirect" } = {}) {
    const reg = await route(new Request(`${ORIGIN}/register`, { method: "POST", body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect] }) }), e);
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const { verifier, challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st", resource: `${ORIGIN}/mcp`, ...(scope ? { scope } : {}) });
    const auth = await route(new Request(`${ORIGIN}/authorize?${q}`), e, { verifyAccess: async () => ({ ok: true, email: "owner@example.com" }) });
    expect(auth.status).toBe(302);
    const loc = new URL(auth.headers.get("Location"));
    expect(loc.searchParams.get("state")).toBe("st");
    const tok = await route(new Request(`${ORIGIN}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code"), client_id, redirect_uri: redirect, code_verifier: verifier, resource: `${ORIGIN}/mcp` }) }), e);
    expect(tok.status).toBe(200);
    return { client_id, ...(await tok.json()) };
  }

  const rpc = (e, token, method, params = {}) =>
    route(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), e);

  it("issues tokens with all scopes by default and exposes every tool", async () => {
    const e = env();
    const t = await connectClient(e);
    expect(t.scope).toBe("mail:read mail:modify mail:send");
    const init = await (await rpc(e, t.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).json();
    expect(init.result.serverInfo).toMatchObject({ name: "qqmail-mcp", version: "2.0.0" });
    const list = await (await rpc(e, t.access_token, "tools/list")).json();
    expect(list.result.tools).toHaveLength(TOOLS.length);
  });

  it("keeps v1 read-only tokens working with read tools only", async () => {
    const e = env();
    const t = await connectClient(e, { scope: "mail:read offline_access", redirect: "cursor://anysphere.cursor-mcp/oauth/callback" });
    const list = await (await rpc(e, t.access_token, "tools/list")).json();
    expect(list.result.tools.every((x) => x.annotations.readOnlyHint)).toBe(true);
    const call = await (await rpc(e, t.access_token, "tools/call", { name: "send_email", arguments: { to: ["a@b.com"], subject: "x" } })).json();
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("mail:send");
  });

  it("rotates refresh tokens", async () => {
    const e = env();
    const t = await connectClient(e);
    const refresh = () => route(new Request(`${ORIGIN}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id }) }), e);
    expect((await refresh()).status).toBe(200);
    expect((await refresh()).status).toBe(400);
  });

  it("refuses /authorize without a verified Access identity", async () => {
    const e = env();
    const res = await route(new Request(`${ORIGIN}/authorize?response_type=code`), e);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("access_denied");
  });

  it("challenges unauthenticated MCP requests with resource metadata", async () => {
    const res = await route(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }), env());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    const meta = await (await route(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env({ ENABLE_SEND: "false" }))).json();
    expect(meta.scopes_supported).toEqual(["mail:read", "mail:modify", "offline_access"]);
  });

  it("rejects disallowed redirect URIs at registration", async () => {
    const res = await route(new Request(`${ORIGIN}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) }), env());
    expect(res.status).toBe(400);
  });
});
