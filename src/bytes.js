export const enc = new TextEncoder();
const utf8 = new TextDecoder();

export function utf8Decode(b) {
  return utf8.decode(b);
}

export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Latin-1 view of bytes; used for ASCII protocol text where every byte must survive. */
export function bytesToBinary(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return s;
}

export function binaryToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;
B64_INDEX["-".charCodeAt(0)] = 62;
B64_INDEX["_".charCodeAt(0)] = 63;

export function base64Encode(bytes, lineLength = 0) {
  const parts = [];
  let line = "";
  const push = (s) => {
    if (!lineLength) return parts.push(s);
    line += s;
    while (line.length >= lineLength) {
      parts.push(line.slice(0, lineLength), "\r\n");
      line = line.slice(lineLength);
    }
  };
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b === undefined ? "=" : B64[(n >> 6) & 63]) + (c === undefined ? "=" : B64[n & 63]);
    if (chunk.length >= 4096) {
      push(chunk);
      chunk = "";
    }
  }
  if (chunk) push(chunk);
  if (lineLength && line) parts.push(line, "\r\n");
  return parts.join("");
}

export function base64UrlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Incremental base64 decoder that ignores whitespace and tolerates chunk boundaries anywhere.
 * Accepts standard and URL-safe alphabets.
 */
export class Base64Decoder {
  constructor() {
    this.acc = 0;
    this.bits = 0;
  }
  push(input) {
    const out = new Uint8Array(Math.ceil((input.length * 3) / 4) + 3);
    let o = 0;
    for (let i = 0; i < input.length; i++) {
      const v = B64_INDEX[input[i]];
      if (v < 0) continue;
      this.acc = ((this.acc << 6) | v) & 0xffffff;
      this.bits += 6;
      if (this.bits >= 8) {
        this.bits -= 8;
        out[o++] = (this.acc >> this.bits) & 255;
      }
    }
    return out.subarray(0, o);
  }
}

export function base64Decode(input) {
  const bytes = typeof input === "string" ? binaryToBytes(input) : input;
  return new Base64Decoder().push(bytes).slice();
}

export function isValidBase64(s) {
  return typeof s === "string" && /^[A-Za-z0-9+/_\-\s]*={0,2}\s*$/.test(s);
}

/** Incremental quoted-printable decoder (soft line breaks and =XX escapes may straddle chunks). */
export class QuotedPrintableDecoder {
  constructor() {
    this.tail = new Uint8Array(0);
  }
  push(input, final = false) {
    const data = this.tail.length ? concatBytes([this.tail, input]) : input;
    const out = new Uint8Array(data.length);
    let o = 0, i = 0;
    const hex = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
    while (i < data.length) {
      const c = data[i];
      if (c !== 61) {
        out[o++] = c;
        i++;
        continue;
      }
      if (i + 2 >= data.length && !final) break;
      const a = data[i + 1], b = data[i + 2];
      if (a === 13 && b === 10) i += 3;
      else if (a === 10) i += 2;
      else if (hex(a) >= 0 && hex(b) >= 0) {
        out[o++] = hex(a) * 16 + hex(b);
        i += 3;
      } else {
        out[o++] = c;
        i++;
      }
    }
    this.tail = data.slice(i);
    return out.subarray(0, o);
  }
}

export function makeTransferDecoder(encoding) {
  const e = String(encoding || "").toLowerCase();
  if (e === "base64") {
    const d = new Base64Decoder();
    return { push: (b) => d.push(b), end: () => new Uint8Array(0) };
  }
  if (e === "quoted-printable") {
    const d = new QuotedPrintableDecoder();
    return { push: (b) => d.push(b), end: () => d.push(new Uint8Array(0), true) };
  }
  return { push: (b) => b, end: () => new Uint8Array(0) };
}

export function decodeTransfer(bytes, encoding) {
  const d = makeTransferDecoder(encoding);
  return concatBytes([d.push(bytes), d.end()]);
}

/** Buffered reader over a ReadableStream of Uint8Array chunks, shared by the IMAP and SMTP clients. */
export class ByteReader {
  constructor(readable, { maxBytes = Infinity, onClosed = "connection closed" } = {}) {
    this.reader = readable.getReader();
    this.chunks = [];
    this.length = 0;
    this.received = 0;
    this.maxBytes = maxBytes;
    this.onClosed = onClosed;
  }
  async pull() {
    const r = await this.reader.read();
    if (r.done) throw new Error(this.onClosed);
    if (r.value?.length) {
      this.received += r.value.length;
      if (this.received > this.maxBytes) throw new Error("Server response too large");
      this.chunks.push(r.value);
      this.length += r.value.length;
    }
  }
  take(n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o);
      o += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.length -= n;
    return out;
  }
  indexOfLF() {
    let base = 0;
    for (const c of this.chunks) {
      const i = c.indexOf(10);
      if (i >= 0) return base + i;
      base += c.length;
    }
    return -1;
  }
  /** Returns one line (without CRLF) as raw bytes. */
  async line(maxLength = 4_000_000) {
    let i;
    while ((i = this.indexOfLF()) < 0) {
      if (this.length > maxLength) throw new Error("Server line too long");
      await this.pull();
    }
    const b = this.take(i + 1);
    const end = b.length >= 2 && b[b.length - 2] === 13 ? b.length - 2 : b.length - 1;
    return b.subarray(0, end);
  }
  async exact(n) {
    while (this.length < n) await this.pull();
    return this.take(n);
  }
  /** Returns up to `max` bytes, waiting for at least one. */
  async upTo(max) {
    if (!this.length) await this.pull();
    return this.take(Math.min(this.length, max));
  }
  release() {
    try {
      this.reader.releaseLock();
    } catch {}
  }
}
