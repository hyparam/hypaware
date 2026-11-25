# LLP 0625: With the folder ask on, a chat with no folder is not recorded

**Type:** Decision
**Status:** Draft
**Systems:** Usage-Policy, Cache, Sources
**Author:** Phil / Claude
**Date:** 2026-11-24
**Extends:** LLP 0622 (#folder-only: the scope it left out is settled here)
**Related:** LLP 0027 (flush-time settlement), LLP 0050 (capture-seam enforcement in the adapters), LLP 0085 (settlement may drop a late ignore), LLP 0192 (rows nothing can attribute), LLP 0624 (the history import), LLP 0626 (which `ask` the rule applies to)

> Extends [LLP 0622](./0622-ask-mode-collects-nothing-from-an-unmarked-folder.decision.md).
> While the folder ask is in force, a chat that carries no folder is not
> recorded. There is no question for it and no answer to give: the ask means
> "collect nothing I have not said yes to", and a chat with no folder has
> nothing to say yes to.

## Context {#context}

[LLP 0622 #folder-only](./0622-ask-mode-collects-nothing-from-an-unmarked-folder.decision.md#folder-only)
left chats with no folder recorded as before. That was a misreading of the
requirement. What was deferred was the *question* for such chats, because
most of them have nowhere to ask it. The rule itself, collect nothing by
default, was meant to cover them.

It is not a corner case. On one developer machine's cache:

| Client | Sessions that never carry a folder | Sessions where only some rows do | Sessions that always do |
|---|---|---|---|
| Codex | 745 | 86 (329,169 rows with none) | 2,664 |
| Claude | 63 | 27 (2,232 rows with none) | 5,412 |

So "no folder" mostly means "HypAware did not learn the folder", not "this
chat happened nowhere". Under LLP 0622 alone, about one Codex session in
five would be recorded and synced with the ask on, from folders nobody
answered for.

## Options {#options}

1. **Leave them recorded** (LLP 0622 as drafted). Rejected: it is the gap.
2. **Record them and hold them on the machine.** One change at the export
   seam, nothing lost. Not chosen: the requirement is that they are not
   recorded.
3. **Have each adapter treat "no folder" as waiting.** About twenty
   adapters each skip the policy check on their own when they have no
   folder, and every new adapter would have to remember the case. The
   review of LLP 0622 already found one adapter that had missed the
   simpler rule.
4. **Refuse the row where rows are committed** (chosen).

## Decision {#decision}

<a id="rule"></a>**While the folder ask is in force, a row that carries no
folder is never committed to the cache.** "In force" is a stamped `ask`
([LLP 0626 #stamp](./0626-an-older-ask-is-adopted-once.decision.md#stamp)).
In the default mode, and for an `ask` an older version wrote, nothing
changes.

<a id="one-place"></a>**The rule lives at the cache's commit points, not in
the adapters.** Every writer reaches the cache through the storage service:
the spool flush, the direct partition append, and the snapshot reconciles.
The rule is applied at each. That covers every client and every future one,
and it does not depend on an adapter remembering that "no folder" is a
case. LLP 0050 keeps what it settled: an adapter still drops a chat whose
folder resolves `ignore` before building rows. This is the case LLP 0050
has no call site for, because there is no folder to resolve.

<a id="after-settlement"></a>**A row is judged after settlement.** A
dataset's settle hook ([LLP 0027](./0027-cache-settlement.decision.md))
can attach a folder that arrived after the row was captured. The rule runs
after the hook, so a folder that arrives late still counts.

<a id="scope"></a>**Only a dataset that declares a `cwd` column is
touched.** Today that is `ai_gateway_messages` and the Claude telemetry
events. A dataset with no such column does not describe a chat in a folder,
and this rule has nothing to say about it.

<a id="row-level"></a>**The unit is the row.** A row with no folder is not
committed even when other rows of its session carry one. The storage
service cannot know a session's folder from a row that does not carry it,
and guessing one would attach a folder nobody recorded.

<a id="no-question"></a>**No question, no per-chat answer.** The way to
record these chats again is the default mode (`hyp privacy folders sync`).

<a id="observable"></a>**A drop is logged as a count.**
`usage_policy.no_folder_drop` carries the dataset and how many rows, never a
session id or content.

<a id="copy"></a>**Turning the ask on says so**, in the wizard option, in
`hyp privacy folders ask`, in the command help, and in the privacy guide.

## Consequences {#consequences}

- With the ask on, raw API traffic through the proxy and Ollama are not
  recorded at all. Neither carries a folder.
- A client whose live capture often lacks a folder (Codex, on the numbers
  above) records less from its live lane. Where the client keeps a
  transcript on disk, the scheduled history sweep reads the folder from the
  transcript, so the same messages can arrive that way, later. That was not
  measured for this decision. See #open-questions.
- A row spooled before the ask was turned on, and not yet committed, is
  dropped when it is flushed. The mode is read at commit.
- Rows already committed are untouched. Nothing is deleted.
- The history import of LLP 0624 already leaves a session with no folder.
- CPU and memory: with the ask off, one memoized mode read per committed
  batch. With it on, one pass over the batch and no allocation unless a row
  is dropped. Nothing per row is added to capture.

## Open questions {#open-questions}

1. **A way to let one source back in.** A per-source answer ("record
   Ollama even with the ask on") needs new state. Not settled here.
2. **How much the sweep recovers.** Whether the rows that lack a folder
   inside otherwise-foldered sessions come back through the transcript
   sweep with a folder, per client. Measure before relying on it.
3. **Sessions that should inherit a folder.** A subagent or child thread
   that carries no folder of its own could take its parent's. That is an
   attribution fix in the adapters, and it would shrink what this rule
   drops.
4. **Already-committed rows with no folder** still export. Whether the ask
   should also hold them at the export seam is not settled here.

## References

- LLP 0027, LLP 0050, LLP 0085, LLP 0192, LLP 0622, LLP 0624, LLP 0626
- `src/core/cache/storage.js` (`rowsWithFolder` and the commit points),
  `src/core/usage-policy/matcher.js` (`resolveNoFolder`),
  `src/core/commands/policy.js` and `src/core/cli/wizard/folder_ask.js`
  (the wording)
