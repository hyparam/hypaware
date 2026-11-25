# LLP 0624: Answering the folder ask imports that folder's history at once

**Type:** Decision
**Status:** Draft
**Systems:** Usage-Policy, Sources, CLI
**Author:** Phil / Claude
**Date:** 2026-11-24
**Related:** LLP 0622 (the rule that leaves a folder uncollected until it is answered), LLP 0623 (folders marked at the switch, which need no import), LLP 0037 (backfill on join, the first automatic import), LLP 0041 (#execution-isolation: an import never blocks its caller), LLP 0049 (#prospective-only), LLP 0103 (the machine-local entry an answer writes), LLP 0106 (one store, three writers), LLP 0359 (#file-fingerprints: why the scheduled sweep is not enough), LLP 0445 (`hyp backfill`)

> When a folder that was waiting for an answer is marked `sync` or
> `local-only`, HypAware starts a background import of that folder's saved
> history right away. The user said yes to the folder, so they get the
> folder, not only the messages sent after the answer.
>
> @ref LLP 0622 [constrained-by] - #rule is what creates the gap this fills.

## Context {#context}

Under [LLP 0622 #rule](./0622-ask-mode-collects-nothing-from-an-unmarked-folder.decision.md#rule),
nothing is collected from a folder until someone marks it. Marking it only
writes the entry
([LLP 0103](./0103-machine-local-policy-classes.decision.md)). It starts no
import. What the user gets afterwards depends on the scheduled sweep:

- Messages sent after the answer are collected, once the resolver's 5 second
  cache turns over.
- A session still being written is recovered by the next sweep, because its
  transcript file keeps changing.
- A session that already finished is **not** recovered. The sweep remembers
  each transcript by fingerprint and skips a file that has not changed
  ([LLP 0359 #file-fingerprints](./0359-bounded-scheduled-backfill.decision.md#file-fingerprints)).
  It already looked at that file while the folder was unanswered, dropped
  it, and will not look again until the daemon restarts.

So a user who works in a folder on Monday without answering, and says
"sync" on Tuesday, gets Tuesday and silently not Monday. A manual
`hyp backfill` would get both: it does not use the fingerprint memory and
re-reads every transcript.

## Options {#options}

1. **Wait for the sweep.** No new work, and the gap above stays. The user
   has no way to know Monday is missing.
2. **Tell the user to run `hyp backfill`.** Honest, and it puts a
   maintenance step on the one moment that should be a single answer.
3. **Start the import when the answer is recorded** (chosen).

## Decision {#decision}

<a id="rule"></a>**Marking an unanswered folder `sync` or `local-only`
starts an import of that folder's history.** "Unanswered" means what
LLP 0622 means: the folder-ask mode is `ask` and no explicit source governed
the folder before this marking.

<a id="one-trigger"></a>**The trigger is the marking verb, so every writer
gets it.** The hook's answer, the privacy skill, and a person typing
`hyp privacy set <path> sync` all go through the same verb
([LLP 0106](./0106-session-start-classification-hook.decision.md), "one
store, three writers"). Putting the trigger there covers the clients that
never ask: the user marks the folder by hand and still gets its history.

<a id="background"></a>**The import never blocks the answer.** The answer is
often given from inside a chat, by the agent running the command. The verb
records the marking, starts the import, says so in one line, and returns.
The import runs in its own process, as the join-time import does
([LLP 0041 #execution-isolation](./0041-central-config-client-actions.design.md#execution-isolation)).
A failed or unstartable import does not fail the marking: the marking is
the answer and it stands. The failure is logged and the line names
`hyp backfill` as the way to retry.

<a id="scoped"></a>**The import is limited to that folder.** `hyp backfill`
could be limited by date and not by folder, so it gains `--folder <path>`.
A folder-limited run writes only sessions recorded in that folder or inside
it. The runner enforces that for every provider, taking or leaving a session
whole. It also hands the folder to the provider, and a provider that knows a
session's folder before projecting it skips the others there, which is where
the time is saved.

<a id="one-at-a-time"></a>**One import runs at a time.** A second answer
while one is running waits its turn. Answers do not start parallel imports.

<a id="not-these"></a>**What does not start an import:**

- Marking a folder `ignore`. Nothing is collected.
- Lifting an explicit `ignore`. Sessions from that period were excluded on
  purpose, and markings stay prospective for them
  ([LLP 0049 #prospective-only](./0049-hypignore-usage-policy.spec.md#prospective-only)).
- The switch-time markings of
  [LLP 0623](./0623-turning-the-folder-ask-on-keeps-recorded-folders.decision.md).
  Those folders were being collected already, so nothing is missing.
- Any marking while the mode is `sync`. Nothing was held back.

## Consequences {#consequences}

- "Yes" means the folder, not "from now on". The Monday session in the
  example is imported on Tuesday.
- The import reaches only what a manual import reaches. A source that keeps
  no transcript on disk (raw API traffic, OTEL, Ollama) cannot be caught up:
  for those, messages sent before the answer are gone.
- This is a second automatic import beside the join-time one
  ([LLP 0037](./0037-backfill-on-join.decision.md)). Release notes for the
  version that ships it must say so, per the release checklist.
- CPU and memory: the cost is paid once per answered folder, off the
  capture path, and #scoped bounds it to that folder's sessions instead of
  the whole history. #one-at-a-time keeps a burst of answers from running
  several imports together. Nothing is added to per-row capture or export.

## Open questions {#open-questions}

1. **Narrowing the read in the remaining providers.** The runner's limit is
   correct for all fourteen providers. Claude and Codex also skip another
   folder's session before projecting it. The other twelve still project
   every session and have the runner discard it, which is correct and slow
   on a large history. Each can adopt the early skip on its own.

## References

- LLP 0037, LLP 0041, LLP 0049, LLP 0103, LLP 0106, LLP 0359, LLP 0445,
  LLP 0622, LLP 0623
- `src/core/commands/policy.js` (`hyp privacy set`, the marking verb),
  `src/core/commands/backfill.js` (`hyp backfill`),
  `src/core/config/action_backfill.js` (the join-time import's subprocess
  seam), `hypaware-core/plugins-workspace/claude/src/backfill.js` (the
  sweep's fingerprint skip)
