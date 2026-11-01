import { describe, expect, it } from "vitest";
import { Base64Decoder, QuotedPrintableDecoder, base64Decode, base64Encode, concatBytes, enc } from "../src/bytes.js";
import { decodeMailboxName, encodeMailboxName, fetchAttributes, flattenBodyStructure, isAttachment, paramValue, parseResponse } from "../src/imap-parse.js";
import { buildMessage, decodeHeader, htmlToText, parseAddressList, parseHeaders, prefixSubject, removeHeader } from "../src/mime.js";
import { smtpData } from "../src/smtp.js";

const dec = new TextDecoder();

describe("IMAP response parser", () => {
  it("parses nested lists, quoted strings, NIL, bracketed atoms and literals", () => {
    const v = parseResponse(['* 3 FETCH (UID 42 FLAGS (\\Seen \\Flagged) BODY[HEADER.FIELDS (FROM SUBJECT)] ', enc.encode("Subject: hi\r\n"), ' X "a \\"q\\"" NIL)']);
    expect(v.slice(0, 3)).toEqual(["*", "3", "FETCH"]);
    const attrs = fetchAttributes(v[3]);
    expect(attrs.UID).toBe("42");
    expect(attrs.FLAGS).toEqual(["\\Seen", "\\Flagged"]);
    expect(dec.decode(attrs["BODY[HEADER.FIELDS (FROM SUBJECT)]"])).toBe("Subject: hi\r\n");
    expect(attrs.X).toBe('a "q"');
  });

  it("strips partial-range suffixes from BODY keys", () => {
    const attrs = fetchAttributes(parseResponse(["* 1 FETCH (BODY[1]<0> ", enc.encode("x"), ")"])[3]);
    expect(Object.keys(attrs)).toEqual(["BODY[1]"]);
  });

  it("round-trips modified UTF-7 mailbox names", () => {
    expect(encodeMailboxName("其他文件夹")).toBe("&UXZO1mWHTvZZOQ-");
    expect(decodeMailboxName("&UXZO1mWHTvZZOQ-/Work")).toBe("其他文件夹/Work");
    expect(encodeMailboxName("A&B")).toBe("A&-B");
    expect(decodeMailboxName(encodeMailboxName("项目 & 工作/2026"))).toBe("项目 & 工作/2026");
  });

  it("flattens BODYSTRUCTURE with section numbers and decoded filenames", () => {
    const bs = parseResponse([
      '(((("TEXT" "PLAIN" ("CHARSET" "GBK") NIL NIL "BASE64" 100 2 NIL NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 200 5 NIL NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "x") NIL NIL NIL)("IMAGE" "PNG" ("NAME" "a.png") "<img1@x>" NIL "BASE64" 780 NIL ("INLINE" NIL) NIL NIL) "RELATED" NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "=?UTF-8?B?5oql5ZGKLnBkZg==?=") NIL NIL "BASE64" 7800 NIL ("ATTACHMENT" ("FILENAME" "=?UTF-8?B?5oql5ZGKLnBkZg==?=")) NIL NIL) "MIXED" ("BOUNDARY" "y") NIL NIL NIL)',
    ])[0];
    const parts = flattenBodyStructure(bs);
    expect(parts.map((p) => [p.section, p.type])).toEqual([
      ["1.1.1", "text/plain"],
      ["1.1.2", "text/html"],
      ["1.2", "image/png"],
      ["2", "application/pdf"],
    ]);
    expect(parts[0].charset).toBe("GBK");
    expect(parts[2]).toMatchObject({ content_id: "img1@x", disposition: "inline", filename: "a.png" });
    expect(parts[3].filename).toBe("报告.pdf");
    expect(parts.filter(isAttachment).map((p) => p.section)).toEqual(["1.2", "2"]);
  });

  it("uses TEXT as the fetch section for single-part messages", () => {
    const parts = flattenBodyStructure(parseResponse(['("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)'])[0]);
    expect(parts).toMatchObject([{ section: "1", fetch_section: "TEXT" }]);
  });

  it("decodes RFC 2231 continuations", () => {
    expect(paramValue({ "filename*0*": "UTF-8''%E6%8A%A5", "filename*1*": "%E5%91%8A.pdf" }, "filename")).toBe("报告.pdf");
    expect(paramValue({ "filename*": "gb2312''%B1%A8%B8%E6.txt" }, "filename")).toBe("报告.txt");
  });
});

