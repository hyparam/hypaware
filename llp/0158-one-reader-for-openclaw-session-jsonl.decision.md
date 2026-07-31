# LLP 0158: one reader for the OpenClaw session JSONL

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-30
**Related:** LLP 0003, LLP 0027, LLP 0144, LLP 0150, LLP 0157, LLP 0159

> OpenClaw writes one JSONL file per session under
> `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`. Two consumers
> are about to read it for identity and policy decisions: the settlement
> enricher (LLP 0144 names it as the native-identity path) and the backfill
> provider (LLP 0157). LLP 0150 already showed what happens when two callers
> hold their own copy of non-obvious read rules for a session header: the
> copies drift and privacy controls answer wrong, silently. State the rules
> once, in one shared reader, before the second caller exists.

## Context

The OpenClaw session file's first line is a header record:
`{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"..."}`
(verified against live files on this machine, 2026-07-30). Subsequent lines
carry `model_change`, `thinking_level_change`, `custom`, and `message`
records.

A `message` record is **two levels deep** (verified against a live
`~/.openclaw/agents/main/sessions/<id>.jsonl`, 2026-07-31, issue #543). The
record line states only what identifies and positions the message,
`['id', 'message', 'parentId', 'timestamp', 'type']`; the message itself is
the nested `message` object, whose assistant-turn keys are
`['api', 'content', 'idempotencyKey', 'model', 'provider', 'role',
'stopReason', 'timestamp', 'usage']`. `usage` is OpenClaw's own
normalization: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`,
`cost`.

Two HypAware consumers need this file:

- The **settlement enricher** upgrades committed-at-flush live rows from
  gateway fallback identity to native identity (LLP 0144 Consequences, the
  LLP 0027 pattern). It needs the header's session id and the per-message
  ids, and it feeds the `.hypignore` gate with the header's `cwd` when the
  live row captured none.
- The **backfill provider** (LLP 0157#backfill) projects whole sessions
  from the same file. It needs the same fields for the same reasons, plus
  the message stream.

The read rules are not obvious, and each one exists because the naive read
answers wrong:

1. The header must be `type: "session"`; other record types must not be
   accepted as a header even if they carry plausible fields.
2. Absent, non-string, and blank-after-trim fields read as absent; the
   reader never substitutes one field for another.
3. A `cwd` that is not an absolute path reads as absent, because the value
   is consumed by `path.resolve` in the policy matcher and a relative value
   silently resolves against the daemon's own process cwd
   (LLP 0150#usable-cwd states the full argument; it transfers unchanged).
4. The header read is a bounded prefix read of line 1, so the hot settle
   path never pays for a large transcript (LLP 0049 R6's affordability
   argument, applied as LLP 0150#bounded applies it).
5. A message's fields are read from the nested `message` envelope, with the
   record line as the fallback, never the other way round. This is the rule
   that reads wrong most quietly: read one level too high, every field is
   simply absent, and absence is a legal answer everywhere downstream.
   `provider: undefined` resolves to `unknown`, the backfill allowlist
   excludes it fail-closed, and the run reports a clean `0 rows` for a
   session it never managed to read (#543). A parse miss and an intended
   exclusion are indistinguishable at that seam, so the address has to be
   right in the reader.
6. The fallback is per FIELD, not per record, and rule 3's present-value
   test runs at BOTH levels before it decides. A record does not have to
   nest nothing to read something off the line; it only has to state that
   one field nowhere else. And a nested value that reads as absent (blank,
   wrong-typed, `null`) cannot also be the value that suppresses the line:
   that would make one value absent and load-bearing at once. A nested
   `provider: "  "` beside a line-level `provider: "anthropic"` would
   otherwise resolve the record to `unknown` and lose it fail-closed, and a
   nested `timestamp` that does not parse would drop `message_created_at`,
   which re-dates the row to session start, defeats the `--since` window
   (a timestamp-less item is kept unconditionally), and puts the settlement
   ordinal match outside every window so the turn never dedupes. Same
   silent-drop family as #543, one level down.
7. `id` is the one field read line-first, envelope-fallback, because it is
   identity rather than content: the record line is where this document
   verified message identity lives, and the nested envelope is OpenClaw's
   normalization of a provider response. A version that started copying the
   provider's own `msg_...` id into the envelope would, under rule 5,
   silently repoint every `message_id` and therefore every `part_id` that
   backfill and settlement agree on (LLP 0157 R11); already-committed rows
   would stop deduping against new ones and the history would double with
   nothing raised. The envelope stays the fallback, so a record that states
   identity only there still resolves one.

LLP 0150 documented two shipped bugs (#453, #459) caused by exactly this
shape: two modules holding copies of the same session-header rules for the
Codex rollout. One difference matters for placement, though: 0150's two
callers lived in two different plugins, so the shared statement had to
cross a plugin boundary and core was the only legal home
(LLP 0150#placement, LLP 0003#principle). Here both callers live in the
same `@hypaware/openclaw` package, and the corpus precedent for that case
is plugin-local: Claude's full transcript reader
(`claude/src/transcripts.js`) and Codex's full rollout reader
(`codex/src/backfill.js`) are plugin modules; only the minimal first-line
slice two plugins needed was promoted to `src/core/codex/`.

## Options considered

1. **Each caller parses the file itself.** Rejected: this is the
   pre-LLP-0150 state for Codex, which demonstrably drifted and shipped
   wrong answers to privacy questions twice.
2. **One reader in core now (`src/core/openclaw/`).** Rejected while no
   consumer crosses a plugin boundary: it puts a client format in core
   without the cross-plugin justification LLP 0003 asks for, and deviates
   from the Claude/Codex precedent of plugin-owned format readers.
3. **One shared module inside `@hypaware/openclaw`, every rule stated in
   it, both callers consume it; promote the minimal shared slice to core
   if a second plugin ever needs it.** Chosen.

## Decision

- One module in `@hypaware/openclaw` owns parsing of the OpenClaw session
  file. It exposes a bounded header read returning
  `{ sessionId, cwd, startedAt }`, each field present only when the header
  states it as a non-blank string, with the absolute path predicate
  applied to `cwd`, and a full-transcript iteration for the consumers that
  need the message stream.
- The promotion trigger is named now so it is not relitigated later: the
  day a consumer outside `@hypaware/openclaw` needs any of these reads
  (the obvious candidate is `hyp session` in `@hypaware/ai-gateway`
  learning to resolve OpenClaw sessions for per-session opt-out), the
  needed slice moves to `src/core/openclaw/`, following the
  `src/core/codex/` precedent, rather than being lent across the plugin
  boundary (LLP 0150#placement).
- The `cwd` predicate is shared with (or identical in behavior to) the
  Codex one, so "no usable cwd" means the same thing at every site that
  feeds the `.hypignore` gate.
- The reader normalizes every field whose *address* is non-obvious, `role`
  and `content` included, rather than leaving them to callers to pick out of
  the raw record. The raw record line stays exposed for genuinely
  caller-specific fields, but "reach into `record` for a message field" is
  not a supported read: both callers did exactly that for `role`/`content`,
  both reached one level too high, and both dropped every real session
  (#543). A field two callers must locate identically is the reader's.
- The settlement enricher and the backfill provider both consume this
  reader. A future consumer that re-derived the fields for itself would be
  the same defect LLP 0150 removed, in a new place.
- The invariant is tested once in core, with each caller keeping a short
  test pinning the rules at its own seam, following the LLP 0150
  Consequences test shape.
- **Fixtures are path-faithful or they prove nothing.** Every test that
  writes a session file writes the real two-level record shape, through one
  helper per suite, so no fixture can quietly re-invent a flat envelope.
  The suite that shipped #543 was green throughout: it asserted a reader
  that read flat against a fixture that wrote flat, and neither was a
  session file OpenClaw ever produced.

## Consequences

- No client format lands in core this time; the plugin owns its own file
  format, and the anti-drift goal is met by there being exactly one copy
  in one package.
- The reader is the natural home for format-version handling. The header
  carries `version` (3 at time of writing); the reader is where a future
  version bump is detected and refused or adapted, once, for all callers.

## Open questions

- Does OpenClaw append transcript lines in real time, or buffer them until
  session end? The settlement enricher's match rate at flush depends on the
  answer; verify against OpenClaw source before relying on it
  (LLP 0159 carries the consequence either way).
- Do OpenClaw subagent runs write their own session files, and if so does
  the header record a parent session? Affects lineage attribution, not
  correctness of this reader.

## References

- LLP 0003, 0027, 0049, 0144, 0150, 0157, 0159
- `src/core/codex/rollout_session_meta.js` (the precedent shape)
- `openclaw` repo: session files under `~/.openclaw/agents/<id>/sessions/`
