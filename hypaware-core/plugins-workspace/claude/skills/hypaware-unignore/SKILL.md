---
name: hypaware-unignore
description: Re-enable HypAware recording for the current Claude session after a previous /hypaware-ignore. Use when the user says "resume recording", "unignore this session", or otherwise asks to opt this conversation back into the local HypAware AI gateway recording.
---

# Re-enable recording for this Claude session

Cancel an earlier `/hypaware-ignore` so subsequent Claude requests in this session are recorded again. Does not retroactively recover requests that were dropped while the session was opted out — those are gone for good.

## What to run

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  echo "error: CLAUDE_CODE_SESSION_ID is not set; cannot resume recording" >&2
  exit 1
fi

BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:8787}"
URL="${BASE%/}/_hypaware/ignore/session"

curl --fail-with-body --silent --show-error \
  -X DELETE "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"session_id":"%s"}' "$CLAUDE_CODE_SESSION_ID")" \
  > /dev/null

printf 'Recording re-enabled for session %s\n' "$CLAUDE_CODE_SESSION_ID"
```

## Notes

- Only the *temporary, in-memory* opt-out is reversed. Recording stays suppressed if the working directory is covered by a `.hypignore` ancestor file. Remove those by deleting the marker file.
- The CLI is idempotent: it returns success even when the session was not currently ignored.
