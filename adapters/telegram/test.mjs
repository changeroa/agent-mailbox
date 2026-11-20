// node --test adapters/telegram/test.mjs  -- pure parsing tests, no Telegram connection
import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxLine, parseOutbox, chunks } from "./bridge.mjs";

const ctx = { allowed: new Set(["111"]), pairCode: "abc123" };
const from = { id: 111, first_name: "Alice" };

test("dm from an allowed user becomes one inbox line with a reply address", () => {
  const m = { message_id: 7, from, chat: { id: 111, type: "private" }, text: "hi\nthere" };
  assert.equal(inboxLine(m, ctx), "[telegram dm] from=Alice(111) ch=111 msg=7 reply=telegram:111 | hi \\n there");
});

test("group chat ids keep their minus sign", () => {
  const m = { message_id: 1, from, chat: { id: -100123, type: "supergroup" }, text: "x" };
  assert.match(inboxLine(m, ctx), /^\[telegram group\] .* reply=telegram:-100123 \| x$/);
});

test("strangers, bots and plain /start are ignored", () => {
  assert.equal(inboxLine({ message_id: 1, from: { id: 222 }, chat: { id: 222, type: "private" }, text: "hi" }, ctx), null);
  assert.equal(inboxLine({ message_id: 1, from: { id: 222 }, chat: { id: 222, type: "private" }, text: "/start wrong" }, ctx), null);
  assert.equal(inboxLine({ message_id: 1, from: { id: 111, is_bot: true }, chat: { id: 1, type: "private" }, text: "x" }, ctx), null);
  assert.equal(inboxLine({ message_id: 1, from, chat: { id: 111, type: "private" }, text: "/start" }, ctx), null);
});

test("the pairing code lets a new user join, only when a code is set", () => {
  const m = { message_id: 1, from: { id: 222 }, chat: { id: 222, type: "private" }, text: "/start abc123" };
  assert.deepEqual(inboxLine(m, ctx), { kind: "pair", uid: "222", chat: 222 });
  assert.equal(inboxLine(m, { ...ctx, pairCode: "" }), null);
});

test("outbox lines: only telegram-addressed ones are sent, \\n becomes a newline", () => {
  assert.deepEqual(parseOutbox("2026-11-20T00:00:00Z telegram:-100123 done a\\nb"), { chat_id: "-100123", text: "done a\nb" });
  assert.equal(parseOutbox("2026-11-20T00:00:00Z slack:C1/1.2 x"), null);
  assert.equal(parseOutbox("2026-11-20T00:00:00Z ack plain"), null);
});

test("long messages are split under the Telegram limit", () => {
  assert.deepEqual(chunks("a".repeat(9000)).map((c) => c.length), [4000, 4000, 1000]);
});
