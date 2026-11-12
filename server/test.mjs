// node --test test.mjs  -- runs the server against a temp mailbox and a fake hc
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbx-"));
const mail = path.join(dir, "mail");
fs.mkdirSync(mail);
const hc = path.join(dir, "hc");
// fake `hc send NAME TEXT`: what box.sh does (timestamped line into NAME.log)
fs.writeFileSync(hc, `#!/bin/sh\n[ "$1" = send ] || exit 2\nprintf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" >> "${mail}/$2.log"\n`, { mode: 0o755 });
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, MBX_STATE: path.join(dir, "state.json"), MBX_MAILDIR: mail, MBX_HC: hc, MBX_PORT: String(PORT), MBX_BASE: BASE };
const srv = new URL("./server.mjs", import.meta.url).pathname;
const cli = (...a) => execFileSync("node", [srv, ...a], { env }).toString().trim();
let proc, tokA, tokB;

before(async () => {
  cli("add-agent", "alice", "inbox-alice", "outbox-alice");
  cli("add-agent", "bob", "inbox-bob", "outbox-bob");
  fs.writeFileSync(path.join(mail, "inbox-alice.log"), "2026-11-11T01:00:00Z for alice 1\n2026-11-11T02:00:00Z for alice 2\n");
  fs.writeFileSync(path.join(mail, "inbox-bob.log"), "2026-11-11T01:00:00Z SECRET for bob\n");
  tokA = cli("issue-token", "alice");
  tokB = cli("issue-token", "bob");
  proc = spawn("node", [srv], { env, stdio: ["ignore", "pipe", "inherit"] });
  await once(proc.stdout, "data"); // "mailbox mcp on ..." means listening
});
after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const mcp = async (tok, method, params, id = 1) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { status: r.status, headers: r.headers, json: r.status === 200 ? await r.json() : null };
};
const call = async (tok, name, args) => (await mcp(tok, "tools/call", { name, arguments: args })).json.result.structuredContent;

test("no or bad token -> 401 with resource metadata", async () => {
  for (const t of [null, "mbx_wrong"]) {
    const r = await mcp(t, "tools/list");
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /resource_metadata=".*oauth-protected-resource/);
  }
});

test("handshake: initialize, tools/list has exactly the 3 tools", async () => {
  const i = await mcp(tokA, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(i.json.result.serverInfo.name, "herdr-agent-mailbox");
  const l = await mcp(tokA, "tools/list");
  assert.deepEqual(l.json.result.tools.map((t) => t.name).sort(), ["list_my_messages", "send_message", "whoami"]);
});

test("isolation: alice reads only alice, cannot pick another mailbox by parameter", async () => {
  assert.equal((await call(tokA, "whoami", { agent: "bob" })).agent, "alice");
  const a = await call(tokA, "list_my_messages", { agent: "bob", inbox: "inbox-bob" });
  assert.deepEqual(a.messages.map((m) => m.text), ["for alice 1", "for alice 2"]);
  const b = await call(tokB, "list_my_messages", {});
  assert.deepEqual(b.messages.map((m) => m.text), ["SECRET for bob"]);
  const s = await call(tokA, "list_my_messages", { since: "2026-11-11T01:00:00Z" });
  assert.deepEqual(s.messages.map((m) => m.text), ["for alice 2"]);
});

test("send goes to caller's outbox only, newlines flattened", async () => {
  await call(tokA, "send_message", { text: "ack hi\nthere", outbox: "outbox-bob" });
  assert.match(fs.readFileSync(path.join(mail, "outbox-alice.log"), "utf8"), /Z ack hi there\n$/);
  assert.equal(fs.existsSync(path.join(mail, "outbox-bob.log")), false);
});

test("REST fallback uses the same identity", async () => {
  const r = await fetch(`${BASE}/api/messages`, { headers: { authorization: `Bearer ${tokB}` } });
  assert.deepEqual((await r.json()).messages.map((m) => m.text), ["SECRET for bob"]);
  const s = await fetch(`${BASE}/api/send`, { method: "POST", headers: { authorization: `Bearer ${tokB}`, "content-type": "application/json" }, body: JSON.stringify({ text: "done x" }) });
  assert.equal(s.status, 200);
  assert.match(fs.readFileSync(path.join(mail, "outbox-bob.log"), "utf8"), /done x/);
});

test("OAuth: DCR + PKCE + one-time connect code binds to that agent; refresh rotates", async () => {
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  const reg = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "test", token_endpoint_auth_method: "none" }) })).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = { response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", state: "s1" };
  const code = cli("connect-code", "bob");
  const bad = await fetch(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ ...q, connect_code: "00000000" }), redirect: "manual" });
  assert.equal(bad.status, 200); // form shown again
  const ok = await fetch(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ ...q, connect_code: code }), redirect: "manual" });
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get("location"));
  assert.equal(loc.searchParams.get("state"), "s1");
  const reuse = await fetch(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ ...q, connect_code: code }), redirect: "manual" });
  assert.equal(reuse.status, 200, "connect code is one-time");
  const tokForm = { grant_type: "authorization_code", code: loc.searchParams.get("code"), redirect_uri: q.redirect_uri, client_id: reg.client_id };
  const wrongPkce = await fetch(`${BASE}/token`, { method: "POST", body: new URLSearchParams({ ...tokForm, code_verifier: "nope" }) });
  assert.equal(wrongPkce.status, 400);
  // code was consumed by the failed attempt: get a fresh one
  const code2 = cli("connect-code", "bob");
  const ok2 = await fetch(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ ...q, connect_code: code2 }), redirect: "manual" });
  const t = await (await fetch(`${BASE}/token`, { method: "POST", body: new URLSearchParams({ ...tokForm, code: new URL(ok2.headers.get("location")).searchParams.get("code"), code_verifier: verifier }) })).json();
  assert.equal((await call(t.access_token, "whoami", {})).agent, "bob");
  assert.equal((await mcp(t.refresh_token, "tools/list")).status, 401, "refresh token is not an access token");
  const t2 = await (await fetch(`${BASE}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id }) })).json();
  assert.ok(t2.access_token);
  const again = await fetch(`${BASE}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id }) });
  assert.equal(again.status, 400, "old refresh token rotated out");
});

test("revoke kills static tokens", async () => {
  cli("revoke", "alice");
  assert.equal((await mcp(tokA, "tools/list")).status, 401);
});
