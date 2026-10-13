#!/bin/bash
# HypAware capture for Claude Code cloud sessions.
#
# Paste into the cloud environment's "Setup script" field. It runs as root
# before Claude Code starts, and the result is snapshotted, so it runs once
# per environment cache (about weekly), not once per session.
#
# Optional environment variables (set them on the environment):
#   HYP_CENTRAL_URL  central server to join; omit for local-only capture
#   HYP_JOIN_TOKEN   join token for HYP_CENTRAL_URL
# The join happens in the session-start hook, not here: the environment's
# variables are confirmed visible to sessions, and a join here was not seen
# to take effect.
#
# A setup script that exits non-zero stops the session from starting, so
# every failure here logs and exits 0: capture is lost, the session is not.
set -u
HYP_VERSION=1.42.0

log() { echo "hypaware-cloud: $*"; }

npm install -g --no-audit --no-fund "hypaware@${HYP_VERSION}" \
  || { log "npm install failed; capture disabled"; exit 0; }

# Local config with Claude attached: writes the OTEL env and HypAware's
# session-context hooks into ~/.claude/settings.json. No daemon install:
# the VM has no running systemd, so the daemon is started per session below.
hyp setup --client claude --export keep-local --no-daemon --no-backfill \
  || { log "hyp setup failed; capture disabled"; exit 0; }

# Processes do not survive the snapshot, so a SessionStart hook starts the
# daemon in every session (including resumed ones). `hyp daemon run` exits
# on its own when one is already running. Silent on purpose: SessionStart
# stdout is added to Claude's context.
START="$HOME/.hyp/cloud-session-start.sh"
mkdir -p "$HOME/.hyp"
cat > "$START" <<'EOF'
#!/bin/bash
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
LOG="$HOME/.hyp/cloud-daemon.log"
PIDFILE="$HOME/.hyp/hypaware/run/hypaware.pid"
# A rebuilt VM keeps the previous daemon's pid file but restarts pid
# numbering, so the old pid can now belong to an unrelated process and
# `hyp daemon run` would refuse to start. Keep the file only while its pid
# is a hyp daemon.
pid=$(sed -n 's/^ *"pid": *\([0-9]*\).*/\1/p' "$PIDFILE" 2>/dev/null)
if [ -n "$pid" ] && ! { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null | grep -q 'daemon run'; then
  rm -f "$PIDFILE"
  echo "$(date -u +%FT%TZ) removed stale pid file (pid $pid)" >>"$LOG"
fi
# Join a central server once, when the environment supplies one. The seed
# file `hyp join` writes is kept across sessions, so later starts skip this.
SEED="$HOME/.hyp/hypaware/config-control/seed.json"
if [ ! -f "$SEED" ] && [ -n "${HYP_CENTRAL_URL:-}" ] && [ -n "${HYP_JOIN_TOKEN:-}" ]; then
  if printf %s "$HYP_JOIN_TOKEN" | hyp join "$HYP_CENTRAL_URL" --no-daemon >>"$LOG" 2>&1; then
    echo "$(date -u +%FT%TZ) joined $HYP_CENTRAL_URL" >>"$LOG"
  else
    echo "$(date -u +%FT%TZ) hyp join failed; capturing locally only" >>"$LOG"
  fi
fi
echo "$(date -u +%FT%TZ) session start" >>"$LOG"
# Exit 75 is the daemon asking to be relaunched (new central config, a
# config change, a self-update); any other exit ends the loop.
nohup setsid bash -c 'rc=75; while [ "$rc" -eq 75 ]; do hyp daemon run; rc=$?; done' \
  >>"$LOG" 2>&1 </dev/null &
exit 0
EOF
chmod +x "$START"

# Register it next to the hooks attach wrote, once.
START="$START" node -e '
const fs = require("fs")
const file = process.env.HOME + "/.claude/settings.json"
const s = JSON.parse(fs.readFileSync(file, "utf8"))
const list = ((s.hooks ??= {}).SessionStart ??= [])
const cmd = process.env.START
if (!JSON.stringify(list).includes(cmd)) {
  list.unshift({ hooks: [{ type: "command", command: cmd }] })
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n")
}
' || log "could not register the SessionStart hook"

log "ready (hypaware ${HYP_VERSION})"
exit 0
