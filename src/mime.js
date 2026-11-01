import { base64Decode, base64Encode, concatBytes, enc, utf8Decode } from "./bytes.js";

const CHARSET_ALIASES = { gb2312: "gb18030", gbk: "gb18030", "x-gbk": "gb18030", utf8: "utf-8", "ks_c_5601-1987": "euc-kr" };

export function decodeText(bytes, charset = "utf-8") {
  const cs = String(charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(CHARSET_ALIASES[cs] || cs).decode(bytes);
  } catch {
    return utf8Decode(bytes);
  }
}

/** Decodes bytes whose charset is unknown (raw 8-bit headers): UTF-8 if valid, otherwise GB18030. */
export function decodeUnknown(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeText(bytes, "gb18030");
  }
}

function qDecode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "_") out.push(32);
    else if (c === "=" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else for (const b of enc.encode(c)) out.push(b);
  }
  return new Uint8Array(out);
}

/** RFC 2047 encoded-words; adjacent words in the same charset are joined before decoding so split multibyte characters survive. */
export function decodeHeader(value) {
  const s = String(value ?? "");
  const re = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  let out = "";
  let last = 0;
  let pending = [];
  let pendingCharset = null;
  const flush = () => {
    if (pendingCharset) out += decodeText(concatBytes(pending), pendingCharset);
    pending = [];
    pendingCharset = null;
  };
  for (const m of s.matchAll(re)) {
    const between = s.slice(last, m.index);
    if (!(pendingCharset && /^\s*$/.test(between))) {
      flush();
      out += between;
    }
    const charset = m[1].split("*")[0].toLowerCase();
    if (pendingCharset && pendingCharset !== charset) flush();
    let bytes;
    try {
      bytes = m[2].toLowerCase() === "b" ? base64Decode(m[3]) : qDecode(m[3]);
    } catch {
      bytes = enc.encode(m[0]);
    }
    pendingCharset = charset;
    pending.push(bytes);
    last = m.index + m[0].length;
  }
  flush();
  return out + s.slice(last);
}

/** Parses a raw header block; the first occurrence of each header wins. */
export function parseHeaders(text) {
  const res = {};
  for (const line of String(text).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (m) {
      const k = m[1].toLowerCase();
      if (!(k in res)) res[k] = decodeHeader(m[2]).trim();
    }
  }
  return res;
}

