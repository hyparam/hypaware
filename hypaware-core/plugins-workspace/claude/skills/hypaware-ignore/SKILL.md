---
name: hypaware-ignore
description: Stop HypAware from recording the current Claude session. Use when the user says "don't record this", "ignore this session", "pause logging", or otherwise asks to opt this conversation out of the local HypAware AI gateway recording. Effect lasts for the lifetime of the session and is reversible with /hypaware-unignore.
---

# Stop recording this Claude session

When invoked, immediately tell the local HypAware AI gateway to drop every request from this session before it is written to the cache. Recording stays disabled until the Claude session ends or `/hypaware-unignore` is invoked.

## What to run

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  echo "error: CLAUDE_CODE_SESSION_ID is not set; cannot opt out" >&2
  exit 1
fi

BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:8787}"
URL="${BASE%/}/_hypaware/ignore/session"

response="$(curl --fail-with-body --silent --show-error \
  -X POST "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"session_id":"%s"}' "$CLAUDE_CODE_SESSION_ID")")"

total="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')"
printf 'Ignored session %s. Total ignored: %s\n' "$CLAUDE_CODE_SESSION_ID" "$total"
```

## Notes

- The opt-out is held in-memory by the running AI gateway. A gateway restart drops the entry; if a long-running gateway is restarted mid-session, re-run `/hypaware-ignore`.
- This only affects the *current* Claude session. Concurrent sessions in the same working directory continue to record unless covered by a `.hypignore` file.
- For committable / team-wide opt-out, drop an empty `.hypignore` file at the top of the repo instead.
- Reverse with `/hypaware-unignore`.
