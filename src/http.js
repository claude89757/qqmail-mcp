import { NO_CACHE } from "./config.js";

export function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { ...NO_CACHE, ...extra } });
}

export function err(message, status = 400) {
  return json({ error: message }, status);
}

export function oauthErr(code, message, status = 400) {
  return json({ error: code, error_description: message }, status);
}