describe("MIME helpers", () => {
  it("decodes encoded words including GBK and words split mid-character", () => {
    expect(decodeHeader("=?GBK?B?xOO6ww==?=")).toBe("你好");
    const bytes = enc.encode("会议通知");
    const a = base64Encode(bytes.slice(0, 4));
    const b = base64Encode(bytes.slice(4));
    expect(decodeHeader(`=?UTF-8?B?${a}?= =?UTF-8?B?${b}?=`)).toBe("会议通知");
    expect(decodeHeader("Re: =?utf-8?Q?caf=C3=A9_time?= ok")).toBe("Re: café time ok");
  });

  it("parses address lists with quoted names and commas", () => {
    expect(parseAddressList('"Doe, John" <john@x.com>, jane@y.org; 张三 <zs@qq.com>')).toEqual([
      { name: "Doe, John", address: "john@x.com" },
      { name: "", address: "jane@y.org" },
      { name: "张三", address: "zs@qq.com" },
    ]);
    expect(parseAddressList(["a@b.com", "B <b@c.com>"])).toHaveLength(2);
  });

  it("converts HTML to readable text", () => {
    expect(htmlToText('<style>x{}</style><p>Hello&nbsp;<b>World</b></p><a href="https://e.com/x">link</a><br>&#20320;&lt;')).toBe("Hello World\nlink (https://e.com/x)\n你<");
  });

  it("builds a multipart message that parses back", () => {
    const msg = buildMessage({
      from: { name: "我", address: "me@qq.com" },
      to: [{ name: "Ann", address: "ann@x.com" }],
      cc: [],
      bcc: [{ name: "", address: "hidden@x.com" }],
      subject: "季度报告 Q3",
      text: "正文",
      html: "<p>正文</p>",
      attachments: [{ filename: "数据.csv", contentType: "text/csv", data: enc.encode("a,b\n1,2\n") }],
      messageId: "<id@qq.com>",
    });
    expect(msg).not.toMatch(/[^\x00-\x7f]/);
    expect(msg).not.toMatch(/hidden@x\.com/);
    const h = parseHeaders(msg.slice(0, msg.indexOf("\r\n\r\n")));
    expect(h.subject).toBe("季度报告 Q3");
    expect(h.from).toBe("我 <me@qq.com>");
    expect(h["message-id"]).toBe("<id@qq.com>");
    expect(msg).toContain("multipart/mixed");
    expect(msg).toContain("multipart/alternative");
    expect(msg).toContain("filename*=UTF-8''%E6%95%B0%E6%8D%AE.csv");
  });

  it("removes Bcc headers including folded lines", () => {
    const raw = "From: a@b.com\r\nBcc: x@y.com,\r\n z@y.com\r\nSubject: s\r\n\r\nBcc: body stays\r\n";
    expect(removeHeader(raw, "Bcc")).toBe("From: a@b.com\r\nSubject: s\r\n\r\nBcc: body stays\r\n");
  });

  it("prefixes subjects once", () => {
    expect(prefixSubject("Hi", "re")).toBe("Re: Hi");
    expect(prefixSubject("回复：Hi", "re")).toBe("回复：Hi");
    expect(prefixSubject("Fwd: Hi", "fwd")).toBe("Fwd: Hi");
  });
});

describe("byte codecs", () => {
  it("base64 round-trips and decodes across arbitrary chunk boundaries", () => {
    const data = crypto.getRandomValues(new Uint8Array(1000));
    const text = enc.encode(base64Encode(data, 76));
    expect(base64Decode(text)).toEqual(data);
    const d = new Base64Decoder();
    const out = [];
    for (let i = 0; i < text.length; i += 7) out.push(d.push(text.subarray(i, i + 7)));
    expect(concatBytes(out)).toEqual(data);
  });

  it("quoted-printable decodes across chunk boundaries", () => {
    const src = enc.encode("caf=C3=A9 =\r\nline=3Dx");
    for (let cut = 1; cut < src.length; cut++) {
      const d = new QuotedPrintableDecoder();
      const out = concatBytes([d.push(src.subarray(0, cut)), d.push(src.subarray(cut)), d.push(new Uint8Array(0), true)]);
      expect(dec.decode(out)).toBe("café line=x");
    }
  });

  it("SMTP DATA normalizes line endings and dot-stuffs", () => {
    expect(dec.decode(smtpData(enc.encode("a\n.b\r\n..c\rd")))).toBe("a\r\n..b\r\n...c\r\nd\r\n.\r\n");
  });
});
