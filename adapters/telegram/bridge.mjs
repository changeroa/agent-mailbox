// Telegram adapter: one Telegram bot (long polling, no webhook) <-> one agent's mailbox pair.
// Messages from allowed users become one line in INBOX; lines in OUTBOX_LOG of the form
// "<ts> telegram:<chat_id> <body>" are sent back to that chat.
// Node >= 22, no dependencies. Env: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS (comma-separated user ids),
// optional PAIR_CODE (lets one more user join by sending "/start <code>"), INBOX, OUTBOX_LOG, STATE_DIR, HC.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const oneLine = (s) => String(s || "").replace(/\r?\n/g, " \\n ").replace(/\s+/g, " ").trim();

// Returns { kind: "pair" } for a valid pairing "/start <code>" from a new user, an inbox line for a
// message from an allowed user, or null when the message is not for us.
export function inboxLine(m, { allowed, pairCode }) {
  if (!m?.from || m.from.is_bot || !m.chat) return null;
  const uid = String(m.from.id), chat = m.chat.id;
  const text = m.text ?? m.caption ?? "";
  if (!allowed.has(uid)) {
    const arg = text.match(/^\/start(?:@\S+)?\s+(\S+)/)?.[1];
    return pairCode && arg === pairCode ? { kind: "pair", uid, chat } : null;
  }
  if (/^\/start\b/.test(text)) return null;
  const kind = m.chat.type === "private" ? "dm" : "group";
  const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || uid;
  const extra = !m.text && !m.caption ? " [non-text message]" : "";
  return `[telegram ${kind}] from=${who}(${uid}) ch=${chat} msg=${m.message_id} reply=telegram:${chat} | ${oneLine(text)}${extra}`;
}

const OUT_RE = /^\S+\s+telegram:(-?\d+)\s+([\s\S]+)$/;
// Returns { chat_id, text } for an outbox line addressed to Telegram, else null.
export function parseOutbox(line) {
  const m = String(line).match(OUT_RE);
  return m ? { chat_id: m[1], text: m[2].replace(/\\n/g, "\n") } : null;
}

// Telegram caps a message at 4096 characters.
export const chunks = (text, n = 4000) => Array.from({ length: Math.ceil(text.length / n) || 1 }, (_, i) => text.slice(i * n, (i + 1) * n));

async function main() {
  const HOME = process.env.HOME;
  const HC = process.env.HC || path.join(HOME, ".local/bin/herdr-core");
  const INBOX = process.env.INBOX || "inbox-telegram";
  const OUTBOX_LOG = process.env.OUTBOX_LOG || path.join(HOME, "mailbox/outbox-telegram.log");
  const STATE_DIR = process.env.STATE_DIR || path.join(HOME, ".local/state/agent-telegram-bridge", INBOX);
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN, PAIR = process.env.PAIR_CODE || "";
  if (!TOKEN) { console.error("missing TELEGRAM_BOT_TOKEN"); process.exit(2); }
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const ALLOW_FILE = path.join(STATE_DIR, "allowed.json"), STATE_FILE = path.join(STATE_DIR, "state.json");
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
  const allowed = new Set([...(process.env.ALLOWED_USER_IDS || "").split(","), ...readJson(ALLOW_FILE, [])].map((s) => String(s).trim()).filter(Boolean));
  const state = readJson(STATE_FILE, { offset: 0 });

  async function tg(method, body = {}) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.error_code} ${j.description}`);
    return j.result;
  }
  const toInbox = (line) => new Promise((res, rej) =>
    execFile(HC, ["send", INBOX, line], { timeout: 20000 }, (e) => (e ? rej(e) : res())));

  async function onMessage(m) {
    const r = inboxLine(m, { allowed, pairCode: PAIR });
    if (r === null) { if (m?.from) log("ignored", m.from.id); return; }
    if (typeof r === "object") {
      allowed.add(r.uid); writeJson(ALLOW_FILE, [...allowed]);
      log("paired user", r.uid);
      await tg("sendMessage", { chat_id: r.chat, text: "Connected." });
      return;
    }
    await toInbox(r);
    log("inbox <-", `${m.chat.id}/${m.message_id}`);
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
        try { for (const text of chunks(m.text)) await tg("sendMessage", { chat_id: m.chat_id, text }); log("send ->", m.chat_id); }
        catch (e) { log("send error", m.chat_id, e.message); }
      }
    } finally { reading = false; }
  }

  const me = await tg("getMe");
  log("bot", "@" + me.username, "allowed", allowed.size, "outbox", OUTBOX_LOG, "offset", offset);
  setInterval(() => readOutbox().catch((e) => log("outbox error", e.message)), 1000);
  for (;;) {
    try {
      const ups = await tg("getUpdates", { offset: state.offset, timeout: 50, allowed_updates: ["message"] });
      for (const u of ups) {
        state.offset = u.update_id + 1;
        await onMessage(u.message).catch((e) => log("message error", e.message));
      }
      if (ups.length) writeJson(STATE_FILE, state);
    } catch (e) { log("poll error", e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
