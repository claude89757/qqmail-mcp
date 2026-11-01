import { base64Encode, concatBytes, enc } from "../../src/bytes.js";

const dec = new TextDecoder();

/** A minimal Socket (cloudflare:sockets shape) wired to an in-process protocol handler. */
function socketFor(handler) {
  let controller;
  let closed = false;
  const readable = new ReadableStream({ start: (c) => (controller = c) });
  const send = (s) => {
    if (!closed) controller.enqueue(typeof s === "string" ? enc.encode(s) : s);
  };
  const writable = new WritableStream({ write: (chunk) => handler.receive(chunk, send) });
  handler.start(send);
  return {
    readable,
    writable,
    opened: Promise.resolve({}),
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {}
    },
  };
}

export function fakeConnect({ imap, smtp }) {
  const calls = [];
  const fn = (addr, opts) => {
    calls.push({ ...addr, ...opts });
    if (addr.hostname === "imap.qq.com") return socketFor(imap.session());
    if (addr.hostname === "smtp.qq.com") return socketFor(smtp.session());
    throw new Error("unexpected host " + addr.hostname);
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------------------------
// Message fixtures

function q(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function leafStructure(p) {
  const [type, subtype] = p.type.toUpperCase().split("/");
  const params = Object.entries(p.params || {}).flatMap(([k, v]) => [q(k), q(v)]);
  const paramList = params.length ? `(${params.join(" ")})` : "NIL";
  const dsp = p.disposition ? `(${q(p.disposition.toUpperCase())} ${p.filename ? `(${q("FILENAME")} ${q(p.filename)})` : "NIL"})` : "NIL";
  const size = p.encoded.length;
  const id = p.contentId ? q(`<${p.contentId}>`) : "NIL";
  if (type === "TEXT") return `(${q(type)} ${q(subtype)} ${paramList} ${id} NIL ${q(p.encoding.toUpperCase())} ${size} ${p.encoded.split("\n").length} NIL ${dsp} NIL NIL)`;
  return `(${q(type)} ${q(subtype)} ${paramList} ${id} NIL ${q(p.encoding.toUpperCase())} ${size} NIL ${dsp} NIL NIL)`;
}

/** Builds a stored message: header text, BODYSTRUCTURE string and section contents. */
export function makeMessage({ headers, parts, flags = [], internalDate = "01-Nov-2026 10:00:00 +0800" }) {
  const encoded = parts.map((p) => ({ ...p, encoded: p.encoding === "base64" ? base64Encode(enc.encode(p.content), 76).trimEnd() : p.content }));
  const header = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n";
  const sections = {};
  let bodystructure;
  let body;
  if (encoded.length === 1) {
    bodystructure = leafStructure(encoded[0]);
    sections.TEXT = sections["1"] = encoded[0].encoded;
    body = encoded[0].encoded;
  } else {
    bodystructure = `(${encoded.map(leafStructure).join("")} "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)`;
    encoded.forEach((p, i) => (sections[String(i + 1)] = p.encoded));
    body = encoded.map((p) => `--b1\r\nContent-Type: ${p.type}\r\nContent-Transfer-Encoding: ${p.encoding}\r\n\r\n${p.encoded}\r\n`).join("") + "--b1--\r\n";
  }
  const extraHeader = encoded.length === 1 ? `Content-Type: ${encoded[0].type}; charset=UTF-8\r\nContent-Transfer-Encoding: ${encoded[0].encoding}\r\n` : 'Content-Type: multipart/mixed; boundary="b1"\r\n';
  const fullHeader = header.replace(/\r\n\r\n$/, "\r\n") + extraHeader + "\r\n";
  return { header: fullHeader, bodystructure, sections, raw: fullHeader + body, flags: new Set(flags), internalDate };
}

// ---------------------------------------------------------------------------------------------
// IMAP

export class FakeImapServer {
  constructor({ user, password, folders, caps = "IMAP4rev1 MOVE UIDPLUS", emptyDeletedSearch = false, noopExpunge = false }) {
    this.user = user;
    this.password = password;
    this.caps = caps;
    this.emptyDeletedSearch = emptyDeletedSearch;
    this.noopExpunge = noopExpunge;
    this.folders = {};
    for (const [name, def] of Object.entries(folders)) {
      this.folders[name] = { flags: def.flags || [], nextUid: 1, messages: [] };
      for (const m of def.messages || []) this.add(name, m, m.uid);
    }
    this.commands = [];
    this.literals = [];
  }
  add(folder, msg, uid) {
    const f = this.folders[folder];
    const id = uid ?? f.nextUid;
    f.nextUid = Math.max(f.nextUid, id + 1);
    f.messages.push({ ...msg, uid: id, flags: new Set(msg.flags || []) });
    return id;
  }
  find(folder, uid) {
    return this.folders[folder]?.messages.find((m) => m.uid === uid);
  }
  session() {
    return new FakeImapSession(this);
  }
}

function parseSet(s) {
  return s.split(",").flatMap((r) => {
    const [a, b] = r.split(":").map(Number);
    if (!b) return [a];
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  });
}

function unquote(s) {
  return s.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1");
}

class FakeImapSession {
  constructor(server) {
    this.server = server;
    this.buf = new Uint8Array(0);
    this.partial = "";
    this.literals = [];
    this.need = 0;
    this.selected = null;
  }
  start(send) {
    this.send = send;
    send("* OK [CAPABILITY IMAP4rev1] fake QQ IMAP ready\r\n");
  }
  receive(chunk) {
    this.buf = concatBytes([this.buf, chunk]);
    for (;;) {
      if (this.need) {
        if (this.buf.length < this.need) return;
        this.literals.push(this.buf.slice(0, this.need));
        this.partial += "\u0000";
        this.buf = this.buf.slice(this.need);
        this.need = 0;
        continue;
      }
      const i = this.buf.indexOf(10);
      if (i < 0) return;
      const line = dec.decode(this.buf.slice(0, i)).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      const m = /\{(\d+)\}$/.exec(line);
      if (m) {
        this.partial += line.slice(0, m.index);
        this.need = Number(m[1]);
        this.send("+ go ahead\r\n");
        continue;
      }
      const full = this.partial + line;
      const literals = this.literals;
      this.partial = "";
      this.literals = [];
      this.handle(full, literals);
    }
  }
  handle(line, literals) {
    const s = this.server;
    s.commands.push(line);
    s.literals.push(...literals);
    const [tag, ...rest] = line.split(" ");
    const cmdLine = rest.join(" ");
    const upper = cmdLine.toUpperCase();
    const ok = (t = "completed") => this.send(`${tag} OK ${t}\r\n`);
    const no = (t = "failed") => this.send(`${tag} NO ${t}\r\n`);
    const folder = () => s.folders[this.selected];
    if (upper.startsWith("LOGIN ")) {
      const m = /^LOGIN ("(?:[^"\\]|\\.)*"|\u0000) ("(?:[^"\\]|\\.)*"|\u0000)$/i.exec(cmdLine);
      const vals = [];
      let li = 0;
      for (const v of [m[1], m[2]]) vals.push(v === "\u0000" ? dec.decode(literals[li++]) : unquote(v));
      if (vals[0] === s.user && vals[1] === s.password) return ok(`[CAPABILITY ${s.caps}] LOGIN completed`);
      return no("[AUTHENTICATIONFAILED] Login fail");
    }
    if (upper === "CAPABILITY") {
      this.send(`* CAPABILITY ${s.caps}\r\n`);
      return ok();
    }
    if (upper === "LOGOUT") {
      this.send("* BYE\r\n");
      return ok();
    }
    if (upper.startsWith("LIST ")) {
      for (const [name, f] of Object.entries(s.folders)) this.send(`* LIST (${f.flags.join(" ")}) "/" ${q(name)}\r\n`);
      return ok();
    }
    if (upper.startsWith("STATUS ")) {
      const name = unquote(/^STATUS ("(?:[^"\\]|\\.)*"|\S+)/i.exec(cmdLine)[1]);
      const f = s.folders[name];
      if (!f) return no();
      const unseen = f.messages.filter((m) => !m.flags.has("\\Seen")).length;
      this.send(`* STATUS ${q(name)} (MESSAGES ${f.messages.length} UNSEEN ${unseen} UIDNEXT ${f.nextUid} UIDVALIDITY 1)\r\n`);
      return ok();
    }
    if (upper.startsWith("SELECT ") || upper.startsWith("EXAMINE ")) {
      const name = unquote(cmdLine.slice(cmdLine.indexOf(" ") + 1));
      if (!s.folders[name]) return no("Mailbox does not exist");
      this.selected = name;
      this.send(`* ${s.folders[name].messages.length} EXISTS\r\n`);
      return ok(upper.startsWith("SELECT") ? "[READ-WRITE] SELECT completed" : "[READ-ONLY] EXAMINE completed");
    }
    if (upper.startsWith("APPEND ")) {
      const m = /^APPEND ("(?:[^"\\]|\\.)*") \(([^)]*)\) \u0000$/i.exec(cmdLine);
      const name = unquote(m[1]);
      if (!s.folders[name]) return no();
      const raw = dec.decode(literals[0]);
      const header = raw.slice(0, raw.indexOf("\r\n\r\n") + 4);
      const uid = s.add(name, { header, raw, sections: { "": raw }, bodystructure: '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1 NIL NIL NIL NIL)', flags: m[2].split(" ").filter(Boolean), internalDate: "01-Nov-2026 10:00:00 +0800" });
      return ok(`[APPENDUID 1 ${uid}] APPEND completed`);
    }
    if (!folder()) return this.send(`${tag} BAD No mailbox selected\r\n`);
    if (upper.startsWith("UID SEARCH")) {
      let msgs = folder().messages;
      if (/\bUNSEEN\b/.test(upper)) msgs = msgs.filter((m) => !m.flags.has("\\Seen"));
      if (/\bFLAGGED\b/.test(upper)) msgs = msgs.filter((m) => m.flags.has("\\Flagged"));
      if (/\bDELETED\b/.test(upper)) msgs = s.emptyDeletedSearch ? [] : msgs.filter((m) => m.flags.has("\\Deleted"));
      const uidm = /\bUID ([\d,:]+)/.exec(cmdLine.slice(10));
      if (uidm) msgs = msgs.filter((m) => parseSet(uidm[1]).includes(m.uid));
      const hm = /HEADER Message-ID ("(?:[^"\\]|\\.)*")/i.exec(cmdLine);
      if (hm) msgs = msgs.filter((m) => m.header.includes(unquote(hm[1])));
      const tm = /\bTEXT ("(?:[^"\\]|\\.)*"|\u0000)/i.exec(cmdLine);
      if (tm) {
        const needle = tm[1] === "\u0000" ? dec.decode(literals[0]) : unquote(tm[1]);
        msgs = msgs.filter((m) => (m.raw + JSON.stringify(m.text || "")).includes(needle) || (m.searchText || "").includes(needle));
      }
      this.send(`* SEARCH ${msgs.map((m) => m.uid).join(" ")}\r\n`.replace(" \r\n", "\r\n"));
      return ok();
    }
    if (upper.startsWith("UID FETCH ")) {
      const m = /^UID FETCH (\S+) \((.*)\)$/i.exec(cmdLine);
      const set = parseSet(m[1]);
      const items = m[2].match(/BODY\.PEEK\[[^\]]*\](?:<\d+\.\d+>)?|[A-Z0-9.]+/gi);
      folder().messages.forEach((msg, i) => {
        if (!set.includes(msg.uid)) return;
        const parts = [];
        const literalsOut = [];
        for (const it of items) {
          const u = it.toUpperCase();
          if (u === "UID") parts.push(`UID ${msg.uid}`);
          else if (u === "FLAGS") parts.push(`FLAGS (${[...msg.flags].join(" ")})`);
          else if (u === "RFC822.SIZE") parts.push(`RFC822.SIZE ${msg.raw.length}`);
          else if (u === "INTERNALDATE") parts.push(`INTERNALDATE ${q(msg.internalDate)}`);
          else if (u === "BODYSTRUCTURE") parts.push(`BODYSTRUCTURE ${msg.bodystructure}`);
          else if (u.startsWith("BODY.PEEK[")) {
            const bm = /^BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i.exec(it);
            const sec = bm[1].toUpperCase();
            let data = sec.startsWith("HEADER") ? msg.header : sec === "" ? msg.raw : msg.sections[sec];
            if (data === undefined) data = "";
            let bytes = enc.encode(data);
            let key = `BODY[${bm[1]}]`;
            if (bm[2] !== undefined) {
              bytes = bytes.slice(Number(bm[2]), Number(bm[2]) + Number(bm[3]));
              key += `<${bm[2]}>`;
            }
            parts.push(`${key} \u0000`);
            literalsOut.push(bytes);
          }
        }
        const text = `* ${i + 1} FETCH (${parts.join(" ")})\r\n`;
        const pieces = text.split("\u0000");
        const out = [];
        pieces.forEach((p, idx) => {
          if (idx < literalsOut.length) out.push(enc.encode(p + `{${literalsOut[idx].length}}\r\n`), literalsOut[idx]);
          else out.push(enc.encode(p));
        });
        this.send(concatBytes(out));
      });
      return ok();
    }
    if (upper.startsWith("UID STORE ")) {
      const m = /^UID STORE (\S+) ([+-])FLAGS\.SILENT \(([^)]*)\)$/i.exec(cmdLine);
      const flags = m[3].split(" ").filter(Boolean);
      for (const msg of folder().messages) if (parseSet(m[1]).includes(msg.uid)) for (const f of flags) m[2] === "+" ? msg.flags.add(f) : msg.flags.delete(f);
      return ok();
    }
    if (upper.startsWith("UID MOVE ") || upper.startsWith("UID COPY ")) {
      const m = /^UID (MOVE|COPY) (\S+) (".*")$/i.exec(cmdLine);
      const dest = unquote(m[3]);
      if (!s.folders[dest]) return no("[TRYCREATE] no such mailbox");
      const set = parseSet(m[2]);
      for (const msg of [...folder().messages]) {
        if (!set.includes(msg.uid)) continue;
        s.add(dest, { ...msg, flags: [...msg.flags] });
        if (m[1].toUpperCase() === "MOVE") folder().messages.splice(folder().messages.indexOf(msg), 1);
      }
      return ok();
    }
    if (upper.startsWith("UID EXPUNGE ")) {
      const set = parseSet(cmdLine.split(" ")[2]);
      folder().messages = folder().messages.filter((m) => !(set.includes(m.uid) && m.flags.has("\\Deleted")));
      return ok();
    }
    if (upper === "CLOSE") {
      const f = folder();
      if (!s.noopExpunge) f.messages = f.messages.filter((m) => !m.flags.has("\\Deleted"));
      s.selected = null;
      return ok();
    }
    if (upper === "EXPUNGE") {
      if (s.noopExpunge) return ok();
      const f = folder();
      f.messages = f.messages.filter((m) => !m.flags.has("\\Deleted"));
      return ok();
    }
    this.send(`${tag} BAD unknown command\r\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// SMTP

export class FakeSmtpServer {
  constructor({ user, password }) {
    this.user = user;
    this.password = password;
    this.sent = [];
  }
  session() {
    const server = this;
    let buf = "";
    let state = "cmd";
    let mail = null;
    let send;
    const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
    return {
      start(s) {
        send = s;
        send("220 smtp.qq.com Esmtp QQ Mail Server\r\n");
      },
      receive(chunk) {
        buf += dec.decode(chunk);
        for (;;) {
          if (state === "data") {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            mail.data = buf.slice(0, end + 2);
            buf = buf.slice(end + 5);
            server.sent.push(mail);
            state = "cmd";
            send("250 OK: queued as fake\r\n");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) return;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (state === "user") {
            mail = { user: b64(line) };
            state = "pass";
            send("334 UGFzc3dvcmQ6\r\n");
          } else if (state === "pass") {
            state = "cmd";
            if (mail.user === server.user && b64(line) === server.password) send("235 Authentication successful\r\n");
            else send("535 Login Fail. Please enter your authorization code to login\r\n");
          } else if (/^EHLO/i.test(line)) send("250-smtp.qq.com\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n");
          else if (/^AUTH LOGIN$/i.test(line)) {
            state = "user";
            send("334 VXNlcm5hbWU6\r\n");
          } else if (/^MAIL FROM:/i.test(line)) {
            mail = { from: /<(.*)>/.exec(line)[1], rcpt: [] };
            send("250 OK\r\n");
          } else if (/^RCPT TO:/i.test(line)) {
            const a = /<(.*)>/.exec(line)[1];
            if (a.startsWith("reject")) send("550 Mailbox not found\r\n");
            else {
              mail.rcpt.push(a);
              send("250 OK\r\n");
            }
          } else if (/^DATA$/i.test(line)) {
            state = "data";
            send("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (/^QUIT$/i.test(line)) send("221 Bye\r\n");
          else send("502 Command not implemented\r\n");
        }
      },
    };
  }
}
