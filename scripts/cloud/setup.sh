#!/bin/bash
# HypAware capture for Claude Code cloud sessions. Paste into the cloud
# environment's "Setup script"; see README.md. Never exits non-zero, since a
# failing setup script would stop the session from starting.
npm i -g --no-audit --no-fund hypaware@1.42.0 &&
  hyp setup --client claude --export keep-local --no-daemon --no-backfill || exit 0

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
chmod +x "$H"
node -e 'const f = process.env.HOME + "/.claude/settings.json", s = require(f), c = process.argv[1]
const h = (s.hooks ??= {}).SessionStart ??= []
if (!JSON.stringify(h).includes(c)) h.unshift({ hooks: [{ type: "command", command: c }] })
require("fs").writeFileSync(f, JSON.stringify(s, null, 2) + "\n")' "$H"
exit 0
