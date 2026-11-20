// Slack adapter: one Slack bot (Socket Mode) <-> one agent's mailbox pair.
// Incoming DMs and @mentions become one line in INBOX; lines in OUTBOX_LOG of the form
// "<ts> slack:<channel>/<thread_ts> <body>" are posted back into that Slack thread.
// Node >= 22, no dependencies. Env: SLACK_APP_TOKEN (xapp-), SLACK_BOT_TOKEN (xoxb-),
// optional INBOX, OUTBOX_LOG, BOT_LABEL, HC.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const oneLine = (s) => String(s || "").replace(/\r?\n/g, " \\n ").replace(/\s+/g, " ").trim();

// Returns the inbox line for a Slack event, or null when the event is not for us.
export function inboxLine(ev, { selfId, selfBot, label, who }) {
  if (!ev || ev.user === selfId || (ev.bot_id && ev.bot_id === selfBot)) return null;
  if (ev.subtype && ev.subtype !== "bot_message" && ev.subtype !== "thread_broadcast") return null;
  const isMention = ev.type === "app_mention";
  const isDm = ev.type === "message" && ev.channel_type === "im";
  if (!isMention && !isDm) return null;
  const thread = ev.thread_ts || ev.ts;
  const text = oneLine(String(ev.text || "").replaceAll(`<@${selfId}>`, `@${label}`));
  return `[slack ${isDm ? "dm" : "mention"}] from=${who}(${ev.user}) ch=${ev.channel} thread=${thread} reply=slack:${ev.channel}/${thread} | ${text}`;
}

const OUT_RE = /^\S+\s+slack:([A-Z0-9]+)\/(\d+\.\d+)\s+([\s\S]+)$/;
// Returns { channel, thread_ts, text } for an outbox line addressed to Slack, else null.
export function parseOutbox(line) {
  const m = String(line).match(OUT_RE);
  return m ? { channel: m[1], thread_ts: m[2], text: m[3].replace(/\\n/g, "\n") } : null;
}

async function main() {
  const HOME = process.env.HOME;
  const HC = process.env.HC || path.join(HOME, ".local/bin/herdr-core");
  const INBOX = process.env.INBOX || "inbox-slack";
  const OUTBOX_LOG = process.env.OUTBOX_LOG || path.join(HOME, "mailbox/outbox-slack.log");
  const BOT_LABEL = process.env.BOT_LABEL || "bot";
  const APP = process.env.SLACK_APP_TOKEN, BOT = process.env.SLACK_BOT_TOKEN;
  if (!APP || !BOT) { console.error("missing SLACK_APP_TOKEN / SLACK_BOT_TOKEN"); process.exit(2); }
  const log = (...a) => console.log(new Date().toISOString(), ...a);

  async function slack(method, body, token = BOT) {
    const r = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      // form encoding: read methods like users.info ignore JSON bodies
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(body || {}),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.error}`);
    return j;
  }

  const names = new Map();
  async function userName(id) {
    if (names.has(id)) return names.get(id);
    try {
      const u = (await slack("users.info", { user: id })).user;
      const n = u.profile?.display_name || u.real_name || u.name || id;
      names.set(id, n);
      return n;
    } catch { return id; }
  }
  const toInbox = (line) => new Promise((res, rej) =>
    execFile(HC, ["send", INBOX, line], { timeout: 20000 }, (e) => (e ? rej(e) : res())));

  const { user_id: selfId, bot_id: selfBot } = await slack("auth.test");
  const seen = new Set();
  async function onEvent(ev) {
    if (!ev) return;
    const key = `${ev.channel}/${ev.ts}`;
    if (seen.has(key)) return;
    const who = ev.user ? await userName(ev.user) : ev.username || ev.bot_profile?.name || ev.bot_id;
    const line = inboxLine(ev, { selfId, selfBot, label: BOT_LABEL, who });
    if (!line) return;
    seen.add(key);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    await toInbox(line);
    log("inbox <-", key);
  }

  let offset = fs.existsSync(OUTBOX_LOG) ? fs.statSync(OUTBOX_LOG).size : 0;
  let partial = "", reading = false;
  async function readOutbox() {
    if (reading) return;
    reading = true;
    try {
      const size = fs.existsSync(OUTBOX_LOG) ? fs.statSync(OUTBOX_LOG).size : 0;
      if (size < offset) offset = 0;
      if (size === offset) return;
      const fd = fs.openSync(OUTBOX_LOG, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      const lines = (partial + buf.toString("utf8")).split("\n");
      partial = lines.pop();
      for (const l of lines) {
        const m = parseOutbox(l);
        if (!m) continue;
        try { await slack("chat.postMessage", m); log("post ->", `${m.channel}/${m.thread_ts}`); }
        catch (e) { log("post error", `${m.channel}/${m.thread_ts}`, e.message); }
      }
    } finally { reading = false; }
  }

  log("bot", selfId, "outbox", OUTBOX_LOG, "offset", offset);
  setInterval(() => readOutbox().catch((e) => log("outbox error", e.message)), 1000);
  for (;;) {
    try {
      const { url } = await slack("apps.connections.open", {}, APP);
      await new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.onopen = () => log("socket open");
        ws.onmessage = (m) => {
          let msg; try { msg = JSON.parse(m.data); } catch { return; }
          if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
          if (msg.type === "disconnect") { log("socket disconnect", msg.reason); ws.close(); return; }
          if (msg.type === "events_api") onEvent(msg.payload?.event).catch((e) => log("event error", e.message));
        };
        ws.onclose = () => { log("socket closed"); resolve(); };
        ws.onerror = () => {};
      });
    } catch (e) { log("connect error", e.message); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
