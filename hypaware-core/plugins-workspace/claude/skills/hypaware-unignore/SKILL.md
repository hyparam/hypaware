---
name: hypaware-unignore
description: Re-enable HypAware recording for the current Claude session after a previous /hypaware-ignore. Use when the user says "resume recording", "unignore this session", or otherwise asks to opt this conversation back into the local HypAware AI gateway recording.
---

# Re-enable recording for this Claude session

<!-- @ref LLP 0142#user-invoked-only [constrained-by]: stays model-invocable on purpose, as the reverse of hypaware-ignore; see LLP 0066 -->


Cancel an earlier `/hypaware-ignore` so subsequent Claude requests in this session are recorded again. Does not retroactively recover requests that were dropped while the session was opted out; those are gone for good.

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

response="$(curl --fail-with-body --silent --show-error \
  -X DELETE "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"session_id":"%s"}' "$CLAUDE_CODE_SESSION_ID")")"

# Check the reply before believing it, the same three ways `hyp session unignore`
# does (`validateControlResponse` in ai-gateway/src/session_command.js): `ignored`
# a real boolean - `false` here, since removal is what was asked for - `total` a
# real number, and `session_id` echoed back byte-for-byte. The route echoes the
# token verbatim, so a reply about a different session establishes nothing about
# this one, and reaching *something* on that port is not reaching the gateway.
total="$(printf '%s' "$response" | python3 -c '
import json, sys
expected = sys.argv[1]
try:
    r = json.load(sys.stdin)
except Exception:
    sys.exit("removal NOT confirmed: the reply was not JSON, so it is not the control route")
# bool is excluded because isinstance(True, int) is True in Python: the CLI
# check this mirrors is `typeof total !== "number"`, which a JSON true fails.
if not isinstance(r, dict) or r.get("ignored") is not False or isinstance(r.get("total"), bool) or not isinstance(r.get("total"), int):
    sys.exit("removal NOT confirmed: " + json.dumps(r))
if r.get("session_id") != expected:
    sys.exit("removal NOT confirmed: the reply is about session %s, not %s" % (json.dumps(r.get("session_id")), json.dumps(expected)))
print(r["total"])
' "$CLAUDE_CODE_SESSION_ID")"
printf 'Session %s is out of the gateway drop set, so this opt-out suppresses nothing now. Total ignored: %s\n' "$CLAUDE_CODE_SESSION_ID" "$total"
```

If that check fails, do not report the opt-out as lifted; say the gateway did not confirm the removal.

## Notes

- **What the confirmation proves.** `ignored: false` means the id is no longer in the gateway's in-memory drop set, and nothing more. The gateway holds the id as an opaque token and never inspects traffic, so it cannot tell you recording resumed: an id this session's exchanges never carried was suppressing nothing to resume, and a `.hypignore` ancestor is an independent reason the session stays unrecorded. The reply is a receipt for the removal, not a verified resumption.
- Only the *temporary, in-memory* opt-out is reversed. Recording stays suppressed if the working directory is covered by a `.hypignore` ancestor file. Remove those by deleting the marker file.
- The CLI is idempotent: it returns success even when the session was not currently ignored.
