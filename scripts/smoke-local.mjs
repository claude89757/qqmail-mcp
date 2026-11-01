// Local smoke test against `npm run dev` (requires ALLOW_INSECURE_LOCAL_AUTHORIZE=true in .dev.vars).
// Exercises DCR -> /authorize -> /token (PKCE) -> MCP initialize/tools/list without touching QQ Mail.
const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const b64u = (b) => Buffer.from(b).toString("base64url");

const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const redirect = "http://localhost:6274/oauth/callback";

const reg = await (await fetch(`${BASE}/register`, { method: "POST", body: JSON.stringify({ client_name: "smoke", redirect_uris: [redirect] }) })).json();
const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1" });
const page = await fetch(`${BASE}/authorize?${q}`, { redirect: "manual" });
if (page.status !== 200) throw new Error(`Consent page returned ${page.status}`);
const nonce = /name="consent" value="([^"]+)"/.exec(await page.text())[1];
const auth = await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { Origin: BASE, Cookie: page.headers.get("set-cookie").split(";")[0] }, body: new URLSearchParams({ consent: nonce, decision: "allow" }) });
if (auth.status !== 302) throw new Error(`/authorize returned ${auth.status}: ${await auth.text()}`);
const code = new URL(auth.headers.get("location")).searchParams.get("code");
const tok = await (await fetch(`${BASE}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }) })).json();

const rpc = async (method, params = {}) =>
  (await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
const tools = await rpc("tools/list");
console.log(JSON.stringify({ scope: tok.scope, server: init.result.serverInfo, tools: tools.result.tools.map((t) => t.name) }, null, 2));

if (process.argv.includes("--live")) {
  const r = await rpc("tools/call", { name: "check_mail_connection", arguments: { check_smtp: true } });
  console.log(r.result.content[0].text);
}
