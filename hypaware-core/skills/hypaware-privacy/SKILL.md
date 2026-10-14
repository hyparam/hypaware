---
name: hypaware-privacy
description: 'Audit what HypAware has captured from AI client sessions on this machine and act on it: survey the recorded directories, sample them for secrets, credentials, and personal content, mark directories (ignore / local-only / sync), and purge sensitive rows. Also use for "don''t record this", "pause logging", or "resume recording"; handle direct recording controls without a full audit. Runs any time. Use when the user says "privacy review", "did I record anything sensitive", "scan my logs for secrets", "what should I hypignore", or wants to see what was captured here. It is also the standard review before an enrolled machine''s first org sync: use after `hyp remote login` prints a first-sync deadline, or when the user says "review before sync", "what will ship to the server", or "what will sync to the cloud". Surveys this machine''s local cache; rows already forwarded are out of scope except where a session purge deletes them.'
---

# HypAware privacy review: audit what was captured, decide what leaves

This skill surveys what HypAware has captured on this machine, explains the choices in plain language, and applies the user's decisions through `hyp` verbs. For a privacy review, the six steps run the same way; only the stakes change.

The one moment they are time-critical is enrollment. When `hyp remote login` enrolls this machine, the first sync to the org server is **held until a printed deadline** rather than run immediately, and the whole captured history (backfill included) ships at that deadline unless you refine it first. Doing nothing is a valid choice there - at the deadline everything forwards, which is the documented default. On a machine that was never enrolled there is no pending export at all, and the same steps simply bound what gets recorded and what stays in the local cache.

For an audit, run the six steps below **in order**. Steps 4 and 5 (explain, then confirm) gate audit-driven markings: never mark or purge without first explaining the classes and getting per-item confirmation.

## Direct recording controls

For an explicit recording-control request, perform only the requested action;
do not start the six-step audit. The six-step requirements above apply to a
privacy review. Verify the command receipt and report failures accurately.

- Opt a folder out of recording - `hyp privacy ignore <path>` writes a committable
  `.hypignore`; `hyp privacy set <path> ignore` marks it machine-local instead,
  with no repo breadcrumb.
- Stop recording *this conversation* - `hyp session ignore` drops this session's
  exchanges at every local recorder it can address; `hyp session unignore`
  resumes, and `hyp session status` reports which it is right now. Each
  resolves this client's session id itself, if the client states one, and fails
  closed rather than guessing. When it cannot, pass an id the user or this
  client has explicitly verified, or report that the opt-out is unconfirmed. A
  recent transcript or a matching folder cannot establish the current session.
  The opt-out survives restarts until explicitly unignored and is honored by
  transcript backfill. A forked session has a new id and needs its own
  exclusion. Ignoring does not purge prior records; unignoring permits older
  transcript content to be imported again.
- Decide what happens in new folders - by default they sync with no
  question; `hyp privacy folders ask` asks once per new folder instead, and
  `hyp privacy folders sync` returns to the default. It gates the question
  only, never an existing class.

## Scope honesty (say this up front)

This flow governs **HypAware's own surfaces only** - what the local cache holds and what the sink forwards. It is not a data-loss-prevention system. Content a user pasted into a synced session, or anything outside HypAware's capture, is out of scope. Be honest that `ignore`/`local-only`/`purge` bound HypAware, not the user's whole machine.

## Step 1 - Protect this session first (R3)

The review conversation will discuss the most sensitive content on the machine, so it must never itself become a captured, forwardable transcript. **Before surveying anything**, opt this session out of capture and **verify it took effect**. On failure, say so plainly and continue **only** with the user's explicit consent.

```bash
hyp session ignore --json
```

The verb resolves this client's session id, if the client states one, addresses every local recorder it can find, and fails closed: it exits nonzero and prints no success when it cannot establish the right id, which is the answer this step needs. Do not resolve the id yourself from a recent file or a matching directory: a guess opts out a session you are not in while this one keeps being recorded.

Read the receipt rather than only the exit code, and report what it says:

- `"status"` is `ok` only when every recorder it *addressed* took the write; `partial` means at least one did not. Neither says a recorder it never addressed is covered.
- `"session_id"` and `"session_id_source"` say which session it opted out and how it found the id. If the source names another client, or the user does not recognize the session, it opted out a bystander while this one keeps being recorded. That write already happened, so undo it before you stop - `hyp session unignore "<the session_id it reported>"`.
- `"recorders"` lists each recorder it addressed and that recorder's answer. Report any entry that is not `ok`.

**If the verb refuses** because it cannot resolve an id, or because more than one client states one for this shell, do not guess. If the user or this client can state the id, pass it explicitly and check that `"session_id"` equals it byte for byte:

```bash
hyp session ignore --json "<session-id>"
```

**Stop on any of these** and tell the user the review session may still be recorded: a nonzero exit with no stated id to retry with, `"status": "partial"`, a session the user does not recognize, or a receipt you cannot read. Only proceed if they explicitly accept that risk.

**What a confirmed opt-out proves, exactly.** Each recorder holds the id as an opaque token: `ignored: true` means the id is in that recorder's drop set, and nothing more. No recorder inspects traffic, so none can tell you the id is one your exchanges carry. The reply is a receipt for the write, not a verified drop: report it to the user that way, and never treat a follow-up `hyp session status` as extra proof, since it asks the same set the same question.

The opt-out is saved locally and survives recorder and daemon restarts until explicitly removed with `hyp session unignore`. A forked session gets a new session id that needs its own exclusion; a plain resume reuses the id. Transcript backfill honors the saved exclusion. Unignoring permits earlier transcript content to be imported again. Use `hyp session status` to check the current answer.

