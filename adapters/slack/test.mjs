// node --test adapters/slack/test.mjs  -- pure parsing tests, no Slack connection
import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxLine, parseOutbox } from "./bridge.mjs";

const ctx = { selfId: "UBOT", selfBot: "BBOT", label: "helper", who: "alice" };

test("mention becomes one inbox line with a reply address", () => {
  const ev = { type: "app_mention", user: "U1", channel: "C1", ts: "1.2", text: "<@UBOT> hi\nthere" };
  assert.equal(inboxLine(ev, ctx), "[slack mention] from=alice(U1) ch=C1 thread=1.2 reply=slack:C1/1.2 | @helper hi \\n there");
});

test("dm in a thread keeps the thread ts", () => {
  const ev = { type: "message", channel_type: "im", user: "U1", channel: "D1", ts: "5.6", thread_ts: "1.2", text: "x" };
  assert.match(inboxLine(ev, ctx), /^\[slack dm\] .* reply=slack:D1\/1\.2 \| x$/);
});

test("own posts, edits and plain channel messages are ignored", () => {
  assert.equal(inboxLine({ type: "app_mention", user: "UBOT", channel: "C", ts: "1.1" }, ctx), null);
  assert.equal(inboxLine({ type: "app_mention", bot_id: "BBOT", channel: "C", ts: "1.1" }, ctx), null);
  assert.equal(inboxLine({ type: "message", channel_type: "im", subtype: "message_changed", user: "U1", ts: "1.1" }, ctx), null);
  assert.equal(inboxLine({ type: "message", channel_type: "channel", user: "U1", ts: "1.1" }, ctx), null);
});

test("other bots mentioning us are delivered", () => {
  const ev = { type: "app_mention", subtype: "bot_message", bot_id: "BOTHER", channel: "C1", ts: "1.2", text: "ping" };
  assert.ok(inboxLine(ev, { ...ctx, who: "otherbot" }));
});

test("outbox lines: only slack-addressed ones are posted, \\n becomes a newline", () => {
  assert.deepEqual(parseOutbox("2026-11-19T00:00:00Z slack:C1/1.2 done a\\nb"), { channel: "C1", thread_ts: "1.2", text: "done a\nb" });
  assert.equal(parseOutbox("2026-11-19T00:00:00Z ack plain message"), null);
});
