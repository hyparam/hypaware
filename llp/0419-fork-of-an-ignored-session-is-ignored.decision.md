# LLP 0419: A fork of an ignored session is ignored automatically

**Type:** Decision
**Status:** Accepted
**Systems:** Privacy, Plugins, Sources, Backfill
**Author:** Phil / Claude
**Generated-by:** neutral
**Date:** 2026-09-18
**Related:** LLP 0066, LLP 0067, LLP 0085, LLP 0256, LLP 0403;
hyparam/hypaware#1891
**Extends:** LLP 0403

> `hyp session ignore` holds one key per opt-out, the raw session id, and a
> fork mints a new one over a copy of the whole parent conversation. So an
> opted-out conversation was recorded in full under the fork's id, live and
> through backfill. The product knew and pushed it onto the user. It is now
> closed by the client instead: the managed Claude hook recognises a forked
> transcript and adds the new id through the ordinary opt-out path before the
> fork's first exchange. Recognition is by fingerprint, because Claude exposes
> no parent id. The Codex lane of hyparam/hypaware#1891 is not in this
> document.

## Context {#context}

LLP 0403 made session exclusions durable and left one sentence standing from
LLP 0066: "Forks with a new session ID require another exclusion." Nothing
enforced it, nothing detected it, and the skills repeated it as an instruction
to the user. hyparam/hypaware#1891 established what that costs:
`claude --resume <id> --fork-session` (and `/branch`) copies the parent
transcript into a new JSONL under a new `session_id`, and the fork's first
request replays the whole parent history as context. Ignore a conversation,
fork it, and every word of it is recorded under the new id.

The decision here is that this is the product's problem, not the user's. An
opt-out that a single keystroke silently undoes is not an opt-out, and the
user cannot see that it happened.

## Recognising a fork {#fingerprint}

Claude Code's `SessionStart` hook input carries `session_id`, `transcript_path`,
`cwd`, and since 2.1.214 `source: "fork"`. It carries **no parent id**, and
upstream requests for one were closed as not planned. So the parent is
identified by what the copy keeps rather than by what the client says.

A forked transcript rewrites `sessionId` on every copied line and leaves each
line's `uuid` alone. The leading uuids of a transcript are therefore a stable
handle on the conversation itself, independent of which id it is filed under.

`hyp session ignore` stores those uuids - **at most eight, and nothing else** -
as a *fork fingerprint*, read from the `transcript_path` the session-context
channel already records for that id. A fingerprint is a sibling file under
`<HYP_HOME>/hypaware/session-ignores/`, named by the same SHA-256 of the id's
JSON encoding as the marker, with a `.fingerprint.json` suffix.

Consequences of the sibling shape, all deliberate:

- **Every existing drop path is untouched.** They read id markers and nothing
  else, so nothing about the match key, the receipt, or the refusal behavior
  moves.
- **The loader learns the suffix.** It rejected any other filename as
  corruption, which is the behavior that makes a damaged privacy store disable
  capture rather than silently shrink; that behavior is kept, and the new name
  is added to what it accepts.
- **Fingerprint bytes count toward the store's existing ceiling.** They are
  state in the same directory under the same 4 MiB bound, and a bound that
  ignored half its own directory would not be one.
- **A damaged fingerprint fails closed**, like a damaged marker: a fingerprint
  that cannot be read is a fork that would be recorded.
- **`unignore` removes both**, in the recorder's own `delete`, so the removal
  happens wherever the removal happens and not only on the CLI path.

A fingerprint is line uuids. Nothing in this design stores, logs, or emits
conversation text, and a value that is not a bare token is dropped rather than
written.

## Any one uuid, not all of them {#any-match}

The hook matches when **any single** uuid of the new transcript appears in
**any** stored fingerprint.

Transcript uuids are random v4, so one shared value is not a coincidence and
any-match costs nothing in false positives. All-match, by contrast, would
break the moment a client build prepended a metadata line to the copy or
trimmed the head of a long conversation.

The same property covers a fork of a fork with no record per generation: the
heads are shared down the whole chain, so a grandchild matches the original
parent's fingerprint directly.

The failure direction matters and is not symmetric. Missing a fork records a
conversation the user opted out of, which is this document's subject. Wrongly
matching destroys capture for a session the user never opted out of, silently
and with nothing to tell them. So every unreadable, absent, or ambiguous input
resolves to **no match**: an unreadable store, a missing transcript, a head
with no uuids, a `source` that names something other than a fork.

## The hook closes it, through the ordinary path {#hook-closes-the-fork}

The managed Claude hook already runs on `SessionStart`, `CwdChanged`,
`UserPromptSubmit` and `PostToolUse`. The fork check runs on:

- `SessionStart`, unless `source` is present and names something other than
  `fork`. A build that sends no `source` is still checked, because the field's
  absence says nothing about whether this is a fork.
- `UserPromptSubmit`, unconditionally and idempotently. It is the backstop for
  a copy that lands after `SessionStart` ran, and it still fires before the
  prompt reaches the model.

On a match the hook adds the new id by running `hyp session ignore` in this
same install, so the fork lands in the persistent marker and in the in-memory
set of every live recorder by exactly the path a hand-typed opt-out takes
(LLP 0256 #cli-posts-to-both). Nothing about the opt-out is reimplemented in
the hook, and the fork gets a fingerprint of its own on the way through.

Hooks cannot block a session on either client. Arriving before the first
exchange is what is possible and what hyparam/hypaware#1891 asks for; it is not
a guarantee that the fork never starts.

**Cost on the ordinary path is two syscalls**: one `stat` (is this session
already excluded) and one directory read that stops at its first entry (has
anything ever been excluded). The transcript is read, and the CLI spawned, only
for a session that is neither - so a machine that has never excluded anything
pays a `readdir` of a directory that does not exist, and an already-excluded
session pays one `stat`. Both are far below the two `git` subprocesses the same
hook already spawns per event.

## The receipt says which {#receipt}

`hyp session ignore` printed one blanket sentence: a fork "mints a new session
id it no longer covers". That is now a per-session fact, so the verb states
which of the two happened for this id: fork protection armed, or **UNCONFIRMED**
because no client transcript is on record for it (a Codex container, an id
typed by hand, a Claude session whose managed hook never ran). The
machine-readable receipt carries the same answer as `fork_protection`, because
a `--json` caller is as exposed to an unconfirmed fork as a human reader is.

Silence would read as the armed case, which is the fail-open shape the rest of
this verb exists to avoid. A failure to fingerprint is never a failure to
ignore: the marker is already written and the exclusion stands.

## What this does not do {#scope}

- **Content recorded before the ignore is not purged.** Unchanged from
  LLP 0403.
- **A fork made before its parent was ignored is not retroactively excluded.**
  The fingerprint is written when the opt-out is taken; a copy that already
  exists under its own id is a separate conversation to the store.
- **The Codex lane is not here.** hyparam/hypaware#1891 also specifies a
  `SessionStart` hook installed into Codex's `hooks.json` by attach, reversed
  by detach, keying on `session_meta.forked_from_id` / `parent_thread_id`. That
  lane needs a second managed-file perimeter on a client whose attach probe is
  single-file today, and its match key has a container-versus-thread grain that
  no fixture on this machine can settle. It is deliberately left to its own
  change rather than landed unproven, and remains open.
- **Other clients are unchanged.** OpenCode, Cursor and OpenClaw forks, where
  they exist, are outside this document.

## Verification {#verification}

Traditional tests cover the store and the lane end to end: a directory of
markers and fingerprints loading while any other filename is still corruption;
fingerprint bytes counted against the ceiling; `unignore` removing both files;
any-match across a fork chain; and the false-positive direction, which is given
its own case because wrongly ignoring a session destroys capture silently.

The lane tests drive the real verb against a real control route over a real
`SessionIgnoreSet`, then the real managed hook against a forked transcript, and
assert the fork's id is in the live recorder's drop set and on disk before
anything of the fork is recorded.

Real-client behavior is an acceptance concern: only a real
`claude --fork-session` can establish that the copy still carries the parent's
uuids and that the installed hook still receives `source: "fork"`. The
`claude_otel_shape_check` procedure is the existing release gate against that
kind of upstream drift.

**CPU and memory.** Live capture is untouched: the drop is still an O(1) `Set`
lookup over id markers, and a fingerprint never enters that set. The write side
adds one bounded transcript head read (64 KiB, capped by bytes rather than by
line count so a large early tool result cannot widen it) and one directory walk
per opt-out, which is a person-initiated action. The hook's ordinary path is two
syscalls, and the match walk streams the directory with one small file in memory
at a time rather than materialising every fingerprint.

The one cost that grows with data volume is the match walk itself: it reads
every stored fingerprint, so a machine at the store's 10,000-id ceiling reads
10,000 few-hundred-byte files per checked event. That is bounded by the same
ceiling the markers are, runs at human prompt cadence rather than per message,
and is still below the two `git` subprocesses the same hook already spawns. An
index over the fingerprints would remove it and is not worth the second file to
keep consistent at the sizes this is actually used at.

Writing a fingerprint is refused when it would push the directory past the
4 MiB the loader enforces. The point is not the fingerprint: overshooting would
make the next load refuse the **whole** store, which disables capture
everywhere, so the bounded walk that write costs buys the difference between
"this fork is not covered" and "nothing records at all".