export function splitHeaderBody(s) {
  let i = s.indexOf("\r\n\r\n");
  if (i >= 0) return [s.slice(0, i), s.slice(i + 4)];
  i = s.indexOf("\n\n");
  return i >= 0 ? [s.slice(0, i), s.slice(i + 2)] : [s, ""];
}

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", yen: "¥", times: "×" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  const text = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?href\s*=\s*["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, label) => {
      const t = label.replace(/<[^>]+>/g, "").trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|tr|h[1-6]|table|blockquote|ul|ol|section|article)\s*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTopLevel(s, sep) {
  const out = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && quoted) {
      cur += c + (s[++i] ?? "");
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle++;
    else if (!quoted && c === ">") angle = Math.max(0, angle - 1);
    if (!quoted && !angle && sep.includes(c)) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidAddress(a) {
  return typeof a === "string" && a.length <= 254 && ADDRESS_RE.test(a);
}

/** Parses "Name <a@b>, c@d" (or an array of such strings) into {name, address} pairs. */
export function parseAddressList(input) {
  const items = Array.isArray(input) ? input.flatMap((x) => splitTopLevel(String(x ?? ""), ",;")) : splitTopLevel(String(input ?? ""), ",;");
  const out = [];
  for (let raw of items) {
    raw = raw.trim().replace(/^[^"<]*:\s*/, (m) => (m.includes("@") ? m : ""));
    if (!raw || raw === ";") continue;
    const m = /^(.*?)<\s*([^<>\s]+)\s*>\s*;?$/.exec(raw);
    const name = m ? m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim() : "";
    const address = (m ? m[2] : raw.replace(/;$/, "")).trim();
    out.push({ name, address });
  }
  return out;
}

export function formatAddressForDisplay({ name, address }) {
  return name ? `${name} <${address}>` : address;
}

function stripControl(s) {
  return String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
}

/** RFC 2047 B-encoding split into words of at most ~75 chars without breaking UTF-8 sequences. */
export function encodeWords(s) {
  const words = [];
  let buf = [];
  let len = 0;
  for (const ch of s) {
    const b = enc.encode(ch);
    if (len + b.length > 45 && buf.length) {
      words.push(`=?UTF-8?B?${base64Encode(concatBytes(buf))}?=`);
      buf = [];
      len = 0;
    }
    buf.push(b);
    len += b.length;
  }
  if (buf.length) words.push(`=?UTF-8?B?${base64Encode(concatBytes(buf))}?=`);
  return words.join("\r\n ");
}

export function encodeHeaderText(s) {
  const v = stripControl(s).trim();
  if (/^[\x20-\x7e]*$/.test(v) && v.length < 900) return v;
  return encodeWords(v);
}

function encodePhrase(name) {
  const v = stripControl(name).trim();
  if (!v) return "";
  if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(v)) return v;
  if (/^[\x20-\x7e]*$/.test(v)) return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  return encodeWords(v);
}

export function formatAddressHeader(list) {
  return list.map(({ name, address }) => (name ? `${encodePhrase(name)} <${address}>` : address)).join(",\r\n ");
}

function sanitizeFilename(name) {
  const v = stripControl(name).replace(/["\\/]/g, "_").trim().slice(0, 200);
  return v || "attachment";
}

export function sanitizeContentType(ct) {
  const v = String(ct || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v) ? v : "application/octet-stream";
}

function filenameParams(filename) {
  const f = sanitizeFilename(filename);
  if (/^[\x20-\x7e]*$/.test(f)) return { name: `"${f}"`, disposition: `filename="${f}"` };
  const encoded = encodeURIComponent(f).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const word = encodeWords(f).replace(/\r\n /g, " ");
  return { name: `"${word}"`, disposition: `filename="${word}";\r\n filename*=UTF-8''${encoded}` };
}

export function boundary() {
  return "----=_qqmcp_" + crypto.randomUUID().replace(/-/g, "");
}

function textPart(contentType, text) {
  return `Content-Type: ${contentType}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` + base64Encode(enc.encode(String(text ?? "").replace(/\r?\n/g, "\r\n")), 76);
}

function multipart(subtype, parts) {
  const b = boundary();
  return `Content-Type: multipart/${subtype};\r\n boundary="${b}"\r\n\r\nThis is a multi-part message in MIME format.\r\n` + parts.map((p) => `--${b}\r\n${p}\r\n`).join("") + `--${b}--\r\n`;
}

export function attachmentPart({ filename, contentType, data }) {
  const fp = filenameParams(filename);
  return `Content-Type: ${sanitizeContentType(contentType)}; name=${fp.name}\r\nContent-Disposition: attachment; ${fp.disposition}\r\nContent-Transfer-Encoding: base64\r\n\r\n` + base64Encode(data, 76);
}

export function rfc5322Date(d = new Date()) {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

export function newMessageId(fromAddress) {
  const domain = String(fromAddress).split("@")[1] || "qqmail-mcp.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * Builds an RFC 5322 message as an ASCII string with CRLF line endings.
 * `rawParts` are pre-encoded MIME parts (headers + body) passed through verbatim, e.g. forwarded attachments.
 */
export function buildMessage(o) {
  const headers = [
    ["MIME-Version", "1.0"],
    ["Date", rfc5322Date(o.date)],
    ["From", formatAddressHeader([o.from])],
  ];
  if (o.to?.length) headers.push(["To", formatAddressHeader(o.to)]);
  if (o.cc?.length) headers.push(["Cc", formatAddressHeader(o.cc)]);
  if (o.includeBcc && o.bcc?.length) headers.push(["Bcc", formatAddressHeader(o.bcc)]);
  headers.push(["Subject", encodeHeaderText(o.subject || "")]);
  headers.push(["Message-ID", o.messageId || newMessageId(o.from.address)]);
  if (o.inReplyTo) headers.push(["In-Reply-To", o.inReplyTo]);
  if (o.references) headers.push(["References", o.references.split(/\s+/).filter(Boolean).slice(-20).join("\r\n ")]);
  headers.push(["X-Mailer", o.mailer || "qqmail-mcp"]);

  const text = o.text ?? (o.html ? htmlToText(o.html) : "");
  let body = o.html ? multipart("alternative", [textPart("text/plain", text), textPart("text/html", o.html)]) : textPart("text/plain", text);
  const extra = [...(o.attachments || []).map(attachmentPart), ...(o.rawParts || [])];
  if (extra.length) body = multipart("mixed", [body, ...extra]);
  return headers.map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n" + body;
}

/** Removes every instance of a header (with folded continuation lines) from a raw message held as a binary string. */
export function removeHeader(raw, name) {
  const m = /\r?\n\r?\n/.exec(raw);
  const headEnd = m ? m.index : raw.length;
  const lines = raw.slice(0, headEnd).split(/\r?\n/);
  const out = [];
  let skipping = false;
  const prefix = name.toLowerCase() + ":";
  for (const line of lines) {
    if (/^[ \t]/.test(line) && skipping) continue;
    skipping = line.toLowerCase().startsWith(prefix);
    if (!skipping) out.push(line);
  }
  return out.join("\r\n") + raw.slice(headEnd);
}

export function prefixSubject(subject, kind) {
  const s = String(subject || "").trim();
  if (kind === "re") return /^(re|回复|答复)\s*[:：]/i.test(s) ? s : `Re: ${s}`;
  return /^(fwd?|转发)\s*[:：]/i.test(s) ? s : `Fwd: ${s}`;
}

export function quoteText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}
