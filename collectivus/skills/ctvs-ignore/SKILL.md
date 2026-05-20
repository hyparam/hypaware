---
name: ctvs-ignore
description: Stop Collectivus from recording the current Claude session. Use when the user says "don't record this", "ignore this session", "pause logging", or otherwise asks to opt this conversation out of the local Collectivus proxy recording. Effect lasts for the lifetime of the session and is reversible with /ctvs-unignore.
---

# Stop recording this Claude session

When invoked, immediately tell the local Collectivus proxy to drop every request from this session before it is written to JSONL. Recording stays disabled until the Claude session ends or `/ctvs-unignore` is invoked.

## What to run

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  echo "error: CLAUDE_CODE_SESSION_ID is not set; cannot opt out" >&2
  exit 1
fi

BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:8787}"
URL="${BASE%/}/_collectivus/ignore/session"

# `--fail-with-body` makes curl exit non-zero on >=400 while still printing the
# response body so the user sees the daemon's error message verbatim.
response="$(curl --fail-with-body --silent --show-error \
  -X POST "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"session_id":"%s"}' "$CLAUDE_CODE_SESSION_ID")")"

total="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')"
printf 'Ignored session %s. Total ignored: %s\n' "$CLAUDE_CODE_SESSION_ID" "$total"
```

## Notes

- The opt-out is held in-memory by the running proxy daemon. A daemon restart drops the entry; if a long-running proxy is restarted mid-session, re-run `/ctvs-ignore`.
- This only affects the *current* Claude session. Concurrent sessions in the same working directory continue to record unless their `cwd` is covered by `ctvs ignore add <path>` or a `.ctvsignore` file.
- For committable / team-wide opt-out, drop an empty `.ctvsignore` file at the top of the repo instead.
- Reverse with `/ctvs-unignore`.
