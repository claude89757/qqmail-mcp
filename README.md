# qqmail-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants (ChatGPT, Grok Bot, Cursor, Claude, …) access to **one QQ Mail mailbox** over IMAP and SMTP. It runs as a single Cloudflare Worker with a built-in OAuth 2.1 authorization server, and Cloudflare Access acts as the login screen.

Hosted instance used by the author: **`https://qqmail.zacks.vision/mcp`**

[中文说明](#中文快速说明)

## Features

| Tool | Scope | What it does |
| --- | --- | --- |
| `check_mail_connection` | `mail:read` | IMAP (and optionally SMTP) login check, INBOX counts, server capabilities |
| `list_folders` | `mail:read` | All folders, including Chinese names, with total and unread counts and special-use roles (sent, drafts, trash, junk) |
| `search_emails` | `mail:read` | Search any folder by text, from, to, subject, date range, unread or starred; newest first, paginated |
| `read_email` | `mail:read` | Headers, flags, body as text or HTML, and attachment list. Never marks the message as read |
| `list_attachments` | `mail:read` | Part numbers, filenames, types, approximate sizes |
| `download_attachment` | `mail:read` | Inline base64 (images come back as image content), or a short-lived HTTPS link that streams files of any size |
| `set_email_flags` | `mail:modify` | Read/unread, star/unstar, answered |
| `move_emails` | `mail:modify` | Move between folders (uses `MOVE` when available; otherwise `COPY` + `\Deleted` + `UID EXPUNGE` or a safe mailbox `EXPUNGE` when no other deleted mail would be wiped). Returns `source_expunged` / `pending_expunge`. |
| `delete_emails` | `mail:modify` | Move to Trash; `permanent: true` (or deleting from Trash) expunges |
| `save_draft` | `mail:modify` | Save or replace a draft in Drafts |
| `send_email` | `mail:send` | Send through `smtp.qq.com:465` with cc, bcc, HTML and attachments |
| `reply_email` | `mail:send` | Threaded reply (`In-Reply-To`/`References`), quotes the original, optional reply-all; optional `to` override (self-sent / only-self defaults to your address); marks the original as answered |
| `forward_email` | `mail:send` | Forward with a note; original attachments are passed through |
| `send_draft` | `mail:send` | Send a draft from Drafts (Bcc stripped from the content) and remove it |

Other details:

- Folder arguments accept display names (`其他文件夹/工作`) or the aliases `inbox`, `sent`, `drafts`, `trash`, `junk`. Names are converted to IMAP modified UTF-7 automatically.
- Message bodies are fetched by MIME part, so large messages no longer fail. GBK, GB2312, GB18030 and RFC 2047/2231 headers and filenames are decoded.
- Tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) let clients such as ChatGPT ask for confirmation before writes.

## Connect a client

Use the MCP URL **`https://qqmail.zacks.vision/mcp`** (or `https://<your-domain>/mcp` for your own deployment). Every client uses OAuth with dynamic client registration and PKCE; no API key is needed.

- **ChatGPT**: Settings → Apps & Connectors → enable developer mode → create a connector. Set the MCP server URL to `https://qqmail.zacks.vision/mcp` and authentication to OAuth. ChatGPT opens the Cloudflare Access login and returns automatically.
- **Grok Bot**: add a remote MCP server or connector with the URL `https://qqmail.zacks.vision/mcp` and choose OAuth.
- **Cursor** (`~/.cursor/mcp.json`):

  ```json
  { "mcpServers": { "qqmail": { "url": "https://qqmail.zacks.vision/mcp" } } }
  ```

Clients that were connected to v1.x only hold the `mail:read` scope. Disconnect and reconnect them to get the modify and send tools.

> The legacy `*.workers.dev` hostname is not protected by Cloudflare Access, so `/authorize` refuses requests on it. Existing tokens keep working there, but new connections must use the custom domain.

## Security model

