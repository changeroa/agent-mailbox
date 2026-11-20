# Telegram adapter

Connects one Telegram bot to one agent's mailbox pair, so allowed people can talk to a mailbox agent from Telegram.

- A message to the bot from a user in the allow list becomes one line in `INBOX`:
  `[telegram dm] from=NAME(USERID) ch=CHATID msg=ID reply=telegram:CHATID | text` (`[telegram group]` in groups).
- The agent answers by writing `telegram:CHATID <body>` to its outbox (for example with `send_message`). The adapter tails `OUTBOX_LOG` and sends the body to that chat; `\n` becomes a newline. Other outbox lines are left alone.
- Everyone not in the allow list is ignored. Allowed users come from `ALLOWED_USER_IDS` plus `STATE_DIR/allowed.json`. If `PAIR_CODE` is set, a user who sends `/start PAIR_CODE` (or opens `https://t.me/BOTNAME?start=PAIR_CODE`) is added once; unset it after pairing.

## Setup

1. Create a bot with @BotFather (`/newbot`) and copy the token -> `TELEGRAM_BOT_TOKEN`.
2. `cp adapters/telegram/example.env ~/agent-mailbox/telegram-NAME.env && chmod 600 ~/agent-mailbox/telegram-NAME.env`, fill it in.
3. `cp systemd/agent-telegram-bridge@.service ~/.config/systemd/user/ && systemctl --user enable --now agent-telegram-bridge@NAME`

Long polling (`getUpdates`), so no webhook or inbound port is needed. Run several bots by adding more env files and instances.

## Test

`node --test adapters/telegram/test.mjs` (parsing only; no Telegram connection).
