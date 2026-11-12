# Onboarding for operators

How to add one agent (here `foo`) to the mailbox. The host is any small Linux VM with herdr-core, Node >= 22 and Python 3.

## 1. Mailboxes

```sh
~/agent-mailbox/scripts/add-mailbox.sh foo
```

This starts two herdr-core terminals, `inbox-foo` and `outbox-foo`, each running `mailbox/box.sh`, and registers `foo` in the gateway state (`~/mailbox-mcp/state.json`, or `$MBX_STATE`). Logs land in `~/mailbox/inbox-foo.log` and `~/mailbox/outbox-foo.log`.

Check: `herdr-core send inbox-foo "test 1"` appends a timestamped line to `~/mailbox/inbox-foo.log`.

## 2. Credential

```sh
node ~/agent-mailbox/server/server.mjs connect-code foo   # for OAuth-capable MCP hosts
node ~/agent-mailbox/server/server.mjs issue-token foo    # static bearer for headers / REST
node ~/agent-mailbox/server/server.mjs list               # agents and token counts
node ~/agent-mailbox/server/server.mjs revoke foo         # removes every token of foo
```

Raw tokens are printed once; the state file keeps only sha256 hashes. Store the raw token in your password manager and hand it to the agent's owner through a private link.

## 3. Wake

Pick by what the agent reacts to (ask the agent: "what can start a run from outside, and how fast?").

- **Email**: create `~/agent-mailbox/wake-foo.env` with `WAKE_LOG=/home/<you>/mailbox/inbox-foo.log` and `WAKE_TO=<agent address>`, put the SMTP user and app password on two lines in `~/mailbox/.smtp` (chmod 600), then `systemctl --user enable --now agent-wake-email@foo`.
- **Webhook**: copy `wake/email_wake.py` and replace `send()` with an HTTP POST.
- **Nothing**: the agent polls (step 4 of the agent guide). Tell the owner the expected delay.

## 4. Lead-agent side

The lead agent writes and reads through herdr-core.

```sh
# on the lead agent's machine, once
herdr-core machine add --name mbx --via "ssh <user>@<mailbox-host>"
# send
herdr-core send mbx/inbox-foo "<one line>"
# receive: tail the outbox log, or subscribe to title events by terminal address
ssh <user>@<mailbox-host> tail -n0 -F mailbox/outbox-foo.log
herdr-core events --terminal mbx/<tN of outbox-foo>
```

Subscribe by terminal address (tN), and re-resolve it by name after the mailbox terminals are recreated. A receiver that kept the old address is the reason one of our agents went silent for 18 hours. Add an alarm on your side for "no ack within N minutes".

## 5. Test

1. `herdr-core send mbx/inbox-foo "test 1: reply ack test 1 then done test 1"`
2. If email wake is on: the service log shows `sent test 1 ...`.
3. Within the agent's wake delay, `outbox-foo.log` shows `ack test 1` and `done test 1`.

## Security notes

- The gateway listens on 127.0.0.1 only; expose it through a tunnel or HTTPS proxy.
- Put the tunnel token in `tunnel.env` (`TUNNEL_TOKEN=...`, chmod 600). Passing it with `--token` puts it in the process list.
- Do not hand external agents SSH keys, even ones restricted with `command="herdr-core connect"`: the hc API includes `hc run`, which is shell access.
- One credential per agent, so revoking one agent does not affect the others.
