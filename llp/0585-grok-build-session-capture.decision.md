# LLP 0585: Grok Build session capture

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Sources, Backfill, Config, Privacy
**Author:** Kenny
**Date:** 2026-11-05
**Related:** LLP 0045, LLP 0359, LLP 0399, LLP 0403, LLP 0551

## Capture {#capture}

Grok Build follows the Factory Droid shape (LLP 0551): a native hook signals a
changed session to a loopback listener, a five-minute sweep repairs misses, and
both lanes share one reader and the projected exchange writer. The proxy is not
required, and a custom `base_url` would not see subscription traffic anyway. The
hook sends only the session id and transcript path.

## Format evidence {#format}

Read from the Apache-2.0 source at `xai-org/grok-build` commit `2bdd1d6`, then
checked against Grok 1.0.70 (see verification). Sessions live at
`$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`. The source of record is
`updates.jsonl`, which Grok's own docs call authoritative. `chat_history.jsonl`
has no timestamps and is rebuilt from it, so it is not read.

Each line is `{timestamp, method, params: {sessionId, update, _meta}}` with
`update.sessionUpdate` naming the kind. `summary.json` supplies `info.id`,
`info.cwd`, `current_model_id`, `parent_session_id` and `session_kind`. It may be
absent early on, so the directory names stand in for id and cwd, with the
bucket's `.cwd` file for long hashed names. Dot directories are relocation
staging and are skipped.

The hook envelope carries `sessionId` and `transcriptPath`, the latter only once
`updates.jsonl` exists. Hook files read only their top-level `hooks` key, so the
`_hypaware` marker is inert.

## Folding {#folding}

Text arrives as chunks, and a tool call as a lifecycle across lines. A message is
the run of same-kind chunks in one prompt, or a tool call plus its terminal
update. An item stays open until a later update settles it, and the cursor holds
before the earliest open line, so a re-read rebuilds identical messages. A
new prompt or `turn_completed` closes what is open, and a file quiet for five
minutes settles the rest, torn last line included, which covers crashes. Only
user chunks name a model, so replies inherit the one in force, carried in the
cursor. A shell command that exits non-zero is `completed` to Grok and an error
here. Tool results keep placeholders for binary content. Output with `hostTurn` is
display-only slash-command text and is dropped.

## Identity {#identity}

Message IDs hash the session id and the origin line, and `message_index` is that
line. Line numbers survive replay, batching and torn lines. `_meta.eventId` is
not used because it is missing on old lines and a fork interleaves two counter
epochs. The cwd is left out because a session can relocate. Forks are separate
conversations.

The file is append-only, including across rewinds and compaction, so dead
branches remain recorded. Turn usage on `turn_completed` is not projected: the
projected message has no usage field and the totals span several model calls.

## Lineage {#lineage}

A fork names its parent in `summary.json` and copies the parent's log. A subagent
names no parent at all: its `session_kind` starts with `subagent`, and only the
parent's `subagents/<child>/meta.json` records the link, so the reader looks there,
own bucket first, and remembers what it finds. A fresh subagent with no link yet
waits, because rows are written once; after five idle minutes it is recorded
without one. Exclusions check the whole lineage, unlike other clients, because a
Grok fork carries its parent's content. `hyp session ignore` reads
`GROK_SESSION_ID`, which Grok gives its tools. Grok's git fields fill the existing
git columns, with remote userinfo stripped.

## Withheld {#withheld}

Unignore must not import what was written while ignored, but the ignore store
keeps only membership. So reading a session dropped by an exclusion saves the
file's size as a byte floor, and messages starting below it are never projected,
in any later read or manual import. Forks also apply the floors of the logs they
copied. A floor file exists only for sessions read while ignored. An unreadable
floor fails the read. Only exclusions set a floor: `.hypignore` keeps its existing
meaning. The floor depends on a read happening while ignored; each hook and sweep
is one, so only an unignore before the next one misses it.

## Bounds {#bounds}

Files cap at 256 MiB, lines at 16 MiB (inline images, whole tool outputs),
beyond which a line is skipped and still counted, batches at 64 messages or 1 MiB of source, and a folded run at 8 MiB. Discovery
caps at 100,000 entries without following symlinks. A live notification reads at
about 8 MiB, stopping there only once its cursor can move, so an open item cannot
stall it. The log is append-only, so a cursor with an intact 128-byte boundary is
trusted without rereading. Sweeps keep a success-only cursor per file and read only new bytes,
since Grok sessions run long and re-reading them every five minutes would scale
with history rather than activity; a scan reserves at most 256 MiB. Policy and
session ignores apply before projection and fail closed (LLP 0403).

## Attachment {#attachment}

Attach owns `.grok/hooks/hypaware.json` in Grok's hook directory, recording exact
entries under `_hypaware`, and keeps anything a user adds there. `GROK_HOME`
relocates it through the generic `<CLIENT>_HOME` rule. `PreToolUse`, the only
blocking event, is not registered.

## Coexistence {#coexistence}

Grok reads `~/.claude/settings.json` hooks by default, as Cursor does (LLP 0399),
and sets `GROK_HOOK_EVENT` on every hook process. HypAware's Claude context and
classification hooks exit early on that variable, so they cannot misattribute a
Grok session or sweep a Claude spool.

## Trailing read {#trailing-read}

Grok fires `Stop` before it writes `hook_execution` and `turn_completed`, so at
that notification the final reply is still open, and an interactive session sends
nothing more until its next prompt. The listener rereads each notified file once
it has been quiet for two seconds. At most 64 files wait, and the sweep repairs
anything beyond that.

## Verification {#verification}

Deterministic tests and the `grok_capture` smoke cover folding, incremental
convergence, recovery, windows, ignore policy, attach and detach, and the
installed hook over real HTTP.

On 2026-11-05, Grok 1.0.70 on macOS arm64 was run signed in, against real
sessions. That confirmed the layout, `summary.json`, the update kinds, and that
modelId, promptIndex and hostTurn sit on `update._meta` while timing sits on
`params._meta`. A temporary hook file carrying a `_hypaware` key loaded and fired
on SessionStart, PostToolUse, Stop and SessionEnd, with `transcriptPath` absent
only on SessionStart, and with `GROK_HOOK_EVENT` set. Fixtures keep that shape
with synthetic text. 
A second pass drove real sessions through a live daemon and installed hooks,
including an interactive session, fork, subagent, rewind, compaction, kill, image,
parallel runs and session ignore, comparing rows against `updates.jsonl`.
