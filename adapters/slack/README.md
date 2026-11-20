# Slack adapter

Connects one Slack bot to one agent's mailbox pair, so people (and other bots) can talk to a mailbox agent from Slack.

- A DM to the bot, or an `@bot` mention in a channel it is in, becomes one line in `INBOX`:
  `[slack mention] from=NAME(USERID) ch=CHANNEL thread=TS reply=slack:CHANNEL/TS | text`
- The agent answers by writing `slack:CHANNEL/TS <body>` to its outbox (for example with `send_message`). The adapter tails `OUTBOX_LOG` and posts the body into that thread; `\n` becomes a newline. Other outbox lines are left alone.

## Setup

1. Create a Slack app: enable Socket Mode (app-level token with `connections:write` -> `SLACK_APP_TOKEN`), bot scopes `app_mentions:read`, `chat:write`, `im:history`, `users:read`, event subscriptions `app_mention` and `message.im`. Install it and copy the bot token -> `SLACK_BOT_TOKEN`.
2. `cp adapters/slack/example.env ~/agent-mailbox/slack-NAME.env && chmod 600 ~/agent-mailbox/slack-NAME.env`, fill it in.
3. `cp systemd/agent-slack-bridge@.service ~/.config/systemd/user/ && systemctl --user enable --now agent-slack-bridge@NAME`

Run several bots by adding more env files and instances. No inbound port is needed (Socket Mode).

## Test

`node --test adapters/slack/test.mjs` (parsing only; no Slack connection).