## Step 2 - Check that backfill has settled (before surveying)

The picker this skill replaces failed because it surveyed a cache the backfill was still filling and presented a partial list as the whole truth. Do not repeat that. Confirm capture has settled before you survey.

```bash
hyp status --json          # daemon running? enrolled (a central sink present)?
hyp cache status           # cache state and last refresh
```

Then run the enumeration query (Step 3) **twice, a short interval apart** (say ~30-60s). If the per-directory `rows` counts are still climbing, backfill is still landing: **warn the user and offer to wait** until counts stabilize before proposing any markings. Surveying mid-backfill risks marking against an incomplete picture. There is no deadline pressure here: on an enrolled machine the first-sync hold gives hours, and on an unenrolled one nothing is waiting to leave. Note that an enrolled user can also end that window early at any time with `hyp sync` (it prints what would leave and asks first), so if they say they are in a hurry, finishing the review is what unblocks them, not waiting.

## Step 3 - Survey the captured directories, then sample content (R4 applies)

Enumerate the distinct working directories this machine has captured (an enumerate query over `ai_gateway_messages`):

```bash
hyp query sql "SELECT cwd, repo_root, COUNT(*) AS rows, MAX(date) AS last_seen \
FROM ai_gateway_messages WHERE cwd IS NOT NULL \
GROUP BY cwd, repo_root ORDER BY last_seen DESC" --format markdown
```

Read **stderr as well as stdout**: a `notice:`/`warning:` line reports withheld or stale rows, and an empty stdout is not the same as zero rows. Do **not** pass `--include-local-only` - the review works on the not-yet-classified directories, and any directory already marked `local-only` has already been decided.

If this client reaches HypAware through the local MCP server (`hyp mcp serve`) rather than the shell, run the same SELECTs with its `query_sql` tool; a remote MCP reads the server, not this machine's cache. The session, marking and purge controls have no MCP tool: they need `hyp` on this machine, so without it say which steps you cannot perform.

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

- **ignore** (`hyp privacy set <dir> ignore`): never recorded going forward; the machine-local rule stops capture at the source. Existing cached rows are **purgeable** (Step 6) but are not removed by marking alone. The org sees **nothing** from this directory.
- **local-only** (`hyp privacy set <dir> local-only`): recorded and queryable **here** on this machine, but **never forwarded**. Withheld at the export seam. The org sees **nothing**, while you keep local history.
- **sync** (`hyp privacy set <dir> sync`): the explicit "this ships" choice - forwarded to the org server like the default. Marking it `sync` records an explicit decision so this directory is not asked about again. The org sees this directory's captured exchanges.

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
hyp privacy set <dir> ignore      # class: ignore  (stop recording this dir)
hyp privacy set <dir> local-only  # class: local-only (record here, never forward)
hyp privacy set <dir> sync        # class: sync (explicit "this ships")
hyp privacy show <dir>            # report the governing source + class, and residual cached rows; never writes
hyp privacy unset <dir> [class]   # remove markings (class-neutral by default; a trailing class scopes it)
```

`hyp privacy show <dir>` names **which source governs** (a committed `.hypignore` dotfile vs a machine-local entry) and the entry's class, and reports how many already-cached rows still sit under it - the residue that purge (below) clears. Marking is always **non-destructive**: it changes future capture/forwarding, not existing cached rows.

**For every directory you mark `ignore`, and every session you flag as sensitive, offer `hyp privacy purge` as a separately confirmed step** so that "completely ignored" also means "not sitting in the cache". Purge is destructive. A directory or `--ignored` purge touches only the local cache; a `--session` purge also deletes that session on configured and signed-in remotes and enrolled servers unless you add `--local-only`. Confirm each purge on its own.

```bash
hyp privacy purge <dir>              # delete cached rows for a directory subtree
hyp privacy purge --session <id>     # delete one session here and on configured, signed-in and enrolled servers (cheapest: session is the partition key)
hyp privacy purge --session <id> --local-only   # same, but skip the server-side delete
hyp privacy purge --ignored          # sweep every cached row whose cwd currently resolves to `ignore`
```

Purge prompts for confirmation on a TTY; it errors on a bare `hyp privacy purge` with no target. Sequencing matters: **mark the directory `ignore` first, then purge** - purging a directory that still resolves to `sync`/default warns that the next backfill will re-import it. Once a directory is `ignore`d, the capture seam blocks re-import, so the purge is durable. A common close-out for a directory the user wants fully gone:

```bash
hyp privacy set <dir> ignore && hyp privacy purge <dir>
```

## After the review

- Nothing you did sends captured data anywhere: markings stay on this machine, and a `--session` purge sends only the session id to configured, signed-in and enrolled servers so they delete that session there. If this machine is not enrolled, nothing is scheduled to leave it at all, and the markings just bound future capture and what the local cache keeps.
- On an enrolled machine, at the deadline - or sooner, if the user runs `hyp sync` and confirms the prompt - the hold expires and export begins: `ignore`d data was never recorded (or was purged), `local-only` rows are withheld at the export seam, and everything else - the `sync` directories and anything left at the default - ships, backfill included.
- Check the pending deadline any time with `hyp status` (it shows the first-sync deadline while the hold is live).
- Re-running this skill later is safe and idempotent; already-decided directories drop out of the survey.
- New folders the user has not marked sync without asking (the default). If they want to be asked once per new folder instead, `hyp privacy folders ask` turns that on and `hyp privacy folders sync` turns it back off. It moves the question only - every directory marked here keeps its class either way.
