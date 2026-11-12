// herdr agent mailbox MCP server. Node >= 22, no dependencies.
// Exposes only: whoami, list_my_messages, send_message. Agent identity comes from the credential.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const HOME = process.env.HOME;
const STATE = process.env.MBX_STATE || path.join(HOME, "mailbox-mcp/state.json");
const MAILDIR = process.env.MBX_MAILDIR || path.join(HOME, "mailbox");
const HC = process.env.MBX_HC || path.join(HOME, ".local/bin/herdr-core");
const BASE = (process.env.MBX_BASE || "http://127.0.0.1:8787").replace(/\/$/, ""); // set MBX_BASE to your public https origin
const PORT = Number(process.env.MBX_PORT || 8787);
const ACCESS_TTL = 24 * 3600, REFRESH_TTL = 90 * 24 * 3600, CODE_TTL = 600, CONNECT_TTL = 24 * 3600;
const MAX_TEXT = 4000;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rand = (n = 32) => crypto.randomBytes(n).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function load() {
  if (!fs.existsSync(STATE)) return { agents: {}, tokens: {}, clients: {}, connect: {}, codes: {} };
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  for (const k of ["agents", "tokens", "clients", "connect", "codes"]) s[k] ||= {};
  return s;
}
let st = load();
function save() {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}
function sweep() {
  const t = now();
  for (const k of ["tokens", "connect", "codes"]) for (const [h, v] of Object.entries(st[k])) if (v.exp && v.exp < t) delete st[k][h];
}

// ---------- admin CLI ----------
const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd && cmd !== "serve") {
  if (cmd === "add-agent") { // add-agent NAME INBOX OUTBOX
    st.agents[a1] = { inbox: a2, outbox: a3 }; save(); console.log(`agent ${a1}: ${a2} / ${a3}`);
  } else if (cmd === "issue-token") { // static bearer; raw printed once
    if (!st.agents[a1]) throw new Error("unknown agent");
    const raw = "mbx_" + rand(); st.tokens[sha(raw)] = { agent: a1, kind: "static", created: now() }; save(); console.log(raw);
  } else if (cmd === "connect-code") { // one-time OAuth consent code the owner types
    if (!st.agents[a1]) throw new Error("unknown agent");
    const raw = crypto.randomInt(0, 1e8).toString().padStart(8, "0");
    st.connect[sha(raw)] = { agent: a1, exp: now() + CONNECT_TTL }; save(); console.log(raw);
  } else if (cmd === "revoke") { // revoke AGENT: all tokens of the agent
    for (const [h, v] of Object.entries(st.tokens)) if (v.agent === a1) delete st.tokens[h]; save(); console.log("revoked", a1);
  } else if (cmd === "list") {
    const c = {}; for (const v of Object.values(st.tokens)) c[v.agent + "/" + v.kind] = (c[v.agent + "/" + v.kind] || 0) + 1;
    console.log(JSON.stringify({ agents: st.agents, tokens: c, clients: Object.keys(st.clients).length }, null, 1));
  } else { console.error("usage: serve | add-agent N IN OUT | issue-token N | connect-code N | revoke N | list"); process.exit(2); }
  process.exit(0);
}

// ---------- mailbox ops ----------
function agentOf(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (!m) return null;
  const t = st.tokens[sha(m[1])];
  if (!t || (t.kind !== "static" && t.kind !== "access") || (t.exp && t.exp < now())) return null;
  return st.agents[t.agent] ? t.agent : null;
}
function readBox(agent, since, limit = 50) {
  const file = path.join(MAILDIR, st.agents[agent].inbox + ".log");
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^(\S+Z) (.*)$/.exec(line);
    if (!m) continue;
    if (since && !(m[1] > since)) continue;
    out.push({ ts: m[1], text: m[2] });
  }
  return out.slice(-Math.min(Math.max(1, limit | 0), 200));
}
function sendBox(agent, text) {
  const clean = String(text ?? "").replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!clean) return Promise.reject(new Error("text is empty"));
  if (clean.length > MAX_TEXT) return Promise.reject(new Error(`text longer than ${MAX_TEXT} chars`));
  return new Promise((res, rej) =>
    execFile(HC, ["send", st.agents[agent].outbox, clean], { timeout: 20000 }, (e) => (e ? rej(new Error("mailbox write failed")) : res(clean))));
}

