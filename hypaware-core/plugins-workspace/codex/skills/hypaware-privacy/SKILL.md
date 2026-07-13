---
name: hypaware-privacy
description: Review this machine's captured Claude/Codex history with the user before it first syncs to the org server. Use when the user says "review before sync", "privacy review", "what will ship to the server", after a `hyp remote login` printed a first-sync deadline, or otherwise wants to audit and mark captured directories (ignore / local-only / sync) and purge sensitive rows before the deferred first sync.
---

# HypAware privacy review before the first fleet sync

<!-- @ref LLP 0100#skill [implements]: the six-step agent-assisted privacy review the deferred first sync directs the user to run (R3-R8) -->

When `hyp remote login` enrolls this machine, the first sync to the org server is **held until a printed deadline** rather than run immediately. The whole captured history (backfill included) ships at that deadline unless you refine it first. This skill walks the user through that refinement: it surveys what was captured, explains the choices in plain language, and applies the user's decisions through `hyp` verbs before anything leaves the machine. Doing nothing is a valid choice - at the deadline everything forwards, which is the documented default.

Run the six steps below **in order**. Steps 4 and 5 (explain, then confirm) gate every marking: never mark or purge without first explaining the classes and getting per-item confirmation.

## Scope honesty (say this up front)

This flow governs **HypAware's own surfaces only** - what the local cache holds and what the sink forwards. It is not a data-loss-prevention system. Content a user pasted into a synced session, or anything outside HypAware's capture, is out of scope. Be honest that `ignore`/`local-only`/`purge` bound HypAware, not the user's whole machine.

## Step 1 - Protect this session first (R3)

The review conversation will discuss the most sensitive content on the machine, so it must never itself become a captured, forwardable transcript. **Before surveying anything**, opt this Codex session out of capture and **verify it took effect**. On failure, say so plainly and continue **only** with the user's explicit consent.

Codex, unlike Claude, exposes no `CLAUDE_CODE_SESSION_ID`, so the session id must be **discovered** from the rollout Codex writes for this session. Codex records each session as `~/.codex/sessions/**/rollout-<ts>-<session-uuid>.jsonl` whose first line is a `session_meta` record carrying `payload.id` (the session id) and `payload.cwd`. Pick the **newest** rollout, and cross-check its `cwd` against the current directory so a concurrent Codex session in another folder is not confused for this one.

```bash
#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

# Newest rollout file by mtime.
rollout="$(find "$CODEX_HOME/sessions" -type f -name 'rollout-*.jsonl' -print0 2>/dev/null \
  | xargs -0 ls -t 2>/dev/null | head -1)"
if [ -z "${rollout:-}" ]; then
  echo "error: no Codex rollout found under $CODEX_HOME/sessions; cannot resolve session id" >&2
  exit 1
fi

# Read session id and rollout cwd from the session_meta line.
read -r SESSION_ID ROLLOUT_CWD < <(head -1 "$rollout" | python3 -c '
import json, sys
r = json.load(sys.stdin)
p = r.get("payload", {})
print(p.get("id", ""), p.get("cwd", ""))
')
echo "resolved session $SESSION_ID (rollout cwd: $ROLLOUT_CWD)"
# Sanity check: the newest rollout should be THIS session. If ROLLOUT_CWD does
# not match your working directory, STOP and confirm the session id with the
# user before opting anything out.

# Resolve the local gateway base: prefer OPENAI_BASE_URL, else the base_url the
# codex adapter wrote under [model_providers.hypaware] in config.toml, else the
# default port. Strip the `/v1` (or `/backend-api/codex`) API suffix.
BASE="${OPENAI_BASE_URL:-}"
if [ -z "$BASE" ]; then
  BASE="$(grep -A6 '^\[model_providers.hypaware\]' "$CODEX_HOME/config.toml" 2>/dev/null \
    | grep -m1 'base_url' | sed -E 's/.*"([^"]+)".*/\1/')"
fi
BASE="${BASE:-http://127.0.0.1:8787}"
BASE="${BASE%/v1}"; BASE="${BASE%/backend-api/codex}"; BASE="${BASE%/}"
URL="${BASE}/_hypaware/ignore/session"

response="$(curl --fail-with-body --silent --show-error \
  -X POST "$URL" \
  -H 'content-type: application/json' \
  --data "$(printf '{"session_id":"%s"}' "$SESSION_ID")")"

# Verify the gateway reports this session as ignored. `ignored` must be true.
printf '%s' "$response" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if r.get("ignored") is not True:
    sys.exit("opt-out NOT confirmed: " + json.dumps(r))
print("opt-out confirmed for session %s (total ignored: %s)" % (r.get("session_id"), r.get("total")))
'
```