- **Single-owner mailbox.** The QQ authorization code (`QQ_APP_PASSWORD`) stays in a Worker secret and is never exposed to MCP clients.
- **OAuth 2.1 authorization server** on the same origin: `/register` (RFC 7591 dynamic client registration), `/authorize`, `/token`, and RFC 8414 / RFC 9728 metadata. Only public clients with PKCE S256 are accepted. Access tokens live 24 hours; refresh tokens live 30 days and are rotated on every use. Only SHA-256 hashes of codes and tokens are stored in D1.
- **Redirect allowlist.** Any `https://` URI, `cursor://anysphere.cursor-mcp/oauth/callback`, and `http://localhost` or `http://127.0.0.1` loopback. URIs with embedded credentials or fragments are rejected.
- **Cloudflare Access gates `/authorize`.** The Access application covers only the `/authorize` path, and the Worker also verifies the `Cf-Access-Jwt-Assertion` JWT itself (RS256 signature, `aud`, `iss`, expiry, and an optional email allowlist). If Access is not configured, `/authorize` fails closed with a 503.
- **Scopes.** `mail:read`, `mail:modify` and `mail:send`. Set `ENABLE_MODIFY=false` or `ENABLE_SEND=false` to remove those tools for every token immediately.
- **Download links** are 256-bit random tokens, stored hashed, that expire after 15 minutes by default. They are served with `Content-Disposition: attachment`, a sandbox CSP, and `nosniff`. Active content types (HTML, SVG, XML, JS) are served as `application/octet-stream`.
- **Prompt injection.** Email content is untrusted. The send tools tell the model to act only on explicit user requests, but you should still review write and send confirmations in your client.

## Deploy your own

Prerequisites: a Cloudflare account, a domain on Cloudflare, and a QQ Mail account with IMAP/SMTP enabled (QQ Mail → Settings → Account → POP3/IMAP/SMTP → enable, then generate an **authorization code (授权码)**).

```bash
git clone https://github.com/claude89757/qqmail-mcp && cd qqmail-mcp
npm install

# 1. D1 database for OAuth state (skip if you already have one)
npx wrangler d1 create qqmail-mcp-oauth   # put the returned id into wrangler.jsonc
npm run db:migrate

# 2. Mailbox credentials (secrets never go in the repo)
npx wrangler secret put QQ_EMAIL           # e.g. 12345@qq.com
npx wrangler secret put QQ_APP_PASSWORD    # the QQ authorization code

# 3. Cloudflare Access (Zero Trust → Access → Applications → Self-hosted)
#    Application domain: <your-domain>/authorize ; policy: allow only your email
npx wrangler secret put ACCESS_TEAM_DOMAIN     # <team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD             # the application's Audience (AUD) tag
npx wrangler secret put ACCESS_ALLOWED_EMAILS  # optional, comma-separated

# 4. Edit the "routes" custom domain in wrangler.jsonc, then:
npm run deploy
```

Values can also be set as plain-text variables in the dashboard. `wrangler.jsonc` sets `keep_vars: true`, so `wrangler deploy` will not delete them.

### Upgrading the existing v1.2.1 deployment

1. Before deploying v2, set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (and preferably `ACCESS_ALLOWED_EMAILS`). Without them, new authorizations return 503. Existing tokens and refresh tokens are not affected.
2. `npm run deploy` deploys to the same Worker name (`qqmail-mcp`), custom domain, D1 binding and secrets.
3. Reconnect ChatGPT, Grok Bot and Cursor to get the new scopes.
4. Check `GET /health`. It should report `"version":"2.0.2"` and `"access_jwt_verification":true`.

