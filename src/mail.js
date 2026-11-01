import { base64Decode, base64Encode, binaryToBytes, bytesToBinary, decodeTransfer, enc, isValidBase64 } from "./bytes.js";
import { LIMITS, flag } from "./config.js";
import { MailError } from "./errors.js";
import { withImap, uidSet } from "./imap.js";
import { bodySection, estimateDecodedSize, flattenBodyStructure, imapQuote, isAttachment, isImapAscii, str } from "./imap-parse.js";
import {
  buildMessage,
  decodeText,
  decodeUnknown,
  formatAddressForDisplay,
  htmlToText,
  isValidAddress,
  newMessageId,
  parseAddressList,
  parseHeaders,
  prefixSubject,
  quoteText,
  removeHeader,
  sanitizeContentType,
  splitHeaderBody,
} from "./mime.js";
import { sendMail, checkSmtp } from "./smtp.js";
import { createDownloadLink } from "./download.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clean(s, max = 200) {
  return typeof s === "string" ? s.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : "";
}

function intIn(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

export function uidOf(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > 4294967295) throw new MailError("Invalid UID");
  return n;
}

export function uidsOf(args) {
  const list = Array.isArray(args.uids) ? args.uids : args.uid !== undefined ? [args.uid] : [];
  if (!list.length) throw new MailError("Provide uid or uids");
  if (list.length > LIMITS.bulkUids) throw new MailError(`At most ${LIMITS.bulkUids} messages per call`);
  return [...new Set(list.map(uidOf))];
}