If the session id cannot be resolved, the `curl` fails, the rollout `cwd` does not match this session, or the verification line does not print `opt-out confirmed`, **stop and tell the user the review session may still be recorded**. Only proceed if they explicitly accept that risk. This opt-out is held in memory by the running gateway; a gateway restart drops it, so if the review spans a restart, re-run this step.

## Step 2 - Check that backfill has settled (before surveying)

The picker this skill replaces failed because it surveyed a cache the backfill was still filling and presented a partial list as the whole truth. Do not repeat that. Confirm capture has settled before you survey.

```bash
hyp status --json          # daemon running? enrolled (a central sink present)?
hyp query status           # cache state and last refresh
```

Then run the enumeration query (Step 3) **twice, a short interval apart** (say ~30-60s). If the per-directory `rows` counts are still climbing, backfill is still landing: **warn the user and offer to wait** until counts stabilize before proposing any markings. Surveying mid-backfill risks marking against an incomplete picture. There is no deadline pressure here - the first-sync hold gives hours.

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

- **ignore** (`hyp ignore --private <dir>`): never recorded going forward; the machine-local rule stops capture at the source. Existing cached rows are **purgeable** (Step 6) but are not removed by marking alone. The org sees **nothing** from this directory.
- **local-only** (`hyp ignore --local-only <dir>`): recorded and queryable **here** on this machine, but **never forwarded**. Withheld at the export seam. The org sees **nothing**, while you keep local history.
- **sync** (`hyp ignore --sync <dir>`): the explicit "this ships" choice - forwarded to the org server like the default. Marking `--sync` records an explicit decision so this directory is not asked about again. The org sees this directory's captured exchanges.

Name the trade honestly: `local-only` keeps your history usable locally; `ignore` is stronger (nothing is even recorded once marked) but you lose local queryability too.

## Step 5 - Propose findings as redacted excerpts, confirm per item (R4, R6)

Present findings as **short, redacted excerpts** and a proposed class per directory:

- **Mask credential bodies** - show that a key was found and where, never the key itself (e.g. `AWS key ...XY7Q in <dir>/notes.md`).
- **Prefer naming files and directories over reproducing content.**
- Keep excerpts short. Even an unprotected transcript should stay low-content.

Then **apply nothing without per-item user confirmation.** Propose, wait for a yes on each item, then mark. Do not batch-apply.

## Step 6 - Apply only via `hyp` verbs, and offer purge for every ignore (R6, R7)

Apply each confirmed decision **only** through the `hyp` verbs below. **Never** author policy files or write anything into the user's repositories - the machine-local store is the only target.

```bash
hyp ignore --private <dir>       # class: ignore  (stop recording this dir)
hyp ignore --local-only <dir>    # class: local-only (record here, never forward)
hyp ignore --sync <dir>          # class: sync (explicit "this ships")
hyp ignore --check <dir>         # report the governing source + class, and residual cached rows; never writes
hyp unignore --private|--local-only|--sync <dir>   # symmetric removal per class
```

`hyp ignore --check <dir>` names **which source governs** (a committed `.hypignore` dotfile vs a machine-local entry) and the entry's class, and reports how many already-cached rows still sit under it - the residue that purge (below) clears. Marking is always **non-destructive**: it changes future capture/forwarding, not existing cached rows.

**For every directory you mark `ignore`, and every session you flag as sensitive, offer `hyp purge` as a separately confirmed step** so that "completely ignored" also means "not sitting in the cache". Purge is destructive and cache-only (it never contacts the server); confirm each purge on its own.

```bash
hyp purge <dir>              # delete cached rows for a directory subtree
hyp purge --session <id>     # delete all cached rows for one session (cheapest: session is the partition key)
hyp purge --ignored          # sweep every cached row whose cwd currently resolves to `ignore`
```

Purge prompts for confirmation on a TTY; it errors on a bare `hyp purge` with no target. Sequencing matters: **mark `--private` first, then purge** - purging a directory that still resolves to `sync`/default warns that the next backfill will re-import it. Once a directory is `ignore`d, the capture seam blocks re-import, so the purge is durable. A common close-out for a directory the user wants fully gone:

```bash
hyp ignore --private <dir> && hyp purge <dir>
```

## After the review

- Nothing you did contacts the server. At the deadline, the hold expires and export begins: `ignore`d data was never recorded (or was purged), `local-only` rows are withheld at the export seam, and everything else - the `sync` directories and anything left at the default - ships, backfill included.
- Check the pending deadline any time with `hyp status` (it shows the first-sync deadline while the hold is live).
- Re-running this skill later is safe and idempotent; already-decided directories drop out of the survey.