### Configuration reference

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `QQ_EMAIL` | secret / var | — | Mailbox address (`qq.com`, `vip.qq.com`, `foxmail.com`) |
| `QQ_APP_PASSWORD` | **secret** | — | QQ Mail authorization code |
| `QQ_DISPLAY_NAME` | var | — | Display name in the `From:` header |
| `ACCESS_TEAM_DOMAIN` | secret / var | — | `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | secret / var | — | Access application audience tag |
| `ACCESS_ALLOWED_EMAILS` | secret / var | — | Optional email allowlist checked against the Access JWT |
| `ENABLE_MODIFY` | var | `true` | Enables the `mail:modify` tools |
| `ENABLE_SEND` | var | `true` | Enables the `mail:send` tools |
| `SAVE_SENT_COPY` | var | `false` | Default for `save_to_sent`. Turn it on if QQ Mail does not already keep SMTP-sent mail (QQ setting “SMTP发信后保存到服务器”) |
| `MAX_INLINE_ATTACHMENT_BYTES` | var | `4194304` | Size limit for `download_attachment` with `mode: "base64"` |
| `DOWNLOAD_TTL_SECONDS` | var | `900` | Download link lifetime (maximum 3600) |
| `ALLOW_INSECURE_LOCAL_AUTHORIZE` | var | — | Local development only: skips the Access check on `localhost` |

### Limits

The Worker caps each IMAP session at 48 MB and bodies read per part at 2 MB. Inline attachments are limited to 4 MB; download links have no size limit because they stream. Outgoing attachments may total 20 MB, with at most 50 recipients per message and at most 100 UIDs per bulk operation. Outbound port 25 is blocked on Workers, so SMTP uses implicit TLS on port 465.

## Development

```bash
npm install
npm test                 # unit + end-to-end tests against in-memory IMAP/SMTP/D1 fakes
cp .dev.vars.example .dev.vars   # fill in; set ALLOW_INSECURE_LOCAL_AUTHORIZE=true
npm run db:migrate:local
npm run dev              # http://127.0.0.1:8787
npm run smoke            # DCR → authorize → token → initialize → tools/list
npm run smoke -- --live  # also logs in to QQ IMAP/SMTP with .dev.vars credentials
npm run check            # tests + wrangler dry-run bundle
```

Project layout:

```
src/index.js       router (health, OAuth endpoints, /mcp, /download)
src/oauth.js       OAuth 2.1 AS: DCR, authorize, token, scopes
src/access.js      Cloudflare Access JWT verification
src/mcp.js         JSON-RPC / Streamable HTTP handler
src/tools.js       tool schemas, annotations, scopes
src/mail.js        tool implementations
src/imap.js        IMAP client (literals, MOVE/UIDPLUS fallbacks, safe EXPUNGE without UIDPLUS, streaming fetch)
                   Note: QQ Mail often lacks UIDPLUS; without it we only EXPUNGE when every \Deleted
                   message in the mailbox is one we just marked (avoids wiping unrelated trash).
src/imap-parse.js  response parser, BODYSTRUCTURE, modified UTF-7
src/mime.js        header decoding, HTML→text, message builder
src/smtp.js        SMTP client (AUTH LOGIN, dot-stuffing)
src/download.js    short-lived attachment links
```

## 中文快速说明

- **连接地址**：在 ChatGPT（开发者模式 → 创建连接器）、Grok Bot 或 Cursor 中填写 `https://qqmail.zacks.vision/mcp`，认证方式选 OAuth。登录页由 Cloudflare Access 提供，只允许邮箱所有者登录。
- **功能**：文件夹与未读数、搜索（支持中文）、阅读、附件下载（内联或临时链接）、标记已读/未读/星标、移动、删除、草稿，以及通过 SMTP 发送、回复、转发。
- **权限**：`mail:read`、`mail:modify`、`mail:send` 三个作用域。可用 `ENABLE_MODIFY=false` 或 `ENABLE_SEND=false` 随时关闭写入或发信。从 v1.x 升级后需要重新连接客户端才能获得新权限。
- **部署**：`QQ_APP_PASSWORD` 填 QQ 邮箱的“授权码”（不是登录密码），必须用 `wrangler secret put` 设置，不要提交到仓库。升级前先设置 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD`。

## License

[MIT](LICENSE)