export function imapDate(s, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new MailError(`${field} must be YYYY-MM-DD`);
  const d = new Date(s + "T00:00:00Z");
  if (!Number.isFinite(d.getTime())) throw new MailError(`Invalid ${field} date`);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** Builds UID SEARCH arguments; non-ASCII text goes out as UTF-8 literals with CHARSET UTF-8. */
export function searchCriteria(args) {
  const terms = [];
  let utf8 = false;
  const text = (key, v) => {
    const s = clean(v, 200);
    if (!s) return;
    if (isImapAscii(s)) terms.push(` ${key} ${imapQuote(s)}`);
    else {
      utf8 = true;
      terms.push(` ${key} `, enc.encode(s));
    }
  };
  text("TEXT", args.query);
  text("FROM", args.from);
  text("TO", args.to);
  text("SUBJECT", args.subject);
  if (args.since) terms.push(" SINCE " + imapDate(args.since, "since"));
  if (args.before) terms.push(" BEFORE " + imapDate(args.before, "before"));
  if (args.unread_only) terms.push(" UNSEEN");
  if (args.flagged_only) terms.push(" FLAGGED");
  return [utf8 ? "CHARSET UTF-8 ALL" : "ALL", ...terms];
}

function flagsOf(attrs) {
  const f = (Array.isArray(attrs.FLAGS) ? attrs.FLAGS : []).map((x) => String(x).toLowerCase());
  return { seen: f.includes("\\seen"), flagged: f.includes("\\flagged"), answered: f.includes("\\answered"), draft: f.includes("\\draft") };
}

function headerMap(attrs, section = "HEADER") {
  const raw = bodySection(attrs, section);
  return parseHeaders(raw instanceof Uint8Array ? decodeUnknown(raw) : str(raw));
}

function attachmentInfo(p) {
  return {
    part: p.section,
    filename: p.filename || (p.type === "message/rfc822" ? "message.eml" : "unnamed"),
    content_type: p.type,
    size_bytes: estimateDecodedSize(p),
    inline: p.disposition === "inline" || (!!p.content_id && p.disposition !== "attachment"),
    ...(p.content_id ? { content_id: p.content_id } : {}),
  };
}

const SUMMARY_ITEMS = "UID FLAGS RFC822.SIZE INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]";

function summary(uid, attrs) {
  const h = headerMap(attrs, "HEADER.FIELDS");
  const parts = attrs.BODYSTRUCTURE ? flattenBodyStructure(attrs.BODYSTRUCTURE) : [];
  return {
    uid,
    from: h.from || "",
    to: h.to || "",
    subject: h.subject || "",
    date: h.date || str(attrs.INTERNALDATE),
    size_bytes: Number(attrs["RFC822.SIZE"]) || 0,
    ...flagsOf(attrs),
    has_attachments: parts.some((p) => isAttachment(p) && p.disposition !== "inline"),
  };
}

/** Loads headers + structure for one message in the currently opened folder. */
async function loadMessage(s, uid) {
  const attrs = (await s.uidFetch([uid], "UID FLAGS RFC822.SIZE INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER]")).get(uid);
  if (!attrs) throw new MailError(`Message UID ${uid} not found in folder "${s.selected?.name}"`);
  return { attrs, headers: headerMap(attrs), parts: flattenBodyStructure(attrs.BODYSTRUCTURE || []) };
}

/** Fetches text/plain and/or text/html bodies (first N bytes each) and decodes them. */
async function loadBodies(s, uid, parts, { wantHtml = true, maxBytes = LIMITS.bodyFetchBytes } = {}) {
  const textPart = parts.find((p) => p.type === "text/plain" && !isAttachment(p));
  const htmlPart = parts.find((p) => p.type === "text/html" && !isAttachment(p));
  const chosen = [textPart, wantHtml || !textPart ? htmlPart : null].filter(Boolean);
  if (!chosen.length) return { text: "", html: "", truncated: false };
  const items = chosen.map((p) => `BODY.PEEK[${p.fetch_section}]<0.${maxBytes}>`).join(" ");
  const attrs = (await s.uidFetch([uid], "UID " + items)).get(uid) || {};
  const decode = (p) => {
    if (!p) return "";
    const raw = bodySection(attrs, p.fetch_section);
    const bytes = raw instanceof Uint8Array ? raw : enc.encode(str(raw));
    return decodeText(decodeTransfer(bytes, p.encoding), p.charset || "utf-8");
  };
  return { text: decode(textPart), html: decode(htmlPart), truncated: chosen.some((p) => p.size > maxBytes) };
}

function selfAddress(env) {
  return String(env.QQ_EMAIL || "").toLowerCase();
}

function fromHeader(env) {
  return { name: clean(env.QQ_DISPLAY_NAME || "", 100), address: env.QQ_EMAIL };
}

export function recipientsOf(args, { allowEmpty = false } = {}) {
  const lists = {};
  for (const k of ["to", "cc", "bcc"]) {
    lists[k] = parseAddressList(args[k] ?? []).map((a) => ({ name: clean(a.name, 100), address: a.address }));
    const bad = lists[k].find((a) => !isValidAddress(a.address));
    if (bad) throw new MailError(`Invalid ${k} address: ${clean(bad.address, 100)}`);
  }
  const total = lists.to.length + lists.cc.length + lists.bcc.length;
  if (!total && !allowEmpty) throw new MailError("At least one recipient (to, cc or bcc) is required");
  if (total > LIMITS.recipients) throw new MailError(`At most ${LIMITS.recipients} recipients per message`);
  return lists;
}

function envelopeOf({ to, cc, bcc }) {
  return [...new Set([...to, ...cc, ...bcc].map((a) => a.address.toLowerCase()))];
}

export function attachmentsOf(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new MailError("attachments must be an array");
  if (list.length > LIMITS.outgoingAttachments) throw new MailError(`At most ${LIMITS.outgoingAttachments} attachments`);
  let total = 0;
  return list.map((a, i) => {
    if (!a || typeof a !== "object") throw new MailError(`Attachment ${i + 1} is invalid`);
    const filename = clean(a.filename, 200);
    if (!filename) throw new MailError(`Attachment ${i + 1} needs a filename`);
    if (!isValidBase64(a.content_base64 || "")) throw new MailError(`Attachment "${filename}" must be base64 encoded`);
    const data = base64Decode(String(a.content_base64).replace(/^data:[^,]*,/, ""));
    total += data.length;
    if (total > LIMITS.outgoingAttachmentBytes) throw new MailError(`Attachments exceed ${LIMITS.outgoingAttachmentBytes / 1048576} MB in total`);
    return { filename, contentType: sanitizeContentType(a.content_type || guessType(filename)), data };
  });
}

const EXT_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", md: "text/markdown", html: "text/html", json: "application/json", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", eml: "message/rfc822" };

