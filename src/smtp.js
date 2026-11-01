import { ByteReader, base64Encode, enc, utf8Decode } from "./bytes.js";
import { MailError } from "./errors.js";
import { SMTP_HOST, SMTP_PORT, LIMITS } from "./config.js";
import { checkMailboxConfig } from "./imap.js";

/** Normalizes line endings to CRLF, dot-stuffs, and appends the DATA terminator. */
export function smtpData(bytes) {
  const out = new Uint8Array(bytes.length * 2 + 5);
  let o = 0;
  let lineStart = true;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 13 && bytes[i + 1] === 10) continue;
    if (c === 10 || c === 13) {
      out[o++] = 13;
      out[o++] = 10;
      lineStart = true;
      continue;
    }
    if (lineStart && c === 46) out[o++] = 46;
    out[o++] = c;
    lineStart = false;
  }
  if (!lineStart) {
    out[o++] = 13;
    out[o++] = 10;
  }
  out.set([46, 13, 10], o);
  return out.subarray(0, o + 3);
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.in = new ByteReader(socket.readable, { maxBytes: 1_000_000, onClosed: "SMTP connection closed" });
    this.out = socket.writable.getWriter();
  }
  async reply() {
    const lines = [];
    for (;;) {
      const line = utf8Decode(await this.in.line(64_000));
      lines.push(line);
      if (!/^\d{3}-/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join(" ").trim() };
    }
  }
  async send(line, expect, what) {
    await this.out.write(enc.encode(line + "\r\n"));
    return this.expect(expect, what);
  }
  async expect(codes, what) {
    const r = await this.reply();
    if (!codes.includes(r.code)) throw new MailError(`SMTP ${what} failed (${r.code}${r.text ? ": " + r.text.slice(0, 200) : ""})`);
    return r;
  }
  async writeChunks(bytes) {
    for (let i = 0; i < bytes.length; i += 64 * 1024) await this.out.write(bytes.subarray(i, i + 64 * 1024));
  }
  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

/**
 * Sends one message through QQ SMTP. `recipients` are envelope addresses (To + Cc + Bcc);
 * `message` is the full RFC 5322 message as a string or bytes.
 */
export async function sendMail(env, connect, { recipients, message }, { timeoutMs = LIMITS.sendTimeoutMs } = {}) {
  checkMailboxConfig(env);
  if (!recipients.length) throw new MailError("At least one recipient is required");
  const socket = connect({ hostname: env.SMTP_HOST || SMTP_HOST, port: Number(env.SMTP_PORT) || SMTP_PORT }, { secureTransport: "on" });
  const s = new SmtpSession(socket);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    s.close();
  }, timeoutMs);
  try {
    await socket.opened;
    await s.expect([220], "greeting");
    await s.send("EHLO qqmail-mcp", [250], "EHLO");
    await s.send("AUTH LOGIN", [334], "AUTH");
    await s.send(base64Encode(enc.encode(env.QQ_EMAIL)), [334], "AUTH");
    try {
      await s.send(base64Encode(enc.encode(env.QQ_APP_PASSWORD)), [235], "AUTH");
    } catch {
      throw new MailError("QQ SMTP login failed. Check the QQ authorization code and that SMTP is enabled in QQ Mail settings.");
    }
    await s.send(`MAIL FROM:<${env.QQ_EMAIL}>`, [250], "MAIL FROM");
    const rejected = [];
    for (const rcpt of recipients) {
      try {
        await s.send(`RCPT TO:<${rcpt}>`, [250, 251], "RCPT TO");
      } catch (e) {
        rejected.push({ address: rcpt, reason: e.message });
      }
    }
    if (rejected.length === recipients.length) throw new MailError(`All recipients were rejected: ${rejected.map((r) => r.reason).join("; ")}`);
    await s.send("DATA", [354], "DATA");
    await s.writeChunks(smtpData(typeof message === "string" ? enc.encode(message) : message));
    const done = await s.expect([250], "message delivery");
    try {
      await s.send("QUIT", [221], "QUIT");
    } catch {}
    return { accepted: recipients.filter((r) => !rejected.some((x) => x.address === r)), rejected, server_response: done.text.slice(0, 200) };
  } catch (e) {
    if (timedOut) throw new MailError("QQ SMTP did not respond in time; the message may not have been sent.");
    if (e instanceof MailError) throw e;
    throw new MailError("Could not reach QQ SMTP (smtp.qq.com:465).", { cause: e });
  } finally {
    clearTimeout(timer);
    s.close();
  }
}

/** Connectivity + credential check without sending anything. */
export async function checkSmtp(env, connect) {
  checkMailboxConfig(env);
  const socket = connect({ hostname: env.SMTP_HOST || SMTP_HOST, port: Number(env.SMTP_PORT) || SMTP_PORT }, { secureTransport: "on" });
  const s = new SmtpSession(socket);
  const timer = setTimeout(() => s.close(), 15_000);
  try {
    await socket.opened;
    await s.expect([220], "greeting");
    await s.send("EHLO qqmail-mcp", [250], "EHLO");
    await s.send("AUTH LOGIN", [334], "AUTH");
    await s.send(base64Encode(enc.encode(env.QQ_EMAIL)), [334], "AUTH");
    await s.send(base64Encode(enc.encode(env.QQ_APP_PASSWORD)), [235], "AUTH");
    try {
      await s.send("QUIT", [221], "QUIT");
    } catch {}
    return { connected: true };
  } catch (e) {
    return { connected: false, error: e instanceof MailError ? e.message : "Could not reach QQ SMTP" };
  } finally {
    clearTimeout(timer);
    s.close();
  }
}