// ---------- MCP ----------
const TOOLS = [
  { name: "whoami", description: "Return which agent mailbox this credential belongs to.", inputSchema: { type: "object", properties: {} } },
  { name: "list_my_messages", description: "Read instructions sent to you (your inbox). Each item has an ISO UTC ts. Pass since=<last ts you saw> to get only newer ones.",
    inputSchema: { type: "object", properties: { since: { type: "string", description: "ISO UTC timestamp, e.g. 2026-11-11T04:25:34Z" }, limit: { type: "integer", minimum: 1, maximum: 200 } } } },
  { name: "send_message", description: "Send one line to the owner's agent (your outbox). Start with 'ack <summary>' when you receive work and 'done <result>' when finished.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: MAX_TEXT } }, required: ["text"] } },
];
async function callTool(agent, name, args = {}) {
  if (name === "whoami") return { agent, inbox: st.agents[agent].inbox, outbox: st.agents[agent].outbox };
  if (name === "list_my_messages") return { messages: readBox(agent, args.since, args.limit ?? 50) };
  if (name === "send_message") return { sent: await sendBox(agent, args.text) };
  throw Object.assign(new Error("unknown tool"), { rpc: -32602 });
}
async function rpc(agent, msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return ok({ protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(params?.protocolVersion) ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: "herdr-agent-mailbox", version: "1.0.0" },
      instructions: "Your mailbox. list_my_messages to read instructions, send_message to reply (ack first, done at the end)." });
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method === "tools/call") {
    try {
      const r = await callTool(agent, params?.name, params?.arguments || {});
      return ok({ content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r, isError: false });
    } catch (e) {
      if (e.rpc) return { jsonrpc: "2.0", id, error: { code: e.rpc, message: e.message } };
      return ok({ content: [{ type: "text", text: e.message }], isError: true });
    }
  }
  if (id === undefined) return null; // notification
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
}

// ---------- HTTP helpers ----------
function body(req) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > 65536) { rej(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}
function send(res, code, obj, headers = {}) {
  const b = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "content-type": typeof obj === "string" ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store",
    "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
    "access-control-expose-headers": "mcp-session-id, www-authenticate", ...headers });
  res.end(b);
}
const unauth = (res) => send(res, 401, { error: "invalid_token" },
  { "www-authenticate": `Bearer realm="mailbox", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"` });
