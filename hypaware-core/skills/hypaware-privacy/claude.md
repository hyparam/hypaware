# Claude session protection

Use this reference only when the current client is Claude.

## Step 1 - Protect this session first (R3)

The review conversation will discuss the most sensitive content on the machine, so it must never itself become a captured, forwardable transcript. **Before surveying anything**, opt this Claude session out of capture and **verify it took effect**. On failure, say so plainly and continue **only** with the user's explicit consent.

Prefer `hyp session ignore --json`, which resolves the id and verifies the opt-out in one tested implementation and refuses rather than guessing. It resolves this session's id from `CLAUDE_CODE_SESSION_ID`, addresses **every** recorder advertising the control route, validates each reply the same three ways, and fails closed: it exits nonzero and prints no success when it cannot establish the right id, which is the answer this step needs. Only where it is unavailable (`command not found`) does the script below apply. A `hyp` that ran and refused is not a fallback: with `CLAUDE_CODE_SESSION_ID` unset the script exits before it posts anything, and the one id-resolution refusal that happens with it set (a second client stating one too) goes to the stated-id re-run below, not here.

Reading the receipt is not optional. The verb fails closed on the questions it can answer, but two of its **successes** are narrower than they look, and both are checked below.

```bash
hyp session ignore --json
```

**Why the verb and not a `curl`.** Claude Code attaches over OTEL, so this session is recorded by the `@hypaware/claude` telemetry listener, whose ignored-session set is a **different object on a different port** from the gateway's. The verb addresses each recorder that advertises `control_routes` in live daemon status, plus the gateway by its own resolution; one `curl` reaches one of them, so on the default OTEL attach it can report a confident success over a listener that keeps recording. `"status": "ok"` means every recorder it *addressed* took the write, which is not the same claim as "you are covered". So read the receipt rather than only the exit code:

- exit `0` with `"status": "ok"`. `"status": "partial"` (exit 3) means an addressed recorder **refused and is still recording**.
- `"session_id_source"` is `claude_env`, so `"session_id"` is this conversation's own `CLAUDE_CODE_SESSION_ID`. Any other source means the verb could not read that variable and resolved **a different session** off disk instead (`codex_rollout` / `codex_env_rollout` find a Codex session sharing this directory). It then confirms a real opt-out, `"status": "ok"` and all, for a session you are not in, while this one keeps being recorded. That write already happened. Undo it with `hyp session unignore "<the session_id it reported>"` only if the user confirms they did not opt that session out themselves: the receipt cannot say whether the write added that session or found it already opted out, and an undo removes a deliberate opt-out just the same. Otherwise leave it, and tell the user the bystander session stays suppressed until explicitly unignored.
- `"recorders"` contains an entry for `claude-telemetry`, the listener that captures this session. A list holding only `gateway` means the listener was not addressed, and absence has two readings the receipt cannot tell apart: the listener is running and the verb did not reach it, or it is not running at all - a stopped daemon, or an `@hypaware/ai-gateway` too old to give it the record seam, both leave it out of the live snapshot the verb reads. A skipped **live** listener is the exact failure this step exists to prevent; a listener that is not running is recording nothing, so there is nothing about this session to notify. The cross-check below settles which one you have. A `gateway not addressed:` line on **stderr** narrows the answer the same way from the other side.
- every entry in `"recorders"` reports `"status": "ok"` with `"ignored": true`. Name them to the user rather than saying "the machine".
- `"guarantee": "set_membership"` is the bound on all of it, spelled out below.

**Stop on any of these** and tell the user the review session is still being recorded: `"status": "partial"`, a `"session_id_source"` other than `claude_env` (the stated-id re-run just below is the one exception, and reports `argument`), no `claude-telemetry` entry in `"recorders"` while the cross-check below says that listener is live, or a nonzero exit the fallback does not cover. Only proceed if they explicitly accept that risk.

**Cross-check a missing `claude-telemetry` entry before you stop on it.** The receipt reports who was addressed, which is one observation and cannot say which of the two readings above it is reporting. `hyp status --json` is the second one, and the stop is conditioned on it rather than dropped: it reads a different field of the same daemon snapshot - `listener_started_at` rather than the `control_routes` advertisement the verb resolves recorders by - together with the daemon-readability check below, and it reports that only while the daemon process is alive.

```bash
hyp status --json
```

