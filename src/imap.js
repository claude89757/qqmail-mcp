import { ByteReader, enc, utf8Decode, makeTransferDecoder } from "./bytes.js";
import { parseResponse, fetchAttributes, imapQuote, isImapAscii, encodeMailboxName, decodeMailboxName, str } from "./imap-parse.js";
import { MailError } from "./errors.js";
import { IMAP_HOST, IMAP_PORT, LIMITS } from "./config.js";

const SPECIAL_USE = ["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive", "\\Flagged", "\\All"];
const QQ_DEFAULT_FOLDERS = { sent: "Sent Messages", drafts: "Drafts", trash: "Deleted Messages", junk: "Junk" };
const ALIASES = { sent: "\\Sent", drafts: "\\Drafts", draft: "\\Drafts", trash: "\\Trash", deleted: "\\Trash", junk: "\\Junk", spam: "\\Junk" };

export function uidSet(uids) {
  return uids.join(",");
}

export class ImapSession {
  constructor(socket, { maxBytes = LIMITS.imapSessionBytes } = {}) {
    this.socket = socket;
    this.in = new ByteReader(socket.readable, { maxBytes, onClosed: "IMAP connection closed" });
    this.out = socket.writable.getWriter();
    this.seq = 0;
    this.caps = new Set();
    this.selected = null;
    this.folders = null;
  }

  async write(s) {
    await this.out.write(typeof s === "string" ? enc.encode(s) : s);
  }

