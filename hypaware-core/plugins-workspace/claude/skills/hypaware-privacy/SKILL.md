---
name: hypaware-privacy
description: Audit what HypAware has captured from Claude/Codex sessions on this machine and act on it: survey the recorded directories, sample them for secrets, credentials, and personal content, mark directories (ignore / local-only / sync), and purge sensitive rows. Runs any time. Use when the user says "privacy review", "did I record anything sensitive", "scan my logs for secrets", "what should I hypignore", or wants to see what was captured here. It is also the standard review before an enrolled machine's first fleet sync: use after `hyp remote login` prints a first-sync deadline, or when the user says "review before sync" or "what will ship to the server". Covers this machine's local cache only, not rows already forwarded to a remote server.
---

# HypAware privacy review: audit what was captured, decide what leaves

<!-- @ref LLP 0100#skill [implements]: the six-step agent-assisted privacy review the deferred first sync directs the user to run (R3-R8) -->
<!-- @ref LLP 0142#any-time [constrained-by]: the description advertises the audit itself, not the first-sync window; enrolled-ness gates behavior, not presence (LLP 0107#gating) -->
<!-- @ref LLP 0142#local-cache-scope [constrained-by]: this machine's cache only; scanning an org server's rows is deliberately out of scope, not an oversight -->
<!-- @ref LLP 0197#t2-premise-corrected [constrained-by]: the claude and codex copies of this skill are deliberately forked, not drifted. Step 1 resolves the session id by mechanisms only that host has, and the codex copy's version is separately tested (test/plugins/codex-privacy-skill-session-id.test.js). Mirror an edit to the other copy only where it is genuinely host-agnostic; test/plugins/skill-host-parity.test.js records the divergence. -->

This skill surveys what HypAware has captured on this machine, explains the choices in plain language, and applies the user's decisions through `hyp` verbs. The six steps run the same way whenever the user asks; only the stakes change.

The one moment they are time-critical is enrollment. When `hyp remote login` enrolls this machine, the first sync to the org server is **held until a printed deadline** rather than run immediately, and the whole captured history (backfill included) ships at that deadline unless you refine it first. Doing nothing is a valid choice there - at the deadline everything forwards, which is the documented default. On a machine that was never enrolled there is no pending export at all, and the same steps simply bound what gets recorded and what stays in the local cache.

Run the six steps below **in order**. Steps 4 and 5 (explain, then confirm) gate every marking: never mark or purge without first explaining the classes and getting per-item confirmation.

## Scope honesty (say this up front)

This flow governs **HypAware's own surfaces only** - what the local cache holds and what the sink forwards. It is not a data-loss-prevention system. Content a user pasted into a synced session, or anything outside HypAware's capture, is out of scope. Be honest that `ignore`/`local-only`/`purge` bound HypAware, not the user's whole machine.

## Step 1 - Protect this session first (R3)

The review conversation will discuss the most sensitive content on the machine, so it must never itself become a captured, forwardable transcript. **Before surveying anything**, opt this Claude session out of capture and **verify it took effect**. On failure, say so plainly and continue **only** with the user's explicit consent.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  echo "error: CLAUDE_CODE_SESSION_ID is not set; cannot opt this session out" >&2
  exit 1
fi

