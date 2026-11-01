import { beforeEach, describe, expect, it } from "vitest";
import { callTool } from "../src/mcp.js";
import { route } from "../src/index.js";
import { base64Encode, enc } from "../src/bytes.js";
import { parseHeaders } from "../src/mime.js";
import { FakeImapServer, FakeSmtpServer, fakeConnect, makeMessage } from "./helpers/fake-mail.js";
import { fakeD1 } from "./helpers/fake-d1.js";

const ALL = { scopes: ["mail:read", "mail:modify", "mail:send"] };
const PDF = "%PDF-1.4 fake pdf bytes " + "x".repeat(300);

function fixtures() {
  return {
    INBOX: {
      flags: ["\\HasNoChildren"],
      messages: [
        {
          uid: 101,
          ...makeMessage({
            headers: { From: "=?UTF-8?B?5byg5LiJ?= <zhangsan@example.com>", To: "me@qq.com", Cc: "li@example.com", Subject: "=?UTF-8?B?5Lya6K6u6YCa55+l?=", Date: "Sat, 31 Oct 2026 09:00:00 +0800", "Message-ID": "<m101@example.com>" },
            parts: [
              { type: "text/plain", params: { CHARSET: "UTF-8" }, encoding: "base64", content: "明天上午十点开会。\n.dot line" },
              { type: "text/html", params: { CHARSET: "UTF-8" }, encoding: "quoted-printable", content: "<p>=E6=98=8E=E5=A4=A9</p>" },
              { type: "application/pdf", params: { NAME: "=?UTF-8?B?5oql5ZGKLnBkZg==?=" }, encoding: "base64", content: PDF, disposition: "attachment", filename: "=?UTF-8?B?5oql5ZGKLnBkZg==?=" },
            ],
          }),
          searchText: "开会",
        },
        {
          uid: 102,
          ...makeMessage({
            headers: { From: "news@example.com", To: "me@qq.com", Subject: "Weekly", Date: "Sun, 01 Nov 2026 08:00:00 +0800", "Message-ID": "<m102@example.com>" },
            parts: [{ type: "text/html", params: { CHARSET: "UTF-8" }, encoding: "7bit", content: "<h1>News</h1><p>Hello &amp; welcome</p>" }],
            flags: ["\\Seen"],
          }),
        },
      ],
    },
    "Sent Messages": { flags: ["\\HasNoChildren"] },
    Drafts: { flags: ["\\HasNoChildren"] },
    "Deleted Messages": { flags: ["\\HasNoChildren"] },
    Junk: { flags: ["\\HasNoChildren"] },
    "&UXZO1mWHTvZZOQ-": { flags: ["\\HasNoChildren"] },
  };
}

let imap, smtp, ctx;
beforeEach(() => {
  imap = new FakeImapServer({ user: "me@qq.com", password: "app-pass", folders: fixtures() });
  smtp = new FakeSmtpServer({ user: "me@qq.com", password: "app-pass" });
  ctx = { env: { QQ_EMAIL: "me@qq.com", QQ_APP_PASSWORD: "app-pass", QQ_DISPLAY_NAME: "我", OAUTH_DB: fakeD1() }, connect: fakeConnect({ imap, smtp }), origin: "https://qqmail.example.com" };
});

async function call(name, args, auth = ALL) {
  const { result, error } = await callTool(ctx, auth, name, args);
  if (error) throw new Error(error.message);
  if (result.isError) return { error: JSON.parse(result.content[0].text).error };
  return result.content.length === 1 ? JSON.parse(result.content[0].text) : result.content;
}

