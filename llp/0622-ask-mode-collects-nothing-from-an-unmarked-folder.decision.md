# LLP 0622: With the folder ask on, an unmarked folder is not collected

**Type:** Decision
**Status:** Draft
**Systems:** Usage-Policy, Onboarding, CLI
**Author:** Phil / Claude
**Date:** 2026-11-24
**Extends:** LLP 0200 (#store: what `ask` means for a folder nobody has marked; #default and the `sync` mode are untouched)
**Related:** LLP 0049 (#classes: the implicit `full` default this narrows), LLP 0050 (capture-seam enforcement in the adapters), LLP 0070 (#enforce: the export seam), LLP 0103 (the explicit `full` entry that records a "sync" answer), LLP 0104 (`hyp purge`), LLP 0105 (the query seam), LLP 0106 (the session-start question), LLP 0510 (the question's forwarding gate), LLP 0623 (what happens to folders already recorded when the ask is turned on), LLP 0624 (a "sync" answer imports the folder's history at once)

> Extends [LLP 0200](./0200-folder-ask-is-a-preference.decision.md).
> Choosing `ask` stops being only a question. While the ask is on, a folder
> nobody has marked is not collected at all, in every client, until someone
> marks it. The default mode (`sync`) is unchanged: new folders are
> collected and sync without a question.

## Context {#context}

[LLP 0200 #store](./0200-folder-ask-is-a-preference.decision.md#store)
defines `ask` as the session-start question of
[LLP 0106](./0106-session-start-classification-hook.decision.md) and nothing
else: an unmarked folder keeps the implicit `full` class
([LLP 0049 #classes](./0049-hypignore-usage-policy.spec.md#classes)) whether
or not the question was answered. In its own words, "what the ask ever
added was a prompt, never an enforcement."

A user who picks "Ask me the first time" reads it as "nothing from a new
folder leaves until I say so". Today the product does the opposite in every
case where no answer arrives:

- **The question is ignored.** Claude's hook injects `additionalContext`; it
  is a firm instruction, not a block. A user who keeps typing is recorded
  and synced.
- **Nobody is there.** A headless or CI session is never asked
  ([LLP 0106 #interactive](./0106-session-start-classification-hook.decision.md#interactive))
  and proceeds under the implicit default.
- **The client does not ask.** Only the Claude plugin installs the hook
  (`claude/src/settings.js`). The Codex command `codex-hook classify-cwd`
  is registered but nothing installs or invokes it. Cursor and Grok can
  inherit Claude's hook and are deliberately silenced. No other adapter has
  a question at all.

So `ask` gives the control it promises only in one client, and only when
the user answers.

## Options {#options}

1. **Leave the behavior, fix the wording.** Say plainly that `ask` is only a
   reminder. Honest, but it removes the one setting a privacy-minded user
   reaches for.
2. **Add the question to every client.** Per-client work that never ends,
   and it still cannot cover headless runs or an ignored question.
3. **Hold unmarked folders on the machine** (`local-only` until answered).
   Nothing is lost and nothing leaves. Not chosen: the requirement is that
   content from a folder nobody has considered is not recorded, not that it
   is recorded and held.
4. **Do not collect unmarked folders** (chosen).

## Decision {#decision}

<a id="rule"></a>**While the folder-ask mode is `ask`, a folder no explicit
source governs resolves as `ignore` for capture and for export.** Explicit
sources are unchanged and still win: a `.hypignore` file and a machine-local
entry ([LLP 0103](./0103-machine-local-policy-classes.decision.md)),
including the explicit `full` entry. Answering "sync" already writes that
entry, so the answer is what starts collection. No new class and no new
store.

<a id="one-place"></a>**The rule lives in the shared resolver, not in the
clients.** Every adapter's capture path, every backfill, and the export seam
already call `createUsagePolicyResolver`, and one line in it supplies the
implicit default. The folder-ask preference sits in the same state directory
as the machine-local list that resolver already reads. Changing the default
there covers every client that reports a folder, including the ones that
never ask, with no per-adapter logic.

<a id="still-unmarked"></a>**An unanswered folder is still unmarked.** The
resolver keeps reporting that no source governs it. Two things depend on
that:

- The question is still asked, because the hook asks about folders nothing
  governs.
- `hyp purge --ignored` deletes rows only for folders someone explicitly
  marked `ignore`. It must not treat an unanswered folder as ignored.
  Otherwise turning the ask on and then purging would delete the history of
  every folder the user has not got round to marking.

<a id="sync-unchanged"></a>**The `sync` mode is untouched.** It stays the
default and what an absent preference means
([LLP 0200 #default](./0200-folder-ask-is-a-preference.decision.md#default)).
A machine that never chose `ask` behaves exactly as it does today.

<a id="fail-safe"></a>**An unreadable preference means not collected.**
[LLP 0200 #fail-safe](./0200-folder-ask-is-a-preference.decision.md#fail-safe)
already resolves a present-but-unparseable file to `ask`. That direction
now has a data consequence, and it is the safe one: nothing new is collected
from unmarked folders until the file is repaired. `hyp status` and the
`hyp privacy` commands keep failing loudly and naming the repair, so the
gap is not silent.

<a id="copy"></a>**Every surface that names the mode names the
consequence.** The wizard option, the `hyp privacy folders ask` output, the
`hyp status` line, and the question itself say that nothing is collected
from a new folder until it is marked. The question's line "it would sync by
default" is wrong under this rule and is replaced.

<a id="folder-only"></a>**Scope: folders only.** A row that carries no
folder is outside this rule and is recorded as it is today. That case is
left for a later decision.

<a id="forwarding"></a>**No special case for a machine that forwards
nowhere.** The rule follows the stored mode, because the resolver reads
folder markings and not the config. The question keeps its forwarding gate
([LLP 0510](./0510-classification-asks-wherever-the-machine-forwards.decision.md))
and the wizard does not offer the step on such a machine, so the only ways
to be on `ask` there are `hyp privacy folders ask` and leaving a team with
the mode still set. In that state new folders are not collected and nothing
asks. `hyp privacy folders sync` is the way out, and #copy makes the
command say so. This edge is accepted, not designed for.

## Consequences {#consequences}

- In a client that does not ask, a new folder is silent: nothing is
  collected and nothing prompts. The way in is
  `hyp privacy set <path> sync`.
- Messages sent before the answer are not captured live. After a "sync"
  answer the resolver picks the new marking up within its 5 second cache,
  and [LLP 0624](./0624-answering-the-folder-ask-imports-that-folders-history.decision.md)
  imports the folder's saved history at once. A source with no transcript
  on disk cannot recover them.
- Rows already in the cache from an unmarked folder stop exporting while
  the folder stays unmarked, because the export seam derives the class from
  each row's folder at export time
  ([LLP 0070 #enforce](./0070-local-only-export-seam.decision.md#enforce)). LLP 0623
  settles this for folders recorded before the ask was turned on.
- A query run from an unmarked folder resolves as the `ignore` class, the
  top of the visibility order, so it can see `local-only` rows. This matches
  [LLP 0105](./0105-query-seam-local-only-visibility.decision.md): that
  session is not recorded, so nothing it reads can leave through it.
- CPU and memory: one extra small file read per resolver, on the same
  5 second cache as the machine-local list. No per-row work is added.

## Open questions {#open-questions}

1. **Seeing the folders that are waiting.** A list of folders seen but not
   collected would close the silent gap in clients that do not ask. It needs
   new state, so it is not part of this decision.
2. **Chats with no folder.** Deferred, see #folder-only.

## References

- LLP 0049, LLP 0050, LLP 0070, LLP 0103, LLP 0104, LLP 0105, LLP 0106,
  LLP 0200, LLP 0510, LLP 0623, LLP 0624
- `src/core/usage-policy/matcher.js` (the resolver and its implicit
  default), `src/core/usage-policy/folder_ask.js` (the preference),
  `src/core/usage-policy/classification.js` (the question and its copy),
  `src/core/cache/purge.js` (the `ignored` purge target),
  `src/core/cache/storage.js` (the export seam),
  `src/core/cli/wizard/folder_ask.js` (the wizard step)