const parseForm = (s) => Object.fromEntries(new URLSearchParams(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function asMeta() {
  return { issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"], scopes_supported: ["mailbox"] };
}
function authorizePage(q, err) {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource", "response_type"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join("");
  const name = st.clients[q.client_id]?.client_name || q.client_id;
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Mailbox connect</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h2>Connect an agent mailbox</h2><p><b>${esc(name)}</b> wants to read and write one agent mailbox.</p>
<p>Enter the 8-digit connect code the owner gave you. The code decides which mailbox this app gets.</p>
${err ? `<p style="color:#b00">${esc(err)}</p>` : ""}
<form method="post" action="/authorize">${hidden}<input name="connect_code" inputmode="numeric" autocomplete="one-time-code" style="font-size:24px;width:100%" required>
<p><button style="font-size:18px">Approve</button></p></form></body>`;
}
function issuePair(agent, clientId) {
  const access = "mbxa_" + rand(), refresh = "mbxr_" + rand();
  st.tokens[sha(access)] = { agent, kind: "access", client: clientId, exp: now() + ACCESS_TTL };
  st.tokens[sha(refresh)] = { agent, kind: "refresh", client: clientId, exp: now() + REFRESH_TTL };
  save();
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "mailbox" };
}
function clientAuth(req, f) {
  let id = f.client_id, secret = f.client_secret;
  const b = /^Basic\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (b) { const [u, p] = Buffer.from(b[1], "base64").toString().split(":"); id = decodeURIComponent(u); secret = decodeURIComponent(p ?? ""); }
  const c = st.clients[id];
  if (!c) return null;
  if (c.secret_hash && sha(secret || "") !== c.secret_hash) return null;
  return id;
}

// ---------- router ----------
async function handle(req, res) {
  const u = new URL(req.url, BASE);
  const p = u.pathname;
  if (req.method === "OPTIONS") return send(res, 204, "");
  st = load(); // admin CLI edits the file while we run
  sweep();

  if (p === "/healthz") return send(res, 200, { ok: true });
  if (p.startsWith("/.well-known/oauth-protected-resource"))
    return send(res, 200, { resource: `${BASE}/mcp`, authorization_servers: [BASE], bearer_methods_supported: ["header"], scopes_supported: ["mailbox"] });
  if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) return send(res, 200, asMeta());

  if (p === "/register" && req.method === "POST") {
    let m; try { m = JSON.parse((await body(req)) || "{}"); } catch { return send(res, 400, { error: "invalid_client_metadata" }); }
    const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.filter((x) => typeof x === "string") : [];
    if (!uris.length || uris.some((x) => !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(x)))
      return send(res, 400, { error: "invalid_redirect_uri" });
    if (Object.keys(st.clients).length > 500) return send(res, 400, { error: "too_many_clients" });
    const id = "mbxc_" + rand(12);
    const method = m.token_endpoint_auth_method || "none";
    const secret = method === "none" ? null : rand();
    st.clients[id] = { redirect_uris: uris, client_name: String(m.client_name || "").slice(0, 80), auth: method, secret_hash: secret ? sha(secret) : null, created: now() };
    save();
    return send(res, 201, { client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: now(),
      redirect_uris: uris, client_name: st.clients[id].client_name, token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  }

  if (p === "/authorize") {
    const q = req.method === "POST" ? parseForm(await body(req)) : Object.fromEntries(u.searchParams);
    const c = st.clients[q.client_id];
    if (!c || !c.redirect_uris.includes(q.redirect_uri)) return send(res, 400, "<p>Unknown client or redirect_uri.</p>");
    if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) return send(res, 400, "<p>PKCE S256 code flow required.</p>");
    if (req.method !== "POST") return send(res, 200, authorizePage(q));
    const key = sha(String(q.connect_code || "").trim());
    const cc = st.connect[key];
    if (!cc) return send(res, 200, authorizePage(q, "Wrong or expired code."));
    delete st.connect[key]; // one-time
    const code = rand();
    st.codes[sha(code)] = { agent: cc.agent, client: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, exp: now() + CODE_TTL };
    save();
    const to = new URL(q.redirect_uri); to.searchParams.set("code", code); if (q.state) to.searchParams.set("state", q.state);
    res.writeHead(302, { location: to.toString(), "cache-control": "no-store" }); return res.end();
  }

  if (p === "/token" && req.method === "POST") {
    const raw = await body(req);
    const f = (req.headers["content-type"] || "").includes("json") ? JSON.parse(raw || "{}") : parseForm(raw);
    const cid = clientAuth(req, f);
    if (!cid) return send(res, 401, { error: "invalid_client" });
    if (f.grant_type === "authorization_code") {
      const k = sha(f.code || ""); const c = st.codes[k];
      if (!c || c.client !== cid || c.redirect_uri !== f.redirect_uri) return send(res, 400, { error: "invalid_grant" });
      delete st.codes[k];
      const ch = crypto.createHash("sha256").update(f.code_verifier || "").digest("base64url");
      if (ch !== c.challenge) { save(); return send(res, 400, { error: "invalid_grant", error_description: "PKCE" }); }
      return send(res, 200, issuePair(c.agent, cid));
    }
    if (f.grant_type === "refresh_token") {
      const k = sha(f.refresh_token || ""); const t = st.tokens[k];
      if (!t || t.kind !== "refresh" || t.client !== cid) return send(res, 400, { error: "invalid_grant" });
      delete st.tokens[k]; // rotate
      return send(res, 200, issuePair(t.agent, cid));
    }
    return send(res, 400, { error: "unsupported_grant_type" });
  }

  if (p === "/mcp" || p === "/mcp/") {
    if (req.method === "GET") return send(res, 405, { error: "SSE stream not offered; use POST" }, { allow: "POST, DELETE" });
    if (req.method === "DELETE") return send(res, 200, {});
    if (req.method !== "POST") return send(res, 405, { error: "method" });
    const agent = agentOf(req);
    if (!agent) return unauth(res);
    let msg; try { msg = JSON.parse(await body(req)); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const sid = req.headers["mcp-session-id"] || rand(12);
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => rpc(agent, m)))).filter(Boolean);
      return out.length ? send(res, 200, out, { "mcp-session-id": sid }) : send(res, 202, "", { "mcp-session-id": sid });
    }
    const out = await rpc(agent, msg);
    return out ? send(res, 200, out, { "mcp-session-id": sid }) : send(res, 202, "", { "mcp-session-id": sid });
  }

  // plain REST for agents that cannot speak MCP but can do HTTPS
  if (p === "/api/whoami" || p === "/api/messages" || p === "/api/send") {
    const agent = agentOf(req);
    if (!agent) return unauth(res);
    try {
      if (p === "/api/whoami") return send(res, 200, await callTool(agent, "whoami"));
      if (p === "/api/messages") return send(res, 200, await callTool(agent, "list_my_messages", { since: u.searchParams.get("since") || undefined, limit: Number(u.searchParams.get("limit") || 50) }));
      if (req.method !== "POST") return send(res, 405, { error: "POST" });
      const raw = await body(req);
      const text = (req.headers["content-type"] || "").includes("json") ? JSON.parse(raw || "{}").text : raw;
      return send(res, 200, await callTool(agent, "send_message", { text }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  send(res, 404, { error: "not found" });
}

http.createServer((req, res) => handle(req, res).catch((e) => { try { send(res, 500, { error: "server error" }); } catch {} console.error("err", req.method, new URL(req.url, BASE).pathname, e.message); }))
  .listen(PORT, process.env.MBX_HOST || "127.0.0.1", () => console.log(`mailbox mcp on ${PORT} base ${BASE}`));