BASE="${ANTHROPIC_BASE_URL:-http://127.0.0.1:8787}"
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
' "$CLAUDE_CODE_SESSION_ID"
```

If the `curl` fails (gateway not running, wrong port) or the verification line does not print `opt-out confirmed`, **stop and tell the user the review session is still being recorded**. Only proceed if they explicitly accept that risk.

**What `opt-out confirmed` proves, exactly.** The gateway holds the id as an opaque token: `ignored: true` means the id is in its drop set, and nothing more. It never inspects traffic, so it cannot tell you the id is one your exchanges carry - that match happens later, in the client adapter, against the `session_id` it stamps on the row. For Claude the session *is* the conversation and `CLAUDE_CODE_SESSION_ID` is that same id, so sending it is what makes the opt-out real; the reply is a receipt for the write, not a verified drop. Do not report it to the user as more than that, and never treat a follow-up `GET` as extra proof: it is the same set lookup answering the same question.

The opt-out is held in memory by the running gateway and keyed on that one session id, so two things drop it: a **gateway restart**, and a **new session id** minted under what the user experiences as the same conversation (`claude --fork-session`; a plain `--resume` / `--continue` reuses the id). If the review spans either, re-run this step. `hyp session status` reports the current answer for the session you are in at any point. Reverse later with `/hypaware-unignore`.

## Step 2 - Check that backfill has settled (before surveying)

The picker this skill replaces failed because it surveyed a cache the backfill was still filling and presented a partial list as the whole truth. Do not repeat that. Confirm capture has settled before you survey.

```bash
hyp status --json          # daemon running? enrolled (a central sink present)?
hyp query status           # cache state and last refresh
```

Then run the enumeration query (Step 3) **twice, a short interval apart** (say ~30-60s). If the per-directory `rows` counts are still climbing, backfill is still landing: **warn the user and offer to wait** until counts stabilize before proposing any markings. Surveying mid-backfill risks marking against an incomplete picture. There is no deadline pressure here: on an enrolled machine the first-sync hold gives hours, and on an unenrolled one nothing is waiting to leave. Note that an enrolled user can also end that window early at any time with `hyp sync` (it prints what would leave and asks first), so if they say they are in a hurry, finishing the review is what unblocks them, not waiting.

## Step 3 - Survey the captured directories, then sample content (R4 applies)

Enumerate the distinct working directories this machine has captured (the LLP 0069 enumerate query over `ai_gateway_messages`):

```bash
hyp query sql "SELECT cwd, repo_root, COUNT(*) AS rows, MAX(date) AS last_seen \
FROM ai_gateway_messages WHERE cwd IS NOT NULL \
GROUP BY cwd, repo_root ORDER BY last_seen DESC" --format markdown
```

Read **stderr as well as stdout**: a `notice:`/`warning:` line reports withheld or stale rows, and an empty stdout is not the same as zero rows. Do **not** pass `--include-local-only` - the review works on the not-yet-classified directories, and any directory already marked `local-only` has already been decided.

Then, for the directories that look worth a closer look (personal paths, unfamiliar repos, high row counts), **sample** their content looking for:

- credentials and secrets (API keys, tokens, passwords, private keys);
- personal or non-work material;
- candid discussion of identifiable people;
- anything else a person may not want on an org server.

Sample small and read carefully. When you quote a finding back to the user, obey Step 5's redaction rules - even this (opted-out) transcript should stay low-content.

```bash
# Example: sample recent content for one directory (adjust the filter/limit)
hyp query sql "SELECT session_id, role, content_text FROM ai_gateway_messages \
WHERE cwd = '<dir>' ORDER BY date DESC LIMIT 40" --format json --output /tmp/sample.json
# then read /tmp/sample.json rather than flooding context via stdout
```

## Step 4 - Explain the three classes (before the first marking, R5)

Before you propose or apply **anything**, explain the classes in plain language, including what the org can and cannot see in each case:

- **ignore** (`hyp policy set <dir> ignore`): never recorded going forward; the machine-local rule stops capture at the source. Existing cached rows are **purgeable** (Step 6) but are not removed by marking alone. The org sees **nothing** from this directory.
- **local-only** (`hyp policy set <dir> local-only`): recorded and queryable **here** on this machine, but **never forwarded**. Withheld at the export seam. The org sees **nothing**, while you keep local history.
- **sync** (`hyp policy set <dir> sync`): the explicit "this ships" choice - forwarded to the org server like the default. Marking it `sync` records an explicit decision so this directory is not asked about again. The org sees this directory's captured exchanges.

Name the trade honestly: `local-only` keeps your history usable locally; `ignore` is stronger (nothing is even recorded once marked) but you lose local queryability too.

## Step 5 - Propose findings as redacted excerpts, confirm per item (R4, R6)

Present findings as **short, redacted excerpts** and a proposed class per directory:

- **Mask credential bodies** - show that a key was found and where, never the key itself (e.g. `AWS key ...XY7Q in <dir>/notes.md`).
- **Prefer naming files and directories over reproducing content.**
- Keep excerpts short. Even an unprotected transcript should stay low-content.

Then **apply nothing without per-item user confirmation.** Propose, wait for a yes on each item, then mark. Do not batch-apply.

Keep the response tight: a clear list of candidate directories with the proposed
class for each, minimal prose, no restating of the steps. Flag individual
sessions separately only when a directory is otherwise fine but one session is not.

## Step 6 - Apply only via `hyp` verbs, and offer purge for every ignore (R6, R7)

Apply each confirmed decision **only** through the `hyp` verbs below. **Never** author policy files or write anything into the user's repositories - the machine-local store is the only target.

```bash
hyp policy set <dir> ignore      # class: ignore  (stop recording this dir)
hyp policy set <dir> local-only  # class: local-only (record here, never forward)
hyp policy set <dir> sync        # class: sync (explicit "this ships")
hyp policy show <dir>            # report the governing source + class, and residual cached rows; never writes
hyp policy unset <dir> [class]   # remove markings (class-neutral by default; a trailing class scopes it)
```

`hyp policy show <dir>` names **which source governs** (a committed `.hypignore` dotfile vs a machine-local entry) and the entry's class, and reports how many already-cached rows still sit under it - the residue that purge (below) clears. Marking is always **non-destructive**: it changes future capture/forwarding, not existing cached rows.

**For every directory you mark `ignore`, and every session you flag as sensitive, offer `hyp purge` as a separately confirmed step** so that "completely ignored" also means "not sitting in the cache". Purge is destructive and cache-only (it never contacts the server); confirm each purge on its own.

```bash
hyp purge <dir>              # delete cached rows for a directory subtree
hyp purge --session <id>     # delete all cached rows for one session (cheapest: session is the partition key)
hyp purge --ignored          # sweep every cached row whose cwd currently resolves to `ignore`
```

Purge prompts for confirmation on a TTY; it errors on a bare `hyp purge` with no target. Sequencing matters: **mark the directory `ignore` first, then purge** - purging a directory that still resolves to `sync`/default warns that the next backfill will re-import it. Once a directory is `ignore`d, the capture seam blocks re-import, so the purge is durable. A common close-out for a directory the user wants fully gone:

```bash
hyp policy set <dir> ignore && hyp purge <dir>
```

## After the review

- Nothing you did contacts the server. If this machine is not enrolled, nothing is scheduled to leave it at all, and the markings just bound future capture and what the local cache keeps.
- On an enrolled machine, at the deadline - or sooner, if the user runs `hyp sync` and confirms the prompt - the hold expires and export begins: `ignore`d data was never recorded (or was purged), `local-only` rows are withheld at the export seam, and everything else - the `sync` directories and anything left at the default - ships, backfill included.
- Check the pending deadline any time with `hyp status` (it shows the first-sync deadline while the hold is live).
- Re-running this skill later is safe and idempotent; already-decided directories drop out of the survey.
- New folders the user has not marked sync without asking (the default). If they want to be asked once per new folder instead, `hyp policy folders ask` turns that on and `hyp policy folders sync` turns it back off. It moves the question only - every directory marked here keeps its class either way.
