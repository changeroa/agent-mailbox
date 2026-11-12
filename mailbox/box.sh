#!/usr/bin/env bash
# usage: box.sh NAME  -- reads lines, logs them with a timestamp, echoes them back.
# Each message also sets the terminal title to "msg <n> <ts>", so "hc events" emits a
# title event per message (hc events reports facts, not output).
name=$1; dir=${MAILBOX_DIR:-$HOME/mailbox}; mkdir -p "$dir"; log=$dir/$name.log
n=$( [ -f "$log" ] && wc -l < "$log" || echo 0 ); n=$((n+0))
printf '\033]0;%s ready %s\007' "$name" "$n"
echo "[$name] ready. each line typed here is a message; history: $log"
while IFS= read -r line; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); n=$((n+1))
  printf '%s %s\n' "$ts" "$line" >> "$log"
  printf '\033]0;msg %s %s\007%s %s\n' "$n" "$ts" "$ts" "$line"
done