describe("read tools", () => {
  it("checks the connection over implicit TLS", async () => {
    const r = await call("check_mail_connection", { check_smtp: true });
    expect(r.imap).toMatchObject({ connected: true, folders: 6, inbox: { messages: 2, unread: 1 } });
    expect(r.imap.capabilities).toEqual(["MOVE", "UIDPLUS"]);
    expect(r.smtp).toEqual({ connected: true });
    expect(ctx.connect.calls.every((c) => c.secureTransport === "on")).toBe(true);
  });

  it("reports bad credentials clearly", async () => {
    ctx.env.QQ_APP_PASSWORD = "wrong";
    expect((await call("search_emails", {})).error).toMatch(/login failed/i);
  });

  it("lists folders with special-use aliases, counts and decoded names", async () => {
    const r = await call("list_folders", {});
    const byName = Object.fromEntries(r.folders.map((f) => [f.name, f]));
    expect(byName.INBOX).toMatchObject({ messages: 2, unread: 1 });
    expect(byName["Sent Messages"].special_use).toBe("sent");
    expect(byName["Deleted Messages"].special_use).toBe("trash");
    expect(byName["其他文件夹"]).toBeDefined();
  });

  it("searches newest first with flags and attachment hints", async () => {
    const r = await call("search_emails", { limit: 10 });
    expect(r.results.map((x) => x.uid)).toEqual([102, 101]);
    expect(r.results[1]).toMatchObject({ subject: "会议通知", from: "张三 <zhangsan@example.com>", seen: false, has_attachments: true });
    expect(r.results[0]).toMatchObject({ seen: true, has_attachments: false });
  });

  it("matches decoded Chinese body without a server TEXT index", async () => {
    const r = await call("search_emails", { query: "开会", unread_only: true });
    expect(r.results.map(x => x.uid)).toEqual([101]);
    expect(r.partial).toBe(false);
    expect(imap.commands.some(c => /UID SEARCH.*CHARSET/.test(c))).toBe(false);
  });

  it("paginates with offset", async () => {
    const r = await call("search_emails", { limit: 1, offset: 1 });
    expect(r).toMatchObject({ total: 2, count: 1, has_more: false });
    expect(r.results[0].uid).toBe(101);
  });

  it("reads a message without marking it read", async () => {
    const r = await call("read_email", { uid: 101 });
    expect(r).toMatchObject({ subject: "会议通知", cc: "li@example.com", message_id: "<m101@example.com>", seen: false, body_format: "text" });
    expect(r.body).toBe("明天上午十点开会。\n.dot line");
    expect(r.attachments).toEqual([{ part: "3", filename: "报告.pdf", content_type: "application/pdf", size_bytes: expect.any(Number), inline: false }]);
    expect(imap.commands.some((c) => /EXAMINE "INBOX"/.test(c))).toBe(true);
    expect(imap.find("INBOX", 101).flags.has("\\Seen")).toBe(false);
  });

  it("falls back to HTML-to-text, or returns HTML on request", async () => {
    expect((await call("read_email", { uid: 102 })).body).toBe("News\nHello & welcome");
    expect((await call("read_email", { uid: 101, format: "html" })).body).toBe("<p>明天</p>");
  });

  it("returns a helpful error for unknown folders and UIDs", async () => {
    expect((await call("read_email", { uid: 999 })).error).toMatch(/not found/);
    expect((await call("search_emails", { folder: "Nope" })).error).toMatch(/list_folders/);
  });

  it("downloads small attachments inline as an embedded resource", async () => {
    const content = await call("download_attachment", { uid: 101, mode: "base64" });
    expect(JSON.parse(content[0].text)).toMatchObject({ filename: "报告.pdf", size_bytes: PDF.length });
    expect(content[1].resource.mimeType).toBe("application/pdf");
    expect(content[1].resource.blob).toBe(base64Encode(enc.encode(PDF)));
  });

  it("issues a short-lived download URL that streams the decoded file", async () => {
    const r = await call("download_attachment", { uid: 101, filename: "报告.pdf" });
    expect(r.download_url).toMatch(/^https:\/\/qqmail\.example\.com\/download\/[0-9a-f]{64}\//);
    const res = await route(new Request(r.download_url), ctx.env, { connect: ctx.connect });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
    expect(await res.text()).toBe(PDF);
    const bad = await route(new Request("https://qqmail.example.com/download/" + "0".repeat(64)), ctx.env, { connect: ctx.connect });
    expect(bad.status).toBe(404);
  });

  it("serves active content types as octet-stream", async () => {
    const r = await call("download_attachment", { uid: 102, part: "1" });
    const res = await route(new Request(r.download_url), ctx.env, { connect: ctx.connect });
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await res.text()).toContain("<h1>News</h1>");
  });
});