  /** Reads one response; returns text/literal segments, the first text segment carries the tag. */
  async readResponse() {
    const segs = [];
    for (;;) {
      const line = utf8Decode(await this.in.line());
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) {
        segs.push(line);
        return segs;
      }
      segs.push(line.slice(0, m.index));
      const n = Number(m[1]);
      if (n > LIMITS.imapLiteralBytes) throw new MailError("Message part is too large to load at once; use the download link mode instead.");
      segs.push(await this.in.exact(n));
    }
  }

  /**
   * Sends a command made of string pieces and Uint8Array literals (synchronizing literals).
   * Returns { untagged: segment arrays, status: tagged completion line }.
   */
  async command(...parts) {
    const tag = "A" + String(++this.seq).padStart(4, "0");
    const untagged = [];
    let pending = tag + " ";
    const literalPlus = this.has("LITERAL+");
    for (const p of parts) {
      if (!(p instanceof Uint8Array)) {
        pending += p;
        continue;
      }
      // Prefer non-synchronizing literals when the server advertises LITERAL+
      // (QQ Mail often completes SEARCH without sending "+" for sync literals).
      if (literalPlus) {
        await this.write(pending + "{" + p.length + "+}\r\n");
        pending = "";
        await this.write(p);
        continue;
      }
      await this.write(pending + "{" + p.length + "}\r\n");
      pending = "";
      for (;;) {
        const r = await this.readResponse();
        if (r[0].startsWith("+")) break;
        if (r[0].startsWith(tag + " ")) throw imapFailure(r[0], tag);
        untagged.push(r);
      }
      await this.write(p);
    }
    await this.write(pending + "\r\n");
    for (;;) {
      const r = await this.readResponse();
      if (r[0].startsWith(tag + " ")) {
        if (!/^\S+ OK\b/i.test(r[0])) throw imapFailure(r[0], tag);
        return { untagged, status: r[0] };
      }
      if (!r[0].startsWith("+")) untagged.push(r);
    }
  }

  async greet() {
    const r = await this.readResponse();
    if (!/^\* (OK|PREAUTH)/i.test(r[0])) throw new MailError("Unexpected IMAP greeting");
    this.readCaps(r[0]);
  }

  readCaps(line) {
    const m = /\[CAPABILITY ([^\]]+)\]/i.exec(line) || /^\* CAPABILITY (.+)$/i.exec(line);
    if (m) this.caps = new Set(m[1].toUpperCase().split(/\s+/));
  }

  async login(user, password) {
    const quoteOrLiteral = (v) => (isImapAscii(v) ? [imapQuote(v)] : [enc.encode(v)]);
    let res;
    try {
      res = await this.command("LOGIN ", ...quoteOrLiteral(user), " ", ...quoteOrLiteral(password));
    } catch (e) {
      throw new MailError("QQ IMAP login failed. Check QQ_EMAIL and the QQ authorization code (QQ_APP_PASSWORD), and that IMAP is enabled in QQ Mail settings.", { cause: e });
    }
    this.readCaps(res.status);
    if (!this.caps.size || !this.caps.has("IMAP4REV1")) {
      const c = await this.command("CAPABILITY");
      for (const r of c.untagged) this.readCaps(r[0]);
    }
    if (this.has("ENABLE") && (this.has("UTF8=ACCEPT") || this.has("UTF8=ONLY"))) {
      try {
        await this.command("ENABLE UTF8=ACCEPT");
        this.caps.add("UTF8=ACCEPT");
      } catch {
        /* QQ may advertise ENABLE without honouring UTF8=ACCEPT */
      }
    }
  }

  has(cap) {
    return this.caps.has(cap.toUpperCase());
  }

  async listFolders() {
    if (this.folders) return this.folders;
    const res = await this.command('LIST "" "*"');
    const folders = [];
    for (const segs of res.untagged) {
      const v = parseResponse(segs);
      if (v[0] !== "*" || String(v[1]).toUpperCase() !== "LIST") continue;
      const flags = (Array.isArray(v[2]) ? v[2] : []).map(String);
      const raw = str(v[4]);
      const special = flags.find((f) => SPECIAL_USE.some((s) => s.toLowerCase() === f.toLowerCase())) || (raw.toUpperCase() === "INBOX" ? "\\Inbox" : "");
      folders.push({
        name: decodeMailboxName(raw),
        raw,
        delimiter: str(v[3]),
        special_use: special || undefined,
        selectable: !flags.some((f) => /^\\Noselect$/i.test(f) || /^\\NonExistent$/i.test(f)),
        flags,
      });
    }
    for (const [alias, fallback] of Object.entries(QQ_DEFAULT_FOLDERS)) {
      const attr = ALIASES[alias];
      if (!folders.some((f) => f.special_use === attr)) {
        const f = folders.find((x) => x.raw === fallback);
        if (f) f.special_use = attr;
      }
    }
    this.folders = folders;
    return folders;
  }

  /** Accepts INBOX, aliases (sent/drafts/trash/junk) or a display/raw folder name; returns the raw IMAP name. */
  async resolveFolder(input) {
    const name = String(input ?? "").trim();
    if (!name || name.toUpperCase() === "INBOX") return "INBOX";
    if (/[\r\n\x00]/.test(name) || name.length > 300) throw new MailError("Invalid folder name");
    const attr = ALIASES[name.toLowerCase()];
    if (attr) {
      const folders = await this.listFolders();
      const f = folders.find((x) => x.special_use === attr);
      if (!f) throw new MailError(`Could not find the ${name} folder on this account`);
      return f.raw;
    }
    if (this.folders) {
      const f = this.folders.find((x) => x.name === name || x.raw === name);
      if (f) return f.raw;
    }
    return /^[\x20-\x7e]*$/.test(name) && !name.includes("&") ? name : encodeMailboxName(name);
  }

  async folderStatus(raw) {
    const res = await this.command("STATUS ", imapQuote(raw), " (MESSAGES UNSEEN UIDNEXT UIDVALIDITY)");
    for (const segs of res.untagged) {
      const v = parseResponse(segs);
      if (String(v[1]).toUpperCase() !== "STATUS") continue;
      const list = v[3] || [];
      const out = {};
      for (let i = 0; i + 1 < list.length; i += 2) out[String(list[i]).toLowerCase()] = Number(list[i + 1]);
      return { messages: out.messages ?? 0, unread: out.unseen ?? 0, uidnext: out.uidnext, uidvalidity: out.uidvalidity };
    }
    return { messages: 0, unread: 0 };
  }

  /** SELECT (read-write) or EXAMINE (read-only). Re-selects only when the mode or folder changes. */
  async open(input, { write = false } = {}) {
    const raw = await this.resolveFolder(input);
    if (this.selected?.raw === raw && (this.selected.write || !write)) return this.selected;
    let res;
    try {
      res = await this.command(write ? "SELECT " : "EXAMINE ", imapQuote(raw));
    } catch (e) {
      throw new MailError(`Folder "${decodeMailboxName(raw)}" could not be opened. Use list_folders to see valid names.`, { cause: e });
    }
    let exists = 0;
    for (const segs of res.untagged) {
      const m = /^\* (\d+) EXISTS/i.exec(segs[0]);
      if (m) exists = Number(m[1]);
    }
    this.selected = { raw, name: decodeMailboxName(raw), write, exists };
    return this.selected;
  }

  async uidSearch(...criteria) {
    const res = await this.command("UID SEARCH ", ...criteria);
    const ids = [];
    for (const segs of res.untagged) {
      const m = /^\* SEARCH\b(.*)$/i.exec(segs[0]);
      if (m) for (const x of m[1].trim().split(/\s+/)) if (/^\d+$/.test(x)) ids.push(Number(x));
    }
    return ids.sort((a, b) => a - b);
  }

  /** Returns Map<uid, attributes> for a UID FETCH. */
  async uidFetch(uids, items) {
    const res = await this.command(`UID FETCH ${uidSet(uids)} (${items})`);
    const out = new Map();
    for (const segs of res.untagged) {
      if (!/^\* \d+ FETCH/i.test(segs[0])) continue;
      const v = parseResponse(segs);
      const attrs = fetchAttributes(Array.isArray(v[3]) ? v[3] : []);
      const uid = Number(attrs.UID);
      if (uid) out.set(uid, { ...(out.get(uid) || {}), ...attrs });
    }
    return out;
  }

  async uidStore(uids, op, flags) {
    await this.command(`UID STORE ${uidSet(uids)} ${op}FLAGS.SILENT (${flags.join(" ")})`);
  }

  /** Moves messages; falls back to COPY + \Deleted + targeted expunge when MOVE is unavailable. */
  async uidMove(uids, destRaw) {
    if (this.has("MOVE")) {
      await this.command(`UID MOVE ${uidSet(uids)} `, imapQuote(destRaw));
      return { method: "move", expunged: true, expunge_method: "move", pending_expunge: [] };
    }
    await this.command(`UID COPY ${uidSet(uids)} `, imapQuote(destRaw));
    await this.uidStore(uids, "+", ["\\Deleted"]);
    const cleanup = await this.uidExpunge(uids);
    return { method: "copy", ...cleanup };
  }

  /**
   * Removes the given UIDs that are flagged \Deleted.
   * Prefers UID EXPUNGE (UIDPLUS). Without UIDPLUS, runs a mailbox EXPUNGE only when every
   * currently \Deleted message is one of the UIDs we just marked — never wipes unrelated trash.
   * Returns { expunged, expunge_method: "uid_expunge"|"expunge"|"none", pending_expunge, blocked_by? }.
   */
  async uidExpunge(uids) {
    const list = [...new Set((uids || []).map(Number).filter((n) => n > 0))];
    if (!list.length) return { expunged: true, expunge_method: "none", pending_expunge: [] };
    if (this.has("UIDPLUS")) {
      await this.command(`UID EXPUNGE ${uidSet(list)}`);
      return { expunged: true, expunge_method: "uid_expunge", pending_expunge: [] };
    }
    const want = new Set(list);
    let deleted = null;
    try {
      deleted = await this.uidSearch("DELETED");
    } catch {
      deleted = null;
    }
    if (Array.isArray(deleted) && deleted.length) {
      const blockedBy = deleted.filter((u) => !want.has(u));
      if (blockedBy.length) {
        return {
          expunged: false,
          expunge_method: "none",
          pending_expunge: list.filter((u) => deleted.includes(u) || want.has(u)),
          blocked_by: blockedBy,
        };
      }
    }
    // QQ Mail often omits UIDPLUS and returns an empty DELETED search even after STORE.
    // When SEARCH reports nothing (or only our UIDs), run mailbox EXPUNGE so ghosts clear.
    await this.command("EXPUNGE");
    return {
      expunged: true,
      expunge_method: Array.isArray(deleted) && deleted.length ? "expunge" : "expunge_empty_deleted_search",
      pending_expunge: [],
      ...(Array.isArray(deleted) && !deleted.length
        ? { note: "Server returned no DELETED hits after STORE (common on QQ Mail); issued mailbox EXPUNGE anyway." }
        : {}),
    };
  }

  /** APPENDs a message; returns the new UID when the server reports APPENDUID (UIDPLUS). */
  async append(raw, bytes, flags = []) {
    const res = await this.command("APPEND ", imapQuote(raw), ` (${flags.join(" ")}) `, bytes);
    const m = /\[APPENDUID \d+ (\d+)\]/i.exec(res.status);
    if (this.selected?.raw === raw) this.selected = null;
    return m ? Number(m[1]) : null;
  }

  /**
   * Fetches one body section and exposes it as a decoded byte stream without buffering it.
   * The session must not be used for anything else afterwards; the stream closes the socket at the end.
   */
  async streamSection(uid, section, encoding) {
    const tag = "A" + String(++this.seq).padStart(4, "0");
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[${section}])\r\n`);
    let size = -1;
    for (;;) {
      const line = utf8Decode(await this.in.line());
      if (line.startsWith(tag + " ")) throw new MailError(/OK/i.test(line) ? "Attachment not found" : "IMAP fetch failed");
      const m = /^\* \d+ FETCH .*BODY\[[^\]]*\](?:<\d+>)? \{(\d+)\}$/i.exec(line);
      if (m) {
        size = Number(m[1]);
        break;
      }
    }
    this.in.maxBytes = Infinity;
    const decoder = makeTransferDecoder(encoding);
    let remaining = size;
    const finish = async () => {
      try {
        for (let i = 0; i < 20; i++) {
          const line = utf8Decode(await this.in.line());
          if (line.startsWith(tag + " ")) break;
        }
        await this.write("Z LOGOUT\r\n");
      } catch {}
      this.close();
    };
    const stream = new ReadableStream({
      pull: async (controller) => {
        if (remaining <= 0) {
          const tail = decoder.end();
          if (tail.length) controller.enqueue(tail);
          controller.close();
          await finish();
          return;
        }
        const chunk = await this.in.upTo(Math.min(remaining, 64 * 1024));
        remaining -= chunk.length;
        const out = decoder.push(chunk);
        if (out.length) controller.enqueue(out.slice());
      },
      cancel: () => this.close(),
    });
    return { encodedSize: size, stream };
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {}
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

function imapFailure(line, tag) {
  const text = line.slice(tag.length + 1).replace(/^(NO|BAD)\s*/i, "").replace(/\[[^\]]*\]\s*/, "").trim().slice(0, 200);
  return new MailError(`IMAP server rejected the command${text ? ": " + text : ""}`);
}

export function checkMailboxConfig(env) {
  if (!env.QQ_EMAIL || !env.QQ_APP_PASSWORD) throw new MailError("QQ Mail is not configured yet. Set QQ_EMAIL and the QQ_APP_PASSWORD secret.");
  if (!/^[^\s@]+@(qq\.com|foxmail\.com|vip\.qq\.com)$/i.test(env.QQ_EMAIL)) throw new MailError("QQ_EMAIL must be a qq.com, vip.qq.com or foxmail.com address");
}

/** Opens an authenticated IMAP session, runs `fn`, and always closes the socket. */
export async function withImap(env, connect, fn, { timeoutMs = LIMITS.imapTimeoutMs } = {}) {
  checkMailboxConfig(env);
  const socket = connect({ hostname: env.IMAP_HOST || IMAP_HOST, port: Number(env.IMAP_PORT) || IMAP_PORT }, { secureTransport: "on" });
  const session = new ImapSession(socket);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session.close();
  }, timeoutMs);
  try {
    await socket.opened;
    await session.greet();
    await session.login(env.QQ_EMAIL, env.QQ_APP_PASSWORD);
    const result = await fn(session);
    await session.logout();
    return result;
  } catch (e) {
    if (timedOut) throw new MailError("QQ IMAP did not respond in time. Try again or narrow the request.");
    if (e instanceof MailError) throw e;
    throw new MailError("Could not reach QQ IMAP (imap.qq.com:993). Check connectivity and try again.", { cause: e });
  } finally {
    clearTimeout(timer);
    session.close();
  }
}

/** Opens a session for streaming; the caller owns closing it (the stream closes it when done). */
export async function openImap(env, connect) {
  checkMailboxConfig(env);
  const socket = connect({ hostname: env.IMAP_HOST || IMAP_HOST, port: Number(env.IMAP_PORT) || IMAP_PORT }, { secureTransport: "on" });
  const session = new ImapSession(socket);
  try {
    await socket.opened;
    await session.greet();
    await session.login(env.QQ_EMAIL, env.QQ_APP_PASSWORD);
    return session;
  } catch (e) {
    session.close();
    if (e instanceof MailError) throw e;
    throw new MailError("Could not reach QQ IMAP (imap.qq.com:993).", { cause: e });
  }
}