Read the `capture_health` entry whose `"client"` is `claude`. A non-null `"listener_started_at"` is a listener the running daemon started: it is receiving this session's telemetry, it was skipped, and the stop above applies - say the review session is still being recorded. A null `"listener_started_at"`, or no `capture_health` entry for `claude` at all, means no live listener is receiving this session's telemetry only when the same payload's `daemon` object carries no `"error"`, or carries an `"error"` beside `"running": false`: both readings come from one liveness-gated read of the same status snapshot, so a snapshot the command could not read nulls `listener_started_at` for a listener that is in fact still running, and `"running": true` with an `"error"` beside it is exactly that case - it is the live case, so stop. With no `daemon.error`, or an `"error"` beside `"running": false`, read the null as intended: tell the user the listener is not running, so nothing is capturing this session, and read the rest of the receipt as usual (the `gateway` entry still has to report `ok`). Anything you cannot read that way - `hyp status` exiting nonzero, no `capture_health` key, a `daemon` object reporting `"running": true` with an `"error"`, a shape you do not recognise - is not an observation, so treat it as the live case and stop.

**If the verb refuses because more than one client states an id** for this shell (`CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` are both set, so it will not guess which session you are in), do **not** drop to the script below. `hyp` is installed and working here, and its own error names the fix: state the id, which still reaches every recorder.

```bash
hyp session ignore --json "$CLAUDE_CODE_SESSION_ID"
```

Read that receipt exactly as above, with one substitution: `"session_id_source"` is now `argument`, so check `"session_id"` equals `$CLAUDE_CODE_SESSION_ID` byte for byte instead. Every other stop still applies, the `claude-telemetry` one included.

One nonzero exit, and only that one, sends you to the fallback: `hyp` **not installed** (`command not found`). A `hyp` that ran and failed any other way is a stop, not a reason to fall back: either it already posted to the gateway the script is about to post to, or it could not resolve a gateway at all - and in that case the script's default address is a guess (`resolveGatewayEndpointForCli` reads the live daemon port and a pinned `listen`, and deliberately never assumes the default) rather than a route the verb overlooked.

**Fallback, only where `hyp` is unavailable.** The script below posts to the gateway control route directly. It reaches the **gateway alone**: if a telemetry listener is live, this does not cover it, so report an opt-out of the gateway rather than of the machine, and treat that as the failure the top of this step describes - say it plainly and get the user's explicit consent before surveying.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  echo "error: CLAUDE_CODE_SESSION_ID is not set; cannot opt this session out" >&2
  exit 1
fi

# The default is DEFAULT_GATEWAY_ENDPOINT (src/core/config/gateway_endpoint.js),
# which is what an unpinned gateway binds. On a plain OTEL attach there is no
# ANTHROPIC_BASE_URL at all, so this fallback is the whole of the address.
BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:18521}"
URL="${BASE%/}/_hypaware/ignore/session"

response="$(curl --fail-with-body --silent --show-error \
  -X POST "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"session_id":"%s"}' "$CLAUDE_CODE_SESSION_ID")")"

# Verify the gateway accepted the opt-out, and that the reply is about THIS
# session. Same three checks `hyp session ignore` applies (validateControlResponse
# in ai-gateway/src/session_command.js): `ignored` a real boolean true, `total` a
# real number, and `session_id` echoed back byte-for-byte. The route echoes the
# token verbatim, so a reply naming a different session establishes nothing about
# this one, and reaching *something* on the port is not reaching the gateway.
printf '%s' "$response" | python3 -c '
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
print("opt-out confirmed for session %s (total ignored: %s)" % (expected, r["total"]))
# Printed only here, after every check passed, so the bound travels with the
# success line: nothing above authenticates the responder.
print("caveat: the responder on that port is not authenticated, and this is a membership receipt, not proof that recording stopped")
' "$CLAUDE_CODE_SESSION_ID"
```

If the `curl` fails (gateway not running, wrong port) or the verification line does not print `opt-out confirmed`, **stop and tell the user the review session is still being recorded**. Only proceed if they explicitly accept that risk.

**What a confirmed opt-out proves, exactly.** Each recorder holds the id as an opaque token: `ignored: true` means the id is in that recorder's drop set, and nothing more. No recorder inspects traffic, so none can tell you the id is one your exchanges carry - that match happens later, in the client adapter, against the `session_id` it stamps on the row. For Claude the session *is* the conversation and `CLAUDE_CODE_SESSION_ID` is that same id, so sending it is what makes the opt-out real; the reply is a receipt for the write, not a verified drop. Do not report it to the user as more than that, and never treat a follow-up `GET` as extra proof: it is the same set lookup answering the same question. Nor does anything prove the responder on that port is HypAware, so the answer is only as trustworthy as the machine; the `caveat:` line the script prints under `opt-out confirmed` says so, and belongs in what you report.

The opt-out is saved locally and survives recorder and daemon restarts until explicitly removed with `hyp session unignore`. A fork (`claude --fork-session`, `codex fork`) creates a new session ID that needs its own exclusion; a plain resume reuses the ID. Transcript backfill honors the saved exclusion. Unignoring permits earlier transcript content to be imported again. Use `hyp session status` to check the current answer.

## Step 2 - Return to the shared audit

Continue with [Step 2 in the privacy skill](SKILL.md#step-2---check-that-backfill-has-settled-before-surveying).