describe("modify tools", () => {
  it("marks read and starred", async () => {
    const r = await call("set_email_flags", { uids: [101], seen: true, flagged: true });
    expect(r.messages[0]).toMatchObject({ uid: 101, seen: true, flagged: true });
    await call("set_email_flags", { uids: [101], seen: false });
    expect([...imap.find("INBOX", 101).flags]).toEqual(["\\Flagged"]);
  });

  it("moves to a custom folder by display name", async () => {
    const r = await call("move_emails", { uids: [101, 555], destination: "其他文件夹" });
    expect(r).toMatchObject({ moved: 1, destination: "其他文件夹", missing: [555] });
    expect(imap.folders["&UXZO1mWHTvZZOQ-"].messages).toHaveLength(1);
    expect(imap.folders.INBOX.messages.map((m) => m.uid)).toEqual([102]);
  });

  it("falls back to COPY + UID EXPUNGE without MOVE", async () => {
    imap.caps = "IMAP4rev1 UIDPLUS";
    const r = await call("move_emails", { uids: [102], destination: "junk" });
    expect(r.moved).toBe(1);
    expect(r).toMatchObject({ move_method: "copy", source_expunged: true, expunge_method: "uid_expunge" });
    expect(imap.commands.some((c) => c.includes("UID COPY"))).toBe(true);
    expect(imap.folders.INBOX.messages.map((m) => m.uid)).toEqual([101]);
  });

  it("without UIDPLUS never EXPUNGEs or CLOSEs a whole folder", async () => {
    imap.caps = "IMAP4rev1";
    imap.find("INBOX", 101).flags.add("\\Deleted");
    const r = await call("move_emails", { uids: [102], destination: "junk" });
    expect(r).toMatchObject({ moved: 1, move_method: "copy", source_expunged: false, pending_expunge: [102] });
    expect(imap.folders.INBOX.messages.map(m => m.uid)).toEqual([101, 102]);
    expect(imap.find("INBOX", 101).flags.has("\\Deleted")).toBe(true);
    expect(imap.folders.Junk.messages).toHaveLength(1);
    expect(imap.commands.some(c => / (EXPUNGE|CLOSE)$/.test(c))).toBe(false);
    expect(imap.commands.some(c => c.includes("-FLAGS.SILENT"))).toBe(false);
  });

  it("deletes to Trash, then permanently from Trash", async () => {
    expect(await call("delete_emails", { uids: [102] })).toMatchObject({ moved_to_trash: 1 });
    const trashed = imap.folders["Deleted Messages"].messages[0].uid;
    expect(await call("delete_emails", { folder: "trash", uids: [trashed] })).toMatchObject({ permanently_deleted: 1 });
    expect(imap.folders["Deleted Messages"].messages).toHaveLength(0);
  });

  it("saves and replaces drafts", async () => {
    const a = await call("save_draft", { to: ["ann@example.com"], bcc: ["boss@example.com"], subject: "草稿", body: "v1" });
    expect(a).toMatchObject({ saved: true, folder: "Drafts", uid: 1 });
    const draft = imap.find("Drafts", 1);
    expect([...draft.flags]).toEqual(["\\Draft", "\\Seen"]);
    expect(draft.raw).toContain("Bcc: boss@example.com");
    const b = await call("save_draft", { to: ["ann@example.com"], subject: "草稿", body: "v2", replace_draft_uid: 1 });
    expect(b).toMatchObject({ uid: 2, replaced_previous: true });
    expect(imap.folders.Drafts.messages.map((m) => m.uid)).toEqual([2]);
  });
});

