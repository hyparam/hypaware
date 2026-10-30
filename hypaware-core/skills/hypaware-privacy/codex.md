# Codex session protection

Use this reference only when the current client is Codex.

## Step 1 - Protect this session first (R3)

The review conversation will discuss the most sensitive content on the machine, so it must never itself become a captured, forwardable transcript. **Before surveying anything**, opt this Codex session out of capture and **verify it took effect**. On failure, say so plainly and continue **only** with the user's explicit consent.

Prefer `hyp session ignore --json`, which resolves the id and verifies the opt-out in one tested implementation and refuses rather than guessing. It exits nonzero and prints no success when it cannot establish the right id, which is the answer this step needs. Only where it is unavailable, or cannot resolve the session, does the script below apply.

Reading the receipt is not optional. The verb fails closed on the questions it can answer, but two of its **successes** are narrower than they look, and both are checked below.

```bash
hyp session ignore --json
```

**What the receipt does and does not say.** The verb addresses the gateway plus every recorder advertising `control_routes` in live daemon status, so `"status": "ok"` means every recorder it *addressed* took the write, which is not the same claim as "you are covered": a recorder missing from that snapshot is not addressed at all. Which recorder captures this session depends on Codex's `capture_mode`: with `gateway` configured Codex reaches HypAware through `base_url` and the gateway records this session live, while on the default `transcript` mode nothing reaches the gateway and this session's rollout under `~/.codex/sessions` is imported by the scheduled sweep instead. The **gateway** entry is still the one to read either way: its control route saves the id to the shared session-ignore store before it answers, and the sweep reloads that store at the start of every run, so a confirmed `gateway` entry is what covers the live lane and what the transcript import honors. Read the receipt rather than only the exit code:

