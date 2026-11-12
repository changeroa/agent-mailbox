#!/usr/bin/env python3
"""Wake an agent by email whenever its inbox log gets a new line.

Some hosted agents cannot keep a long-running process (so they cannot sit on
`hc events`), but they react to email sent to their own address. This script
tails one inbox log and sends one short email per new line.

Environment:
  WAKE_LOG        inbox log to watch, e.g. ~/mailbox/inbox-foo.log (required)
  WAKE_TO         the agent's email address (required)
  WAKE_SMTP_FILE  file with two lines: SMTP user, SMTP password (default ~/mailbox/.smtp, chmod 600)
  WAKE_SMTP_HOST  default smtp.gmail.com
  WAKE_SMTP_PORT  default 587 (STARTTLS)
  WAKE_INBOX_NAME mailbox name shown in the mail body (default: log file name without .log)

Note: it starts at the end of the file, so lines written while this service was
down are not announced. The agent should still read its whole inbox with
`since=<last ts it saw>` when it wakes.
"""
import os, smtplib, time
from email.message import EmailMessage

LOG = os.path.expanduser(os.environ["WAKE_LOG"])
TO = os.environ["WAKE_TO"]
SMTP_FILE = os.path.expanduser(os.environ.get("WAKE_SMTP_FILE", "~/mailbox/.smtp"))
HOST = os.environ.get("WAKE_SMTP_HOST", "smtp.gmail.com")
PORT = int(os.environ.get("WAKE_SMTP_PORT", "587"))
NAME = os.environ.get("WAKE_INBOX_NAME") or os.path.basename(LOG).removesuffix(".log")
OUTBOX = NAME.replace("inbox", "outbox", 1)

user, pw = open(SMTP_FILE).read().split("\n")[:2]


def send(line):
    m = EmailMessage()
    m["From"] = user
    m["To"] = TO
    m["Subject"] = "[agent mailbox] new message"
    m.set_content(
        f"New line in mailbox '{NAME}':\n\n{line}\n\n"
        f"Read with: list_my_messages (MCP) or hc read {NAME}\n"
        f"Reply with: send_message / hc send {OUTBOX} \"ack ...\" then \"done ...\""
    )
    for _ in range(3):
        try:
            with smtplib.SMTP(HOST, PORT, timeout=30) as s:
                s.starttls()
                s.login(user, pw)
                s.send_message(m)
            print("sent", line[:60], flush=True)
            return
        except Exception as e:
            print("retry", type(e).__name__, flush=True)
            time.sleep(10)
    print("gave up", line[:60], flush=True)


open(LOG, "a").close()
with open(LOG) as f:
    f.seek(0, 2)
    while True:
        line = f.readline()
        if not line:
            time.sleep(2)
            continue
        line = line.strip()
        if line:
            send(line)