describe("send tools", () => {
  const sentHeaders = (i = 0) => {
    const data = smtp.sent[i].data;
    return parseHeaders(data.slice(0, data.indexOf("\r\n\r\n")));
  };

  it("sends with Bcc only in the envelope", async () => {
    const r = await call("send_email", { to: ["Ann <ann@example.com>"], cc: ["cc@example.com"], bcc: ["hidden@example.com"], subject: "你好", body: "line\n.starts with dot", attachments: [{ filename: "a.txt", content_base64: base64Encode(enc.encode("hi")) }] });
    expect(r).toMatchObject({ sent: true, accepted: ["ann@example.com", "cc@example.com", "hidden@example.com"], bcc_count: 1, saved_to_sent: false });
    const m = smtp.sent[0];
    expect(m.from).toBe("me@qq.com");
    expect(m.rcpt).toEqual(["ann@example.com", "cc@example.com", "hidden@example.com"]);
    expect(m.data).not.toContain("hidden@example.com");
    expect(sentHeaders()).toMatchObject({ subject: "你好", from: "我 <me@qq.com>", to: "Ann <ann@example.com>" });
  });

  it("validates recipients and attachments before connecting", async () => {
    expect((await call("send_email", { to: ["not-an-address"], subject: "x" })).error).toMatch(/Invalid to address/);
    expect((await call("send_email", { to: ["a@b.com"], subject: "x", attachments: [{ filename: "a", content_base64: "***" }] })).error).toMatch(/base64/);
    expect(ctx.connect.calls).toHaveLength(0);
  });

  it("reports partial recipient rejection and saves to Sent when asked", async () => {
    const r = await call("send_email", { to: ["ok@example.com", "reject@example.com"], subject: "s", body: "b", save_to_sent: true });
    expect(r.rejected).toHaveLength(1);
    expect(r.saved_to_sent).toBe(true);
    expect(imap.folders["Sent Messages"].messages).toHaveLength(1);
  });

  it("replies in-thread, quotes the original and marks it answered", async () => {
    const r = await call("reply_email", { uid: 101, body: "收到", reply_all: true });
    expect(r.to).toEqual(["张三 <zhangsan@example.com>"]);
    expect(r.cc).toEqual(["li@example.com"]);
    const h = sentHeaders();
    expect(h).toMatchObject({ subject: "Re: 会议通知", "in-reply-to": "<m101@example.com>", references: "<m101@example.com>" });
    const body = Buffer.from(smtp.sent[0].data.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(body).toContain("收到");
    expect(body).toContain("> 明天上午十点开会。");
    expect(imap.find("INBOX", 101).flags.has("\\Answered")).toBe(true);
  });

  it("replies to self-sent only-self mail by defaulting to own address", async () => {
    const selfMsg = {
      uid: 201,
      ...makeMessage({
        headers: { From: "我 <me@qq.com>", To: "me@qq.com", Subject: "self note", Date: "Sun, 01 Nov 2026 12:00:00 +0800", "Message-ID": "<self201@qq.com>" },
        parts: [{ type: "text/plain", params: { CHARSET: "UTF-8" }, encoding: "7bit", content: "only me" }],
      }),
    };
    imap.add("Sent Messages", selfMsg, 201);
    const r = await call("reply_email", { folder: "sent", uid: 201, body: "looping back", quote_original: false });
    expect(r.to).toEqual(["我 <me@qq.com>"]);
    expect(smtp.sent[0].rcpt).toEqual(["me@qq.com"]);
  });

  it("lets reply_email override recipients with explicit to", async () => {
    const selfMsg = {
      uid: 202,
      ...makeMessage({
        headers: { From: "我 <me@qq.com>", To: "me@qq.com", Subject: "self note 2", Date: "Sun, 01 Nov 2026 12:05:00 +0800", "Message-ID": "<self202@qq.com>" },
        parts: [{ type: "text/plain", params: { CHARSET: "UTF-8" }, encoding: "7bit", content: "only me" }],
      }),
    };
    imap.add("Sent Messages", selfMsg, 202);
    const r = await call("reply_email", { folder: "sent", uid: 202, body: "redirect", to: ["other@example.com"], quote_original: false });
    expect(r.to).toEqual(["other@example.com"]);
    expect(smtp.sent[0].rcpt).toEqual(["other@example.com"]);
  });

  it("forwards with the original attachment passed through", async () => {
    const r = await call("forward_email", { uid: 101, to: ["boss@example.com"], body: "FYI" });
    expect(r).toMatchObject({ attachments_forwarded: 1, subject: "Fwd: 会议通知" });
    const data = smtp.sent[0].data;
    expect(data).toContain("Content-Type: application/pdf");
    expect(data).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
    expect(data).toContain(base64Encode(enc.encode(PDF), 76).split("\r\n")[0]);
  });

  it("sends a draft, strips Bcc from the content and removes the draft", async () => {
    await call("save_draft", { to: ["ann@example.com"], bcc: ["boss@example.com"], subject: "Plan", body: "draft body" });
    const r = await call("send_draft", { uid: 1 });
    expect(r).toMatchObject({ sent: true, draft_removed: true, bcc_count: 1, subject: "Plan", source_expunged: true });
    expect(smtp.sent[0].rcpt).toEqual(["ann@example.com", "boss@example.com"]);
    expect(smtp.sent[0].data).not.toMatch(/^Bcc:/im);
    expect(imap.folders.Drafts.messages).toHaveLength(0);
  });

  it("leaves a sent draft hidden and blocks duplicate sends without UIDPLUS", async () => {
    imap.caps = "IMAP4rev1";
    imap.emptyDeletedSearch = true;
    await call("save_draft", { to: ["ann@example.com"], subject: "SafePending", body: "x" });
    const r = await call("send_draft", { uid: 1 });
    expect(r).toMatchObject({ sent: true, draft_removed: false, draft_hidden: true, source_expunged: false, pending_expunge: [1] });
    expect(imap.folders.Drafts.messages).toHaveLength(1);
    expect(imap.commands.some(c => / (EXPUNGE|CLOSE)$/.test(c))).toBe(false);
    expect((await call("send_draft", { uid: 1 })).error).toMatch(/already sent/);
    expect(smtp.sent).toHaveLength(1);
  });

  it("reports pending_expunge when EXPUNGE is a no-op (QQ)", async () => {
    imap.caps = "IMAP4rev1";
    imap.emptyDeletedSearch = true;
    imap.noopExpunge = true;
    await call("save_draft", { to: ["ann@example.com"], subject: "NoopExpunge", body: "x" });
    const r = await call("send_draft", { uid: 1 });
    expect(r.sent).toBe(true);
    expect(r.draft_removed).toBe(false); // Physical deletion is not falsely claimed.
    expect(r.source_expunged).toBe(false);
    expect(r.pending_expunge).toContain(1);
    expect(imap.folders.Drafts.messages).toHaveLength(1);
    expect(imap.find("Drafts", 1).flags.has("\\Deleted")).toBe(true);
    const listed = await call("search_emails", { folder: "drafts", limit: 10 });
    expect(listed.results.map((x) => x.uid)).not.toContain(1);
    const withDeleted = await call("search_emails", { folder: "drafts", limit: 10, include_deleted: true });
    expect(withDeleted.results.map((x) => x.uid)).toContain(1);
  });

  it("surfaces SMTP authentication failures", async () => {
    smtp.password = "different";
    expect((await call("send_email", { to: ["a@b.com"], subject: "x", body: "y" })).error).toMatch(/SMTP login failed/);
  });
});


describe("HTML-only draft regressions", () => {
  function legacy(plain = "") {
    imap.folders.INBOX.messages.push({uid: 103, ...makeMessage({
      headers: {From: "ann@example.com", To: "me@qq.com", Subject: "Legacy HTML", "Message-ID": "<legacy-html@example.com>"},
      parts: [
        {type: "text/plain", params: {CHARSET: "UTF-8"}, encoding: "base64", content: plain},
        {type: "text/html", params: {CHARSET: "UTF-8"}, encoding: "base64", content: "<p>HTML 正文青竹</p>"}
      ]
    })});
  }
  function plainMime(raw) {
    const m = /Content-Type: text\/plain[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]*)/i.exec(raw);
    expect(m, "generated MIME must contain a plain-text part").not.toBeNull();
    return Buffer.from(m[1].replace(/\s/g, ""), "base64").toString("utf8");
  }
  it.each(["", "   \r\n"])("reads HTML fallback when plain alternative is %j without marking read", async plain => {
    legacy(plain);
    const r = await call("read_email", {uid: 103, format: "text"});
    expect(r.body).toContain("HTML 正文青竹");
    expect(imap.find("INBOX", 103).flags.has("\\Seen")).toBe(false);
  });
  it("creates a readable plain alternative for an HTML-only draft and sends it", async () => {
    const d = await call("save_draft", {to: ["me@qq.com"], subject: "HTML draft", html: "<p>草稿青竹</p>"});
    // The APPEND fake stores raw bytes but does not parse MIME into BODYSTRUCTURE.
    // Inspect the generated MIME before and after delivery; live acceptance also reads it via QQ.
    expect(plainMime(imap.find("Drafts", d.uid).raw)).toContain("草稿青竹");
    const sent = await call("send_draft", {uid: d.uid, save_to_sent: true});
    expect(sent.sent).toBe(true);
    expect(smtp.sent).toHaveLength(1);
    expect(plainMime(smtp.sent[0].data)).toContain("草稿青竹");
    expect(plainMime(imap.find("Sent Messages", 1).raw)).toContain("草稿青竹");
  });
  it("quotes the HTML original rather than an empty plain alternative", async () => {
    legacy("   ");
    await call("reply_email", {uid: 103, body: "Reply", save_to_sent: true});
    expect(plainMime(smtp.sent[0].data)).toContain("HTML 正文青竹");
    expect(plainMime(imap.find("Sent Messages", 1).raw)).toContain("HTML 正文青竹");
  });
});