function guessType(filename) {
  return EXT_TYPES[String(filename).split(".").pop().toLowerCase()] || "application/octet-stream";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function textToHtml(s) {
  return escapeHtml(s).replace(/\r?\n/g, "<br>\r\n");
}

function saveSentDefault(env, v) {
  return typeof v === "boolean" ? v : flag(env, "SAVE_SENT_COPY", false);
}

async function appendSent(s, message) {
  const sent = await s.resolveFolder("sent");
  await s.append(sent, typeof message === "string" ? enc.encode(message) : message, ["\\Seen"]);
  return s.selected?.name;
}

/** Sends, then optionally files a copy into Sent (opening a separate IMAP session when none is given). */
async function deliver(ctx, session, { message, envelope, saveToSent }) {
  const result = await sendMail(ctx.env, ctx.connect, { recipients: envelope, message });
  let saved = false;
  let saveError;
  if (saveToSent) {
    try {
      if (session) await appendSent(session, message);
      else await withImap(ctx.env, ctx.connect, (s) => appendSent(s, message));
      saved = true;
    } catch (e) {
      saveError = e instanceof MailError ? e.message : "Could not save a copy to Sent";
    }
  }
  return { sent: true, ...result, saved_to_sent: saved, ...(saveError ? { save_error: saveError } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Read tools

export async function checkConnection(ctx, args) {
  const imap = await withImap(ctx.env, ctx.connect, async (s) => {
    const folders = await s.listFolders();
    const inbox = await s.folderStatus("INBOX");
    const caps = ["MOVE", "UIDPLUS", "IDLE", "SPECIAL-USE", "CONDSTORE"].filter((c) => s.has(c));
    return { connected: true, account: ctx.env.QQ_EMAIL, folders: folders.length, inbox, capabilities: caps };
  });
  const out = { imap };
  if (args.check_smtp) out.smtp = await checkSmtp(ctx.env, ctx.connect);
  return out;
}

export async function listFolders(ctx, args) {
  const withCounts = args.include_counts !== false;
  return withImap(ctx.env, ctx.connect, async (s) => {
    const folders = await s.listFolders();
    const out = [];
    for (const f of folders.slice(0, 100)) {
      const row = { name: f.name, ...(f.special_use ? { special_use: f.special_use.replace("\\", "").toLowerCase() } : {}), selectable: f.selectable };
      if (withCounts && f.selectable && out.length < 60) {
        try {
          Object.assign(row, await s.folderStatus(f.raw));
          delete row.uidnext;
          delete row.uidvalidity;
        } catch {
          row.status_error = true;
        }
      }
      out.push(row);
    }
    return { count: out.length, delimiter: folders[0]?.delimiter || "/", folders: out };
  });
}

export async function searchEmails(ctx, args) {
  const limit = intIn(args.limit, 1, LIMITS.searchMax, 10);
  const offset = intIn(args.offset, 0, 1_000_000, 0);
  const criteria = searchCriteria(args);
  const needle = clean(args.query || args.subject || args.from || args.to || "", 200);
  return withImap(ctx.env, ctx.connect, async (s) => {
    const box = await s.open(args.folder);
    let ids;
    try {
      ids = await s.uidSearch(...criteria);
    } catch (e) {
      // QQ Mail often rejects CHARSET UTF-8 / sync literals. Fall back to a recent-window client filter.
      if (!needle) throw e;
      const recent = await s.uidSearch("ALL");
      const window = recent.slice(-Math.min(recent.length, Math.max(limit * 20, 80)));
      if (!window.length) return { folder: box.name, total: 0, count: 0, offset, results: [], note: "Chinese search fell back to client filter; no messages." };
      const rows = await s.uidFetch(window, SUMMARY_ITEMS);
      const matched = window.filter((u) => {
        if (!rows.has(u)) return false;
        const row = summary(u, rows.get(u));
        const hay = `${row.subject}\n${row.from}\n${row.to}`.toLowerCase();
        return hay.includes(needle.toLowerCase());
      });
      const end = Math.max(0, matched.length - offset);
      const page = matched.slice(Math.max(0, end - limit), end).reverse();
      const results = page.filter((u) => rows.has(u)).map((u) => summary(u, rows.get(u)));
      return {
        folder: box.name,
        total: matched.length,
        count: results.length,
        offset,
        has_more: end - limit > 0,
        results,
        note: "Chinese IMAP SEARCH unavailable on this server; filtered recent subjects/from/to locally.",
      };
    }
    const end = Math.max(0, ids.length - offset);
    const page = ids.slice(Math.max(0, end - limit), end).reverse();
    if (!page.length) return { folder: box.name, total: ids.length, count: 0, offset, results: [] };
    const rows = await s.uidFetch(page, SUMMARY_ITEMS);
    const results = page.filter((u) => rows.has(u)).map((u) => summary(u, rows.get(u)));
    return { folder: box.name, total: ids.length, count: results.length, offset, has_more: end - limit > 0, results };
  });
}

export async function readEmail(ctx, args) {
  const uid = uidOf(args.uid);
  const max = intIn(args.max_chars, 300, LIMITS.readMaxChars, 20000);
  const format = args.format === "html" ? "html" : "text";
  return withImap(ctx.env, ctx.connect, async (s) => {
    const box = await s.open(args.folder);
    const { attrs, headers: h, parts } = await loadMessage(s, uid);
    const bodies = await loadBodies(s, uid, parts, { wantHtml: format === "html" });
    let body = format === "html" ? bodies.html || textToHtml(bodies.text) : bodies.text.trim() || htmlToText(bodies.html);
    body = body.replace(/\r\n/g, "\n");
    return {
      folder: box.name,
      uid,
      subject: h.subject || "",
      from: h.from || "",
      to: h.to || "",
      cc: h.cc || "",
      reply_to: h["reply-to"] || "",
      date: h.date || str(attrs.INTERNALDATE),
      message_id: h["message-id"] || "",
      ...flagsOf(attrs),
      size_bytes: Number(attrs["RFC822.SIZE"]) || 0,
      body_format: format,
      body: body.slice(0, max),
      truncated: body.length > max || bodies.truncated,
      attachments: parts.filter(isAttachment).map(attachmentInfo),
    };
  });
}

export async function listAttachments(ctx, args) {
  const uid = uidOf(args.uid);
  return withImap(ctx.env, ctx.connect, async (s) => {
    const box = await s.open(args.folder);
    const { headers: h, parts } = await loadMessage(s, uid);
    const list = parts.filter(isAttachment).map(attachmentInfo);
    return { folder: box.name, uid, subject: h.subject || "", count: list.length, attachments: list, note: "Use download_attachment with the part number to fetch a file." };
  });
}

function pickPart(parts, args) {
  const atts = parts.filter(isAttachment);
  if (args.part !== undefined && args.part !== null && args.part !== "") {
    const id = String(args.part).trim();
    if (!/^\d+(\.\d+)*$/.test(id)) throw new MailError("part must look like 2 or 1.2");
    const p = parts.find((x) => x.section === id);
    if (!p) throw new MailError(`Part ${id} not found; use list_attachments`);
    return p;
  }
  if (args.filename) {
    const want = String(args.filename).toLowerCase();
    const p = atts.find((x) => (x.filename || "").toLowerCase() === want);
    if (!p) throw new MailError(`No attachment named "${clean(args.filename, 100)}"; use list_attachments`);
    return p;
  }
  if (atts.length === 1) return atts[0];
  throw new MailError(atts.length ? "This message has several attachments; pass part or filename" : "This message has no attachments");
}

export async function downloadAttachment(ctx, args) {
  const uid = uidOf(args.uid);
  const mode = args.mode === "base64" ? "base64" : "url";
  const inlineMax = intIn(ctx.env.MAX_INLINE_ATTACHMENT_BYTES, 64 * 1024, 8 * 1024 * 1024, LIMITS.inlineAttachmentBytes);
  return withImap(ctx.env, ctx.connect, async (s) => {
    const box = await s.open(args.folder);
    const { parts } = await loadMessage(s, uid);
    const p = pickPart(parts, args);
    const info = attachmentInfo(p);
    if (mode === "url") {
      const link = await createDownloadLink(ctx, { folder: box.name, uid, section: p.fetch_section, encoding: p.encoding, filename: info.filename, content_type: p.type });
      return { folder: box.name, uid, ...info, download_url: link.url, expires_at: link.expires_at, note: "Single-file link, valid for a short time. Open it in a browser or fetch it with any HTTP client; no extra auth needed." };
    }
    if (info.size_bytes > inlineMax) throw new MailError(`Attachment is about ${info.size_bytes} bytes; inline base64 is limited to ${inlineMax}. Use mode "url".`);
    const attrs = (await s.uidFetch([uid], `UID BODY.PEEK[${p.fetch_section}]`)).get(uid) || {};
    const raw = bodySection(attrs, p.fetch_section);
    const data = decodeTransfer(raw instanceof Uint8Array ? raw : enc.encode(str(raw)), p.encoding);
    const b64 = base64Encode(data);
    const meta = { folder: box.name, uid, ...info, size_bytes: data.length, encoding: "base64" };
    const content = [{ type: "text", text: JSON.stringify(meta) }];
    if (/^image\/(png|jpeg|gif|webp)$/.test(p.type)) content.push({ type: "image", data: b64, mimeType: p.type });
    else content.push({ type: "resource", resource: { uri: `qqmail://${encodeURIComponent(box.name)}/${uid}/${p.section}/${encodeURIComponent(info.filename)}`, mimeType: p.type, blob: b64 } });
    return { _content: content };
  });
}

// ---------------------------------------------------------------------------------------------
// Modify tools

export async function setEmailFlags(ctx, args) {
  const uids = uidsOf(args);
  const ops = [];
  if (typeof args.seen === "boolean") ops.push([args.seen ? "+" : "-", "\\Seen"]);
  if (typeof args.flagged === "boolean") ops.push([args.flagged ? "+" : "-", "\\Flagged"]);
  if (typeof args.answered === "boolean") ops.push([args.answered ? "+" : "-", "\\Answered"]);
  if (!ops.length) throw new MailError("Set at least one of seen, flagged or answered");
  return withImap(ctx.env, ctx.connect, async (s) => {
    const box = await s.open(args.folder, { write: true });
    for (const [op, f] of ops) await s.uidStore(uids, op, [f]);
    const rows = await s.uidFetch(uids, "UID FLAGS");
    return { folder: box.name, updated: [...rows.keys()].length, messages: uids.filter((u) => rows.has(u)).map((u) => ({ uid: u, ...flagsOf(rows.get(u)) })), missing: uids.filter((u) => !rows.has(u)) };
  });
}


function cleanupFields(r) {
  const expunged = !!r.expunged;
  const out = {
    source_expunged: expunged,
    expunge_method: r.expunge_method || (expunged ? "unknown" : "none"),
    pending_expunge: r.pending_expunge || [],
  };
  if (r.blocked_by?.length) out.expunge_blocked_by = r.blocked_by;
  if (!expunged) {
    out.note =
      "Source message(s) were flagged \\Deleted but not expunged. " +
      (r.blocked_by?.length
        ? "Mailbox already had other \\Deleted messages; a full EXPUNGE would remove those too, so cleanup was skipped (QQ Mail often lacks UIDPLUS)."
        : "Server did not support a targeted expunge (no UIDPLUS) and no safe mailbox EXPUNGE was possible.");
  }
  return out;
}

export async function moveEmails(ctx, args) {
  const uids = uidsOf(args);
  if (!clean(args.destination, 300)) throw new MailError("destination is required");
  return withImap(ctx.env, ctx.connect, async (s) => {
    const box = await s.open(args.folder, { write: true });
    const dest = await s.resolveFolder(args.destination);
    if (dest === box.raw) throw new MailError("Source and destination folders are the same");
    const existing = await s.uidSearch(`UID ${uidSet(uids)}`);
    if (!existing.length) throw new MailError("None of the given UIDs exist in this folder");
    const r = await s.uidMove(existing, dest);
    return {
      folder: box.name,
      destination: (await s.listFolders()).find((f) => f.raw === dest)?.name || args.destination,
      moved: existing.length,
      missing: uids.filter((u) => !existing.includes(u)),
      move_method: r.method,
      ...cleanupFields(r),
    };
  });
}

export async function deleteEmails(ctx, args) {
  const uids = uidsOf(args);
  return withImap(ctx.env, ctx.connect, async (s) => {
    const box = await s.open(args.folder, { write: true });
    const trash = await s.resolveFolder("trash").catch(() => null);
    const existing = await s.uidSearch(`UID ${uidSet(uids)}`);
    if (!existing.length) throw new MailError("None of the given UIDs exist in this folder");
    const missing = uids.filter((u) => !existing.includes(u));
    if (!args.permanent && trash && trash !== box.raw) {
      const r = await s.uidMove(existing, trash);
      return {
        folder: box.name,
        moved_to_trash: existing.length,
        missing,
        move_method: r.method,
        ...cleanupFields(r),
      };
    }
    await s.uidStore(existing, "+", ["\\Deleted"]);
    const cleanup = await s.uidExpunge(existing);
    return {
      folder: box.name,
      permanently_deleted: cleanup.expunged ? existing.length : 0,
      flagged_deleted: cleanup.expunged ? 0 : existing.length,
      missing,
      ...cleanupFields(cleanup),
    };
  });
}

export async function saveDraft(ctx, args) {
  const rcpt = recipientsOf(args, { allowEmpty: true });
  const attachments = attachmentsOf(args.attachments);
  const messageId = newMessageId(ctx.env.QQ_EMAIL);
  const message = buildMessage({ from: fromHeader(ctx.env), ...rcpt, includeBcc: true, subject: clean(args.subject, 900), text: args.body ?? "", html: args.html, attachments, messageId });
  return withImap(ctx.env, ctx.connect, async (s) => {
    const drafts = await s.resolveFolder("drafts");
    let uid = await s.append(drafts, enc.encode(message), ["\\Draft", "\\Seen"]);
    const box = await s.open("drafts", { write: true });
    if (!uid) uid = (await s.uidSearch(`HEADER Message-ID ${imapQuote(messageId)}`)).pop() ?? null;
    let replaced = false;
    let replace_cleanup = null;
    if (args.replace_draft_uid !== undefined) {
      const old = uidOf(args.replace_draft_uid);
      if (old !== uid) {
        await s.uidStore([old], "+", ["\\Deleted"]);
        replace_cleanup = await s.uidExpunge([old]);
        replaced = !!replace_cleanup.expunged;
      }
    }
    return {
      saved: true,
      folder: box.name,
      uid,
      message_id: messageId,
      replaced_previous: replaced,
      ...(replace_cleanup ? cleanupFields(replace_cleanup) : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Send tools

export async function sendEmail(ctx, args) {
  const rcpt = recipientsOf(args);
  const subject = clean(args.subject, 900);
  if (!subject && !args.body && !args.html) throw new MailError("Provide a subject or body");
  const attachments = attachmentsOf(args.attachments);
  const message = buildMessage({ from: fromHeader(ctx.env), to: rcpt.to, cc: rcpt.cc, subject, text: args.body ?? undefined, html: args.html, attachments });
  const r = await deliver(ctx, null, { message, envelope: envelopeOf(rcpt), saveToSent: saveSentDefault(ctx.env, args.save_to_sent) });
  return { ...r, subject, to: rcpt.to.map(formatAddressForDisplay), cc: rcpt.cc.map(formatAddressForDisplay), bcc_count: rcpt.bcc.length, attachments: attachments.length };
}

function replyRecipients(env, h, replyAll) {
  const me = selfAddress(env);
  const from = parseAddressList(h["reply-to"] || h.from || "");
  const origTo = parseAddressList(h.to || "");
  const origCc = parseAddressList(h.cc || "");
  const sentByMe = parseAddressList(h.from || "").some((a) => a.address.toLowerCase() === me);
  const seen = new Set([me]);
  const take = (list) => list.filter((a) => isValidAddress(a.address) && !seen.has(a.address.toLowerCase()) && seen.add(a.address.toLowerCase()));
  // Self-sent mail: reply to original To (excluding self). Only-self leaves `to` empty for override/default.
  const to = take(sentByMe ? origTo : from);
  const cc = replyAll ? take(sentByMe ? origCc : [...origTo, ...origCc]) : [];
  return { to, cc, sentByMe };
}

export async function replyEmail(ctx, args) {
  const uid = uidOf(args.uid);
  const attachments = attachmentsOf(args.attachments);
  if (!args.body && !args.html) throw new MailError("body is required");
  return withImap(
    ctx.env,
    ctx.connect,
    async (s) => {
      const box = await s.open(args.folder, { write: true });
      const { headers: h, parts } = await loadMessage(s, uid);
      const base = replyRecipients(ctx.env, h, !!args.reply_all);
      const extra = recipientsOf(args, { allowEmpty: true });
      // Explicit `to` always wins; else inferred; for only-self mail default to own address.
      let to = extra.to.length ? extra.to : base.to;
      if (!to.length && base.sentByMe && ctx.env.QQ_EMAIL) {
        to = [{ name: clean(ctx.env.QQ_DISPLAY_NAME || "", 100), address: ctx.env.QQ_EMAIL }];
      }
      const cc = [...base.cc, ...extra.cc.filter((a) => !base.cc.some((b) => b.address.toLowerCase() === a.address.toLowerCase()))];
      const bcc = extra.bcc;
      if (!to.length) throw new MailError("Could not determine who to reply to; pass to explicitly");
      const msgId = h["message-id"] || "";
      const refs = [h.references || "", msgId].join(" ").trim();
      let text = args.body ?? (args.html ? htmlToText(args.html) : "");
      let html = args.html;
      if (args.quote_original !== false) {
        const orig = await loadBodies(s, uid, parts, { wantHtml: !!html, maxBytes: 256 * 1024 });
        const origText = (orig.text || htmlToText(orig.html)).slice(0, 30000);
        const intro = `On ${h.date || "an earlier date"}, ${h.from || "the sender"} wrote:`;
        text = `${text}\n\n${intro}\n${quoteText(origText)}`;
        if (html) html = `${html}<br><br><div>${escapeHtml(intro)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${orig.html || textToHtml(origText)}</blockquote>`;
      }
      const subject = prefixSubject(h.subject || "", "re");
      const message = buildMessage({ from: fromHeader(ctx.env), to, cc, subject, text, html, attachments, inReplyTo: msgId || undefined, references: refs || undefined });
      const r = await deliver(ctx, s, { message, envelope: envelopeOf({ to, cc, bcc }), saveToSent: saveSentDefault(ctx.env, args.save_to_sent) });
      try {
        await s.open(box.name, { write: true });
        await s.uidStore([uid], "+", ["\\Answered"]);
      } catch {}
      return { ...r, in_reply_to_uid: uid, subject, to: to.map(formatAddressForDisplay), cc: cc.map(formatAddressForDisplay), bcc_count: bcc.length };
    },
    { timeoutMs: LIMITS.sendTimeoutMs }
  );
}

/** Re-wraps an original attachment as a base64 MIME part; base64 bodies pass through without decoding. */
function forwardPart(p, raw) {
  const filename = p.filename || (p.type === "message/rfc822" ? "message.eml" : "attachment");
  const body = p.encoding === "base64" ? bytesToBinary(raw).replace(/\r?\n/g, "\r\n").trim() + "\r\n" : base64Encode(decodeTransfer(raw, p.encoding), 76);
  const ascii = /^[\x20-\x7e]*$/.test(filename) ? filename.replace(/["\\]/g, "_") : null;
  const name = ascii ? `"${ascii}"` : `"=?UTF-8?B?${base64Encode(enc.encode(filename))}?="`;
  const star = ascii ? "" : `;\r\n filename*=UTF-8''${encodeURIComponent(filename)}`;
  const inline = p.disposition === "inline" || (!!p.content_id && p.disposition !== "attachment");
  return (
    `Content-Type: ${sanitizeContentType(p.type)}; name=${name}\r\n` +
    `Content-Disposition: ${inline ? "inline" : "attachment"}; filename=${name}${star}\r\n` +
    (p.content_id ? `Content-ID: <${p.content_id.replace(/[<>\r\n]/g, "")}>\r\n` : "") +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    body
  );
}

export async function forwardEmail(ctx, args) {
  const uid = uidOf(args.uid);
  const rcpt = recipientsOf(args);
  const extraAttachments = attachmentsOf(args.attachments);
  return withImap(
    ctx.env,
    ctx.connect,
    async (s) => {
      const box = await s.open(args.folder);
      const { headers: h, parts } = await loadMessage(s, uid);
      const orig = await loadBodies(s, uid, parts, { wantHtml: true, maxBytes: 512 * 1024 });
      const block = ["---------- Forwarded message ----------", `From: ${h.from || ""}`, `Date: ${h.date || ""}`, `Subject: ${h.subject || ""}`, `To: ${h.to || ""}`, ...(h.cc ? [`Cc: ${h.cc}`] : [])];
      const note = String(args.body ?? "");
      const origText = orig.text || htmlToText(orig.html);
      const text = `${note}\n\n${block.join("\n")}\n\n${origText}`;
      const html = orig.html ? `<div>${textToHtml(note)}</div><br><div>${block.map(escapeHtml).join("<br>")}</div><br>${orig.html}` : undefined;
      const rawParts = [];
      if (args.include_attachments !== false) {
        const atts = parts.filter(isAttachment);
        const total = atts.reduce((n, p) => n + p.size, 0);
        if (total > LIMITS.outgoingAttachmentBytes * 1.4) throw new MailError("Original attachments are too large to forward from the Worker; set include_attachments to false");
        if (atts.length) {
          const fetched = (await s.uidFetch([uid], "UID " + atts.map((p) => `BODY.PEEK[${p.fetch_section}]`).join(" "))).get(uid) || {};
          for (const p of atts) {
            const raw = bodySection(fetched, p.fetch_section);
            if (raw != null) rawParts.push(forwardPart(p, raw instanceof Uint8Array ? raw : enc.encode(str(raw))));
          }
        }
      }
      const subject = prefixSubject(h.subject || "", "fwd");
      const message = buildMessage({ from: fromHeader(ctx.env), to: rcpt.to, cc: rcpt.cc, subject, text, html, attachments: extraAttachments, rawParts });
      const r = await deliver(ctx, s, { message, envelope: envelopeOf(rcpt), saveToSent: saveSentDefault(ctx.env, args.save_to_sent) });
      return { ...r, forwarded_uid: uid, folder: box.name, subject, to: rcpt.to.map(formatAddressForDisplay), cc: rcpt.cc.map(formatAddressForDisplay), bcc_count: rcpt.bcc.length, attachments_forwarded: rawParts.length };
    },
    { timeoutMs: LIMITS.sendTimeoutMs }
  );
}

export async function sendDraft(ctx, args) {
  const uid = uidOf(args.uid);
  return withImap(
    ctx.env,
    ctx.connect,
    async (s) => {
      const box = await s.open("drafts", { write: true });
      const meta = (await s.uidFetch([uid], "UID RFC822.SIZE")).get(uid);
      if (!meta) throw new MailError(`Draft UID ${uid} not found in ${box.name}`);
      if (Number(meta["RFC822.SIZE"]) > LIMITS.rawDraftBytes) throw new MailError("Draft is too large to send from the Worker");
      const raw = bodySection((await s.uidFetch([uid], "UID BODY.PEEK[]")).get(uid) || {}, "");
      if (!(raw instanceof Uint8Array)) throw new MailError("Could not load the draft");
      const binary = bytesToBinary(raw);
      const h = parseHeaders(decodeUnknown(binaryToBytes(splitHeaderBody(binary)[0])));
      const rcpt = recipientsOf({ to: h.to || [], cc: h.cc || [], bcc: h.bcc || [] });
      const outgoing = binaryToBytes(removeHeader(binary, "Bcc"));
      const r = await deliver(ctx, s, { message: outgoing, envelope: envelopeOf(rcpt), saveToSent: saveSentDefault(ctx.env, args.save_to_sent) });
      let cleanup = { expunged: true, expunge_method: "none", pending_expunge: [] };
      if (!args.keep_draft) {
        await s.open("drafts", { write: true });
        await s.uidStore([uid], "+", ["\\Deleted"]);
        cleanup = await s.uidExpunge([uid]);
      }
      return {
        ...r,
        draft_uid: uid,
        subject: h.subject || "",
        to: rcpt.to.map(formatAddressForDisplay),
        cc: rcpt.cc.map(formatAddressForDisplay),
        bcc_count: rcpt.bcc.length,
        draft_removed: !!cleanup.expunged,
        ...cleanupFields(cleanup),
      };
    },
    { timeoutMs: LIMITS.sendTimeoutMs }
  );
}
