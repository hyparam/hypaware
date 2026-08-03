---
name: hypaware-ignore
description: Stop HypAware from recording the current Claude session. Use when the user says "don't record this", "ignore this session", "pause logging", or otherwise asks to opt this conversation out of the local HypAware AI gateway recording. Effect lasts for the lifetime of the session and is reversible with /hypaware-unignore.
---

# Stop recording this Claude session

<!-- @ref LLP 0142#user-invoked-only [constrained-by]: stays model-invocable on purpose; LLP 0066 is written around the spoken "don't record this conversation", so a slash-only affordance would lose the discovery the spec exists to serve -->


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

# Check the reply before believing it, the same three ways `hyp session ignore`
# does: `ignored` a real boolean true, `total` a real number, and `session_id`
# echoed back byte-for-byte. The route echoes the token verbatim, so a reply
# about a different session establishes nothing about this one - and reaching
# *something* on that port is not the same as reaching the gateway.
total="$(printf '%s' "$response" | python3 -c '
import json, sys
expected = sys.argv[1]
try:
    r = json.load(sys.stdin)
except Exception:
    sys.exit("opt-out NOT confirmed: the reply was not JSON, so it is not the control route")
# bool is excluded because isinstance(True, int) is True in Python: the CLI
# check this mirrors is `typeof total !== "number"`, which a JSON true fails.
if not isinstance(r, dict) or r.get("ignored") is not True or isinstance(r.get("total"), bool) or not isinstance(r.get("total"), int):
    sys.exit("opt-out NOT confirmed: " + json.dumps(r))
if r.get("session_id") != expected:
    sys.exit("opt-out NOT confirmed: the reply is about session %s, not %s" % (json.dumps(r.get("session_id")), json.dumps(expected)))
print(r["total"])
' "$CLAUDE_CODE_SESSION_ID")"
printf 'Ignored session %s. Total ignored: %s\n' "$CLAUDE_CODE_SESSION_ID" "$total"
```

If that check fails, say the session is **still being recorded**; do not report a partial success.

## Notes

- **What the confirmation proves.** `ignored: true` means the id is in the gateway's in-memory drop set, and nothing more. The gateway holds the id as an opaque token and never inspects traffic, so it cannot confirm the id is one this session's exchanges carry; the match happens later, in the client adapter, against the `session_id` it stamps on the row. For Claude the session *is* the conversation and `CLAUDE_CODE_SESSION_ID` is that same id, which is what makes the opt-out real - the reply is a receipt for the write, not a verified drop.
- The opt-out is held in-memory by the running AI gateway. A gateway restart drops the entry; if a long-running gateway is restarted mid-session, re-run `/hypaware-ignore`.
- This only affects the *current* Claude session. Concurrent sessions in the same working directory continue to record unless covered by a `.hypignore` file.
- For committable / team-wide opt-out, drop an empty `.hypignore` file at the top of the repo instead.
- Reverse with `/hypaware-unignore`.
