"""One-time release fix for HTML-only draft bodies, with regression coverage."""
from pathlib import Path
from hashlib import sha256

def replace_once(text, old, new):
    assert text.count(old) == 1, 'Unexpected source; refusing ambiguous replacement'
    return text.replace(old, new)

p = Path('src/mail.js')
s = p.read_text()
assert sha256(s.encode()).hexdigest() == 'b1b47c25518e288555559eef88be3674b9d0981d021de00994a95aff4ab365e9'
s = replace_once(s,
 '  return { text: decode(textPart), html: decode(htmlPart), truncated: chosen.some((p) => p.size > maxBytes) };',
 '''  const text = decode(textPart);
  // An empty plain alternative must not hide a non-empty HTML body (including old drafts).
  if (!wantHtml && textPart && htmlPart && !text.trim()) {
    const extra = (await s.uidFetch([uid], `UID BODY.PEEK[${htmlPart.fetch_section}]<0.${maxBytes}>`)).get(uid) || {};
    Object.assign(attrs, extra);
    chosen.push(htmlPart);
  }
  return { text, html: decode(htmlPart), truncated: chosen.some((p) => p.size > maxBytes) };''')
s = replace_once(s, 'includeBcc: true, subject: clean(args.subject, 900), text: args.body ?? "",', 'includeBcc: true, subject: clean(args.subject, 900), text: args.body ?? undefined,')
s = replace_once(s, '(orig.text || htmlToText(orig.html))', '(orig.text.trim() || htmlToText(orig.html))')
s = replace_once(s, 'const origText = orig.text || htmlToText(orig.html);', 'const origText = orig.text.trim() || htmlToText(orig.html);')
assert sha256(s.encode()).hexdigest() == 'c975a118275a09c5daba2d27b1367de732774d0b6420479c2eea1c4f67cc98f0'
p.write_text(s)
for filename in ['src/config.js','package.json','package-lock.json','test/oauth.test.js']:
    p=Path(filename); text=p.read_text(); assert '"2.0.3"' in text
    p.write_text(text.replace('"2.0.3"','"2.0.4"'))
p=Path('test/mail.test.js')
s=p.read_text()
assert 'HTML-only draft regressions' not in s
s += r'''

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
  it.each(["", "   \r\n"])("reads HTML fallback when plain alternative is %j without marking read", async plain => {
    legacy(plain);
    const r = await call("read_email", {uid: 103, format: "text"});
    expect(r.body).toContain("HTML 正文青竹");
    expect(imap.find("INBOX", 103).flags.has("\\Seen")).toBe(false);
  });
  it("creates a readable plain alternative for an HTML-only draft and sends it", async () => {
    const d = await call("save_draft", {to: ["me@qq.com"], subject: "HTML draft", html: "<p>草稿青竹</p>"});
    const r = await call("read_email", {folder: "drafts", uid: d.uid, format: "text"});
    expect(r.body).toContain("草稿青竹");
    const sent = await call("send_draft", {uid: d.uid, save_to_sent: true});
    expect(sent.sent).toBe(true);
    expect(smtp.sent).toHaveLength(1);
    const copy = await call("read_email", {folder: "sent", uid: 1, format: "text"});
    expect(copy.body).toContain("草稿青竹");
  });
  it("quotes the HTML original rather than an empty plain alternative", async () => {
    legacy("   ");
    await call("reply_email", {uid: 103, body: "Reply", save_to_sent: true});
    const copy = await call("read_email", {folder: "sent", uid: 1, format: "text"});
    expect(copy.body).toContain("HTML 正文青竹");
  });
});
'''
p.write_text(s)
print('Prepared 2.0.4; run npm run check before committing or deploying.')
