import { base64Encode, base64Decode, utf8Decode, enc } from "./bytes.js";
import { decodeHeader } from "./mime.js";

/**
 * Parses one IMAP response made of text segments and literal byte segments into nested values:
 * atoms and quoted strings become strings, NIL becomes null, literals stay Uint8Array, lists become arrays.
 */
export function parseResponse(segments) {
  let si = 0;
  let pos = 0;
  const peek = () => {
    while (si < segments.length) {
      const s = segments[si];
      if (typeof s !== "string") return s;
      if (pos < s.length) return s[pos];
      si++;
      pos = 0;
    }
    return undefined;
  };
  const readQuoted = () => {
    const s = segments[si];
    let out = "";
    pos++;
    while (pos < s.length) {
      const c = s[pos++];
      if (c === "\\") out += s[pos++] ?? "";
      else if (c === '"') return out;
      else out += c;
    }
    return out;
  };
  const readAtom = () => {
    const s = segments[si];
    let depth = 0;
    const start = pos;
    while (pos < s.length) {
      const c = s[pos];
      if (c === "[") depth++;
      else if (c === "]") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === " " || c === "(" || c === ")")) break;
      pos++;
    }
    const atom = s.slice(start, pos);
    return atom.toUpperCase() === "NIL" ? null : atom;
  };
  const parseList = (close) => {
    const out = [];
    for (;;) {
      const c = peek();
      if (c === undefined) return out;
      if (c instanceof Uint8Array) {
        out.push(c);
        si++;
        pos = 0;
      } else if (c === " ") pos++;
      else if (c === close) {
        pos++;
        return out;
      } else if (c === "(") {
        pos++;
        out.push(parseList(")"));
      } else if (c === ")") pos++;
      else if (c === '"') out.push(readQuoted());
      else out.push(readAtom());
    }
  };
  return parseList(null);
}

export function str(v) {
  if (v == null) return "";
  if (v instanceof Uint8Array) return utf8Decode(v);
  return String(v);
}

/** Converts a FETCH attribute list into a map; BODY[...] keys drop their partial-range suffix. */
export function fetchAttributes(list) {
  const map = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = String(list[i]).toUpperCase().replace(/^(BODY\[.*\])<\d+>$/, "$1");
    map[key] = list[i + 1];
  }
  return map;
}

export function bodySection(attrs, section) {
  const want = ("BODY[" + section + "]").toUpperCase();
  if (want in attrs) return attrs[want];
  const prefix = want.slice(0, -1);
  const key = Object.keys(attrs).find((k) => k.startsWith(prefix));
  return key ? attrs[key] : undefined;
}

export function imapQuote(s) {
  const v = String(s);
  if (/[\r\n\x00]/.test(v)) throw new Error("Invalid IMAP argument");
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function isImapAscii(s) {
  return /^[\x20-\x7e]*$/.test(String(s));
}

/** RFC 3501 modified UTF-7 for mailbox names. */
export function encodeMailboxName(name) {
  let out = "";
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const bytes = new Uint8Array(pending.length * 2);
    pending.forEach((u, i) => {
      bytes[i * 2] = u >> 8;
      bytes[i * 2 + 1] = u & 255;
    });
    out += "&" + base64Encode(bytes).replace(/=+$/, "").replace(/\//g, ",") + "-";
    pending = [];
  };
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x26 ? "&-" : name[i];
    } else pending.push(c);
  }
  flush();
  return out;
}

export function decodeMailboxName(name) {
  return String(name).replace(/&([^-]*)-/g, (_, b) => {
    if (!b) return "&";
    const bytes = base64Decode(b.replace(/,/g, "/"));
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  });
}

function paramsMap(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (let i = 0; i + 1 < list.length; i += 2) out[str(list[i]).toLowerCase()] = str(list[i + 1]);
  return out;
}

/** RFC 2231 parameter continuations/charsets, then RFC 2047 encoded-words as a fallback. */
export function paramValue(params, name) {
  if (params[name]) return decodeHeader(params[name]);
  const ext = params[name + "*"];
  if (ext) return decode2231(ext, true);
  let charset = "utf-8";
  let raw = "";
  for (let i = 0; i < 100; i++) {
    const extended = params[`${name}*${i}*`];
    const plain = params[`${name}*${i}`];
    if (extended === undefined && plain === undefined) break;
    if (extended === undefined) {
      raw += encodeURIComponent(plain);
      continue;
    }
    let v = extended;
    const m = i === 0 ? /^([^']*)'[^']*'/.exec(v) : null;
    if (m) {
      charset = m[1] || "utf-8";
      v = v.slice(m[0].length);
    }
    raw += v;
  }
  return raw ? percentDecode(raw, charset) : "";
}

function decode2231(v, extended) {
  const m = extended ? /^([^']*)'[^']*'(.*)$/.exec(v) : null;
  return m ? percentDecode(m[2], m[1] || "utf-8") : decodeHeader(v);
}

function percentDecode(s, charset) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else for (const b of enc.encode(s[i])) bytes.push(b);
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return utf8Decode(new Uint8Array(bytes));
  }
}

/**
 * Flattens a BODYSTRUCTURE into leaf parts with IMAP section numbers.
 * Nested message/rfc822 parts are kept as a single leaf (downloadable as .eml).
 */
export function flattenBodyStructure(bs) {
  const leaves = [];
  const walk = (node, section) => {
    if (!Array.isArray(node)) return;
    if (Array.isArray(node[0])) {
      let i = 0;
      for (; i < node.length && Array.isArray(node[i]); i++) walk(node[i], section ? `${section}.${i + 1}` : String(i + 1));
      return;
    }
    const type = str(node[0]).toLowerCase();
    const subtype = str(node[1]).toLowerCase();
    const params = paramsMap(node[2]);
    let ext = 7;
    if (type === "text") ext = 8;
    else if (type === "message" && subtype === "rfc822") ext = 10;
    const dsp = Array.isArray(node[ext + 1]) ? node[ext + 1] : null;
    const disposition = dsp ? str(dsp[0]).toLowerCase() : "";
    const dparams = dsp ? paramsMap(dsp[1]) : {};
    const filename = paramValue(dparams, "filename") || paramValue(params, "name");
    leaves.push({
      section: section || "1",
      type: `${type}/${subtype}`,
      charset: params.charset || "",
      content_id: str(node[3]).replace(/^<|>$/g, ""),
      encoding: str(node[5]).toLowerCase() || "7bit",
      size: Number(str(node[6])) || 0,
      disposition,
      filename,
    });
  };
  walk(bs, "");
  const single = Array.isArray(bs) && !Array.isArray(bs[0]);
  return leaves.map((p) => ({ ...p, fetch_section: single ? "TEXT" : p.section }));
}

export function isAttachment(part) {
  if (part.disposition === "attachment") return true;
  if (part.type === "message/rfc822") return true;
  if (part.filename) return true;
  return !/^text\/(plain|html)$/.test(part.type) && !/^multipart\//.test(part.type);
}

export function estimateDecodedSize(part) {
  // base64 bodies are wrapped at 76 chars + CRLF
  return part.encoding === "base64" ? Math.floor(((part.size * 76) / 78) * 0.75) : part.size;
}
