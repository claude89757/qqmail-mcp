import { describe, it, expect } from "vitest";
import { validClient, sha, token, authenticate, authorize } from "../src/oauth.js";
import { store } from "../src/store.js";
import { fakeD1 } from "./helpers/fake-d1.js";
import { callTool } from "../src/mcp.js";
import { FakeImapServer, FakeSmtpServer, fakeConnect, makeMessage } from "./helpers/fake-mail.js";
const origin = "https://qqmail.example.com";
const env = () => ({ OAUTH_DB: fakeD1(), QQ_EMAIL: "me@qq.com", QQ_APP_PASSWORD: "pw" });
const postToken = p => new Request(origin + "/token", { method: "POST", body: new URLSearchParams(p) });
const deps = { verifyAccess: async () => ({ ok: true, email: "owner@example.com" }) };
async function consentPage(e) {
  await store(e).put("client:c", { client_name: "<script>bad</script>", redirect_uris: ["https://client.example/cb"] });
  const q = new URLSearchParams({ client_id: "c", redirect_uri: "https://client.example/cb", response_type: "code", code_challenge_method: "S256", code_challenge: await sha("v".repeat(43)), state: "state1" });
  const page = await authorize(new Request(origin + "/authorize?" + q), e, origin, deps);
  const html = await page.text();
  return { page, html, nonce: /name="consent" value="([^"]+)"/.exec(html)[1], cookie: page.headers.get("set-cookie").split(";")[0] };
}
describe("security regression", () => {
  it("rejects unregistered URL clients and mismatched redirects", async () => {
    const e = env();
    expect(await validClient(e, "https://fake.example/client.json", "https://evil.example/cb")).toBe(false);
    await store(e).put("client:c", { redirect_uris: ["https://good.example/cb"] });
    expect(await validClient(e, "c", "https://evil.example/cb")).toBe(false);
  });
  it("requires owner-bound one-use consent with origin, cookie and explicit approval", async () => {
    const e = env(), c = await consentPage(e);
    expect(c.page.status).toBe(200);
    expect(c.page.headers.get("location")).toBeNull();
    expect(c.html).not.toContain("<script>bad</script>");
    const req = (originHeader = origin, cookie = c.cookie) => new Request(origin + "/authorize", { method: "POST", headers: { Origin: originHeader, Cookie: cookie }, body: new URLSearchParams({ consent: c.nonce, decision: "allow" }) });
    expect((await authorize(req("https://evil.example"), e, origin, deps)).status).toBe(403);
    expect((await authorize(req(origin, ""), e, origin, deps)).status).toBe(403);
    expect((await authorize(req(), e, origin, { verifyAccess: async () => ({ok:true,email:"other@example.com"}) })).status).toBe(403);
    const approved = await authorize(req(), e, origin, deps);
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.get("location")).searchParams.get("code")).toBeTruthy();
    expect((await authorize(req(), e, origin, deps)).status).toBe(403);
  });
  it("denial never issues an authorization code", async () => {
    const e = env(), c = await consentPage(e);
    const r = await authorize(new Request(origin + "/authorize", { method:"POST", headers:{Origin:origin,Cookie:c.cookie}, body:new URLSearchParams({consent:c.nonce,decision:"deny"}) }),e,origin,deps);
    const u = new URL(r.headers.get("location"));
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.has("code")).toBe(false);
  });
  it("authorization codes can be consumed only once under concurrency", async () => {
    const e = env(), verifier = "v".repeat(43), code = "test-code";
    await store(e).put("code:" + await sha(code), {clientId:"c",redirectUri:"https://client.example/cb",challenge:await sha(verifier),scope:"mail:read",resource:origin+"/mcp"},{expirationTtl:300});
    const p = {grant_type:"authorization_code",client_id:"c",redirect_uri:"https://client.example/cb",code,code_verifier:verifier};
    const results = await Promise.all(Array.from({length:8},()=>token(postToken(p),e,origin)));
    expect(results.filter(r=>r.status===200)).toHaveLength(1);
  });
  it("refresh replay revokes descendant access tokens", async () => {
    const e=env();
    await store(e).put("refresh:"+await sha("r"),{clientId:"c",scope:"mail:read",family:"f",resource:origin+"/mcp"},{expirationTtl:300});
    const p={grant_type:"refresh_token",client_id:"c",refresh_token:"r"};
    const ok=await token(postToken(p),e,origin); expect(ok.status).toBe(200);
    const tokens=await ok.json();
    const request=new Request(origin+"/mcp",{headers:{Authorization:"Bearer "+tokens.access_token}});
    expect(await authenticate(request,e)).not.toBeNull();
    expect((await token(postToken(p),e,origin)).status).toBe(400);
    expect(await authenticate(request,e)).toBeNull();
  });
  it("does not permit refresh scope escalation or incorrect resource",async()=>{
    const e=env(); await store(e).put("refresh:"+await sha("r"),{clientId:"c",scope:"mail:read",resource:origin+"/mcp"},{expirationTtl:300});
    const p={grant_type:"refresh_token",client_id:"c",refresh_token:"r"};
    expect((await token(postToken({...p,scope:"mail:read mail:send"}),e,origin)).status).toBe(400);
    expect((await token(postToken({...p,resource:"https://evil.example/mcp"}),e,origin)).status).toBe(400);
    expect((await token(postToken(p),e,origin)).status).toBe(200);
  });
});
describe("search and send regression",()=>{
  function context(count=1) {
    const messages=Array.from({length:count},(_,i)=>({uid:i+1,...makeMessage({headers:{From:"student@example.com",To:"me@qq.com",Subject:"会徽方案",Date:"Sun, 01 Nov 2026 10:00:00 +0800","Message-ID":`<${i}@example.com>`},parts:[{type:"text/plain",params:{CHARSET:"UTF-8"},encoding:"base64",content:"正文唯一词青竹七号"}]})}));
    const imap=new FakeImapServer({user:"me@qq.com",password:"pw",folders:{INBOX:{messages},Drafts:{},"Sent Messages":{},"Deleted Messages":{},Junk:{}}});
    const smtp=new FakeSmtpServer({user:"me@qq.com",password:"pw"});
    const ctx={env:env(),connect:fakeConnect({imap,smtp}),origin};
    const call=async(name,args)=>{const r=(await callTool(ctx,{scopes:["mail:read","mail:modify","mail:send"]},name,args)).result;return JSON.parse(r.content[0].text)};
    return {call,imap,smtp};
  }
  it("keeps Chinese subject/from/date/flag filters ANDed",async()=>{
    const {call}=context();
    expect((await call("search_emails",{subject:"会徽",from:"no_reply@email.apple.com"})).total).toBe(0);
    expect((await call("search_emails",{subject:"会徽",since:"2026-11-02"})).total).toBe(0);
    expect((await call("search_emails",{subject:"会徽",before:"2026-11-01"})).total).toBe(0);
    expect((await call("search_emails",{subject:"会徽",flagged_only:true})).total).toBe(0);
    expect((await call("search_emails",{subject:"会徽",from:"student",since:"2026-11-01",before:"2026-11-02",unread_only:true})).total).toBe(1);
  });
  it("matches decoded body, leaves unread state unchanged and validates dates",async()=>{
    const {call,imap}=context();
    expect((await call("search_emails",{query:"青竹七号"})).results[0].uid).toBe(1);
    expect(imap.find("INBOX",1).flags.has("\\Seen")).toBe(false);
    expect((await call("search_emails",{since:"2026-02-30"})).error).toMatch(/Invalid since/);
  });
  it("reports incomplete scans honestly and supports continuation",async()=>{
    const {call}=context(65);
    const first=await call("search_emails",{query:"不存在正文词"});
    expect(first).toMatchObject({partial:true,total:null,total_is_exact:false,scanned:64,next_scan_before_uid:2});
    const last=await call("search_emails",{query:"不存在正文词",scan_before_uid:first.next_scan_before_uid});
    expect(last).toMatchObject({partial:false,total:0,scanned:1});
  });
  it("keep_draft is truthful and concurrent draft sending is at-most-once",async()=>{
    const {call,smtp}=context();
    const draft=await call("save_draft",{to:["me@qq.com"],subject:"repeat guard",body:"test"});
    const results=await Promise.all([call("send_draft",{uid:draft.uid,keep_draft:true}),call("send_draft",{uid:draft.uid,keep_draft:true})]);
    expect(results.filter(x=>x.sent)).toHaveLength(1); expect(smtp.sent).toHaveLength(1);
    expect(results.find(x=>x.sent)).toMatchObject({draft_removed:false,draft_hidden:false,source_expunged:false});
  });
});
