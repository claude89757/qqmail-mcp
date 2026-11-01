import { Base64Decoder, enc, utf8Decode } from "./bytes.js";

const certCache = new Map();
const CERT_TTL_MS = 60 * 60 * 1000;

function teamDomain(env) {
  return String(env.ACCESS_TEAM_DOMAIN || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function b64uJson(s) {
  return JSON.parse(utf8Decode(new Base64Decoder().push(enc.encode(s))));
}

async function getKeys(team, fetchImpl, force) {
  const hit = certCache.get(team);
  if (hit && !force && Date.now() - hit.at < CERT_TTL_MS) return hit.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Could not fetch Access signing keys");
  const keys = (await res.json()).keys || [];
  certCache.set(team, { at: Date.now(), keys });
  return keys;
}

function isLocal(req) {
  const h = new URL(req.url).hostname;
  return h === "localhost" || h === "127.0.0.1";
}

/**
 * Verifies the Cf-Access-Jwt-Assertion header that Cloudflare Access adds in front of /authorize.
 * Fails closed: requests that did not pass through Access (e.g. the workers.dev hostname) are rejected.
 */
export async function verifyAccess(req, env, { fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (/^true$/i.test(String(env.ALLOW_INSECURE_LOCAL_AUTHORIZE || "")) && isLocal(req)) return { ok: true, email: "local-dev" };
  const team = teamDomain(env);
  const aud = String(env.ACCESS_AUD || "").trim();
  if (!team || !aud) return { ok: false, status: 503, reason: "Authorization is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD." };
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion") || "";
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, status: 403, reason: "Sign in through Cloudflare Access on the configured hostname." };
  let header, payload;
  try {
    header = b64uJson(parts[0]);
    payload = b64uJson(parts[1]);
  } catch {
    return { ok: false, status: 403, reason: "Malformed Access token" };
  }
  if (header.alg !== "RS256") return { ok: false, status: 403, reason: "Unsupported Access token algorithm" };
  let keys = await getKeys(team, fetchImpl, false);
  if (!keys.some((k) => k.kid === header.kid)) keys = await getKeys(team, fetchImpl, true);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, status: 403, reason: "Unknown Access signing key" };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const sig = new Base64Decoder().push(enc.encode(parts[2]));
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, enc.encode(parts[0] + "." + parts[1]));
  if (!valid) return { ok: false, status: 403, reason: "Invalid Access token signature" };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, status: 403, reason: "Access token audience mismatch" };
  if (payload.iss !== `https://${team}`) return { ok: false, status: 403, reason: "Access token issuer mismatch" };
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds - 30) return { ok: false, status: 403, reason: "Access token expired" };
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + 60) return { ok: false, status: 403, reason: "Access token not yet valid" };
  const allowed = String(env.ACCESS_ALLOWED_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const email = String(payload.email || "").toLowerCase();
  if (allowed.length && !allowed.includes(email)) return { ok: false, status: 403, reason: "This identity is not allowed to authorize the mailbox." };
  return { ok: true, email };
}

export function clearAccessKeyCache() {
  certCache.clear();
}
