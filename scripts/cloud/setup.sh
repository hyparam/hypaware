#!/bin/bash
# HypAware capture for Claude Code cloud sessions. Paste into the cloud
# environment's "Setup script"; see README.md. Never exits non-zero, since a
# failing setup script would stop the session from starting.
npm i -g --no-audit --no-fund hypaware@1.42.0 && { [ -f "$HOME/.hyp/hypaware-config.json" ] ||
  hyp setup --client claude --export keep-local --no-daemon --no-backfill; } || exit 0

# Session-start hook. Joins central once (the environment's variables reach
# sessions, not this script), drops a pid file a rebuilt VM left naming a pid
# that is no longer a hyp daemon, and relaunches the daemon on exit 75.
H=$HOME/.hyp/cloud-session-start.sh
mkdir -p "$HOME/.hyp" && cat > "$H" <<'EOF'
#!/bin/bash
[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0
cd "$HOME/.hyp" && exec >>cloud-daemon.log 2>&1 </dev/null
echo "$(date -u +%FT%TZ) session start"
[ -f hypaware/config-control/seed.json ] || [ -z "$HYP_JOIN_TOKEN" ] ||
  printf %s "$HYP_JOIN_TOKEN" | hyp join https://api.hypaware.ai --no-daemon
P=hypaware/run/hypaware.pid
pid=$(grep -o '"pid": *[0-9]*' $P 2>/dev/null | grep -o '[0-9]*$')
[ -n "$pid" ] && ! tr '\0' ' ' 2>/dev/null </proc/$pid/cmdline | grep -q 'daemon run' &&
  rm $P && echo "removed stale pid file (pid $pid)"
nohup setsid bash -c 'rc=75; while [ $rc = 75 ]; do hyp daemon run; rc=$?; done' &
EOF
# Stop hook (after each reply). With HYP_UPLOAD_DELAY=<seconds>, uploads that
# long after the last reply: an idle VM pauses about 5 minutes after it, with
# no signal first. One waiter at a time; a newer reply restarts its wait.
U=$HOME/.hyp/upload-after-reply.sh
cat > "$U" <<'EOF'
#!/bin/bash
case ${HYP_UPLOAD_DELAY:-off} in off|*[!0-9]*) exit 0 ;; esac
cd "$HOME/.hyp" && exec >>cloud-daemon.log 2>&1 </dev/null
date +%s > upload-after
nohup setsid flock -n upload.lock bash -c 'while :; do
  s=$(cat upload-after); t=$((s + HYP_UPLOAD_DELAY - $(date +%s)))
  [ $t -gt 0 ] && sleep $t
  [ "$(cat upload-after)" = "$s" ] || continue
  echo "$(date -u +%FT%TZ) upload after reply"; hyp backfill claude; hyp sync --yes
  [ "$(cat upload-after)" = "$s" ] && break
done' &
EOF
chmod +x "$H" "$U"
node -e 'const f = process.env.HOME + "/.claude/settings.json", s = require(f), [, start, stop] = process.argv
for (const [event, c] of [["SessionStart", start], ["Stop", stop]]) {
  const h = (s.hooks ??= {})[event] ??= []
  if (!JSON.stringify(h).includes(c)) h.unshift({ hooks: [{ type: "command", command: c }] })
}
require("fs").writeFileSync(f, JSON.stringify(s, null, 2) + "\n")' "$H" "$U"
exit 0