- exit `0` with `"status": "ok"`. `"status": "partial"` (exit 3) means an addressed recorder **refused and is still recording**.
- `"session_id_source"` is `codex_env_rollout` (the thread `CODEX_THREAD_ID` states, with the session container read out of that thread's rollout) or `codex_rollout` (the container inferred off disk from a `cwd` match). Any other source means the verb resolved **a different session**: `claude_env` means it read `CLAUDE_CODE_SESSION_ID` and opted out a Claude session sharing this shell. It then confirms a real opt-out, `"status": "ok"` and all, for a session you are not in, while this one keeps being recorded. That write already happened. Undo it with `hyp session unignore "<the session_id it reported>"` only if the user confirms they did not opt that session out themselves: the receipt cannot say whether the write added that session or found it already opted out, and an undo removes a deliberate opt-out just the same. Otherwise leave it, and tell the user the bystander session stays suppressed until explicitly unignored.
- on `codex_rollout` the id is **inferred** off disk rather than stated by the client, and `"session_id_evidence"` names the rollout it came from. Report it as "inferred from `<rollout file>`", the same way the script below reports its own, and stop for the user's confirmation if they do not recognize the session.
- `"recorders"` contains an entry for `gateway`, whose control route carries the durable write, which is why it is the entry to read in either capture mode. A list without one means the gateway was never addressed, and absence has two readings the receipt cannot tell apart: the gateway is listening and the verb could not name its endpoint, or it is not listening at all - a stopped daemon, or a gateway that bound no port, leaves nothing in the live snapshot, and with no `listen` pinned in the config there is nothing for the verb to fall back on. Those are two independent facts: a pinned `listen` is addressed even when nothing answers there, and that lands a `gateway` entry reporting `"status": "error"` on a `partial` receipt rather than an absent one, so a missing entry is never by itself evidence the daemon is stopped. A skipped **listening** gateway is the exact failure this step exists to prevent; a gateway that is not listening is capturing nothing over `base_url`, so there is nothing about this session for it to notify. The cross-check below settles which one you have. A `gateway not addressed:` line on **stderr** narrows the answer the same way from the other side.
- every entry in `"recorders"` reports `"status": "ok"` with `"ignored": true`. Name them to the user rather than saying "the machine".
- `"guarantee": "set_membership"` is the bound on all of it, spelled out below.

**Stop on any of these** and tell the user the review session is still being recorded: `"status": "partial"`, a `"session_id_source"` other than `codex_env_rollout` or `codex_rollout`, no `gateway` entry in `"recorders"` while the cross-check below says the gateway is listening, or a nonzero exit the fallback does not cover. Only proceed if they explicitly accept that risk.

**Cross-check a missing `gateway` entry before you stop on it.** The receipt reports who was addressed, which is one observation and cannot say which of the two readings above it is reporting. The daemon's own snapshot is the second one, and the stop is conditioned on it rather than dropped: it carries the gateway source's bound address, the very field the verb resolves the gateway by, where the `"recorders"` list carries only the outcome of that resolution. `hyp status --json` cannot answer this - it renders sources without their `details` - so read the snapshot itself:

```bash
hyp daemon status --json
```

Read `"running"` first, then the `"sources"` entry whose `"plugin"` is `"@hypaware/ai-gateway"` - or, on a snapshot that recorded no plugin for it, whose `"name"` is `"ai-gateway"`, which is the second way core itself finds that source, so a plugin-only lookup can miss a gateway that did bind. `"running": true` beside a gateway entry whose `"details"` carries a `"port"` is a gateway the live daemon bound: this session's traffic reaches it, it was skipped, and the stop above applies - say the review session is still being recorded. `"running": false`, or a running daemon whose gateway entry is missing or reports `"listening": false` with no `"port"`, is the other reading: tell the user the gateway is not listening, so nothing is capturing this session over `base_url`, and read the rest of the receipt as usual (every other entry in `"recorders"` still has to report `ok`). Keep that scoped to the gateway's own lane rather than reporting the session uncaptured outright: Codex's `capture_mode` defaults to `transcript`, where the rollout files under `~/.codex/sessions` are imported by the scheduled sweep and never reach the gateway at all. What that import honors is the shared session-ignore store under the state directory, which only the recorders that persist their set there write to; a recorder holding its set in memory for its own process answers `"status": "ok"` and leaves the sweep nothing to read. The receipt does not say which kind answered, so report the gateway as idle and name the recorders that confirmed, and leave the transcript lane as something this step has not settled rather than telling the user it is covered. The `"running"` half is not optional - a snapshot outlives the daemon that wrote it, so a `"port"` in a file no live process stands behind says nothing about now. Anything you cannot read that way - `hyp daemon status` exiting nonzero, which is what an unreadable snapshot does, or a shape you do not recognize - is not an observation, so treat it as the listening case and stop. A daemon that never wrote a snapshot is not that case: it exits `0` and prints a two-key payload, `"running": false` with `"state": "unknown"` and nothing else, so its missing `"sources"` key is the not-running answer above and not an unreadable shape.

**Which id, exactly.** The gateway matches its opt-out set against the **session container**, not the thread: `codex/src/exchange-projector.js` keys the drop on `metadata.session_id`, falling back to the conversation id. Codex records each session as `~/.codex/sessions/**/rollout-<ts>-<uuid>.jsonl` whose first line is a `session_meta` record carrying `payload.session_id` (the container) alongside `payload.id` (the thread) and `payload.cwd`. **Read `payload.session_id`.** The two are the same uuid on a root thread, and they diverge on a subagent thread, which inherits the root's container but mints its own thread id, so an opt-out sent with the thread id names a token the drop never matches. Nothing downstream catches that: the control route treats the id as opaque and answers `ignored: true` for whatever it was handed, so the verification below would print `opt-out confirmed` over a session that is still being recorded. A rollout with no `session_id` predates the container, so stop there rather than substituting the thread id (issue #453).

Codex also states the running thread's id in the environment of the shells it spawns, as `CODEX_THREAD_ID`. It is a **thread** id, so it is not the answer this step needs and the script below deliberately does not send it. `hyp session ignore` already puts it to its real use, as a *selector*: it looks the rollout up by `payload.id`, then reads the container out of `payload.session_id` and reports the id as `codex_env_rollout` - stated thread, read container. Codex injects the variable into this script's environment too, so the script could select on it as well; it does not, because the container still has to be read out of the rollout either way, and the verb already does that lookup in one tested implementation. What the script must never do is *send* the variable, which is why it resolves by cwd below.

**Do not pick the newest rollout by mtime.** Newest-by-mtime is precisely the heuristic that resolves a session the user is not in: it answers confidently off a *finished* session, and marking or purging against a wrong id touches another session's rows while this one keeps being recorded. Which rollout is this session's must instead be established by

- matching `payload.cwd` against the invocation directory,
- **refusing rather than guessing** when zero, or more than one, rollout matches (a header with no `payload.id` still counts toward that), and
- **refusing on staleness**: a live session appends to its rollout on every turn, so a single match last written more than ~30 minutes ago is a finished session, not this one.

Every id this script can produce is therefore inferred from disk, and the staleness window is a bound, not a proof: a session that ended a minute ago still resolves inside it. So say **"inferred from `<rollout file>`"** when you report the id, and stop for the user's confirmation if they do not recognize the session.

```bash
#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

# Establish which rollout is THIS session by matching payload.cwd, then read the
# session CONTAINER out of it. Refuse on ambiguity, staleness, or a rollout too
# old to record a container, rather than resolve a session the user is not in.
resolved="$(python3 - "$CODEX_HOME/sessions" "$PWD" <<'PY'
import json, os, sys, time

root, cwd = sys.argv[1], sys.argv[2]
matches = []
for dirpath, _dirs, names in os.walk(root):
    for name in names:
        if not (name.startswith('rollout-') and name.endswith('.jsonl')):
            continue
        full = os.path.join(dirpath, name)
        try:
            with open(full, encoding='utf-8') as fh:
                record = json.loads(fh.readline())
        except Exception:
            continue
        # Mirrors `readRolloutMeta` in the CLI: only a `session_meta` first
        # record states the container, so a differently-typed one says nothing
        # about it and cannot stand in for a match.
        if not isinstance(record, dict) or record.get('type') != 'session_meta':
            continue
        payload = record.get('payload')
        if not isinstance(payload, dict):
            continue
        # A header with no thread id still counts: it is one more session
        # recording this cwd, so dropping it before the count would let the
        # other one resolve as unambiguous. Same rule as the CLI's cwd scan.
        if payload.get('cwd') != cwd:
            continue
        matches.append((payload.get('session_id'), payload.get('id'), full,
                        time.time() - os.stat(full).st_mtime))

if not matches:
    sys.exit('no Codex rollout under %s records cwd %s' % (root, cwd))
if len(matches) > 1:
    sys.exit('%d rollouts record cwd %s (%s): ambiguous, confirm the session id with the user'
             % (len(matches), cwd, ', '.join('%s (%s)' % (m[0] or m[1] or 'no thread id',
                                                          os.path.basename(m[2])) for m in matches)))
session_id, thread_id, full, age = matches[0]
# Every session_meta Codex writes carries payload.id, so a header without one
# cannot be vouched for, and nothing else it states is evidence of this session.
if not thread_id:
    sys.exit('the only rollout recording cwd %s (%s) states no thread id (payload.id), so it '
             'cannot be vouched for; confirm the session id with the user' % (cwd, os.path.basename(full)))
if age > 30 * 60:
    sys.exit('the only rollout recording cwd %s was last written %dm ago, so it is a FINISHED '
             'session rather than this one' % (cwd, age // 60))
# payload.session_id is the container the gateway drops on. Absent, this Codex
# predates it; the thread id is NOT a substitute, so stop rather than send one.
if not session_id:
    sys.exit('%s records no payload.session_id, so this Codex predates the session container; '
             'its thread id %s is not what the gateway matches, so resolve the session id '
             'another way rather than sending it' % (os.path.basename(full), thread_id))
# A present-but-unusable container is as unresolvable as an absent one, and the
# `read` below would split an id containing whitespace, so refuse rather than
# POSTing a truncated key - the same wrong-key-reported-as-success failure this
# step exists to stop.
if not isinstance(session_id, str) or session_id.split() != [session_id]:
    sys.exit('%s records an unusable payload.session_id (non-string, or carrying whitespace this '
             'script cannot post byte-exactly); use `hyp session ignore --json`, which keeps the '
             'token verbatim' % os.path.basename(full))
print(session_id, os.path.basename(full))
PY
)"
read -r SESSION_ID ROLLOUT <<<"$resolved"
ID_SOURCE="INFERRED from $ROLLOUT on disk"
echo "resolved session $SESSION_ID ($ID_SOURCE)"
# The id is inferred, so if the user does not recognize that session, STOP and
# confirm it with them before opting anything out.

# Resolve the local gateway base: prefer OPENAI_BASE_URL, else the base_url the
# codex adapter wrote under [model_providers.hypaware] in config.toml, else the
# default port. Strip the `/v1` (or `/backend-api/codex`) API suffix.
BASE="${OPENAI_BASE_URL:-}"
if [ -z "$BASE" ]; then
  # `|| true`: under `set -e -o pipefail` a config.toml that is missing, or has
  # no [model_providers.hypaware] base_url, makes this pipeline exit nonzero and
  # would abort the script here - silently, since grep's stderr is discarded -
  # before the default below is ever reached.
  BASE="$(grep -A6 '^\[model_providers.hypaware\]' "$CODEX_HOME/config.toml" 2>/dev/null \
    | grep -m1 'base_url' | sed -E 's/.*"([^"]+)".*/\1/' || true)"
fi
BASE="${BASE:-http://127.0.0.1:18521}"
BASE="${BASE%/v1}"; BASE="${BASE%/backend-api/codex}"; BASE="${BASE%/}"
URL="${BASE}/_hypaware/ignore/session"

response="$(curl --fail-with-body --silent --show-error \
  -X POST "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"session_id":"%s"}' "$SESSION_ID")")"

# Verify the gateway accepted the opt-out, and that the reply is about THIS
# session. Same three checks `hyp session ignore` applies (validateControlResponse
# in ai-gateway/src/session_command.js): `ignored` a real boolean true, `total` a
# real number, and `session_id` echoed back byte-for-byte. The route echoes the
# token verbatim, so a reply naming a different session establishes nothing about
# this one, and reaching *something* on the port is not reaching the gateway.
#
# Note the bound of all three: the control route holds the id as an opaque token,
# so a true here proves the id is in the drop set, not that it is the id this
# session's exchanges carry. That is why the id above is established from the
# rollout's container rather than guessed.
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
' "$SESSION_ID"
```

If the session id cannot be resolved (the script refuses on ambiguity, staleness, or a missing container by design), the `curl` fails, or the verification line does not print `opt-out confirmed`, **stop and tell the user the review session may still be recorded**. Only proceed if they explicitly accept that risk.

**What `opt-out confirmed` proves, exactly.** `ignored: true` means the id is in the gateway's drop set, and nothing more. The gateway never inspects traffic, so it cannot tell a live session container from a thread id or a finished session's id: it answers `ignored: true` for whatever it was handed. The drop happens later, in the client adapter, against the `session_id` it stamps on the row. Everything that makes this opt-out real therefore happened *before* the POST, in resolving `payload.session_id` above - the reply is a receipt for the write, not a verified drop. Report it to the user that way, and never treat a follow-up `GET` as extra proof: it is the same set lookup answering the same question. Nor does anything prove the responder on that port is HypAware, so the answer is only as trustworthy as the machine; the `caveat:` line the script prints under `opt-out confirmed` says so, and belongs in what you report.

The opt-out is saved locally and survives recorder and daemon restarts until explicitly removed with `hyp session unignore`. A fork (`claude --fork-session`, `codex fork`) creates a new session ID that needs its own exclusion; a plain resume reuses the ID. Transcript backfill honors the saved exclusion. Unignoring permits earlier transcript content to be imported again. Use `hyp session status` to check the current answer.

## Step 2 - Return to the shared audit

Continue with [Step 2 in the privacy skill](SKILL.md#step-2---check-that-backfill-has-settled-before-surveying).
