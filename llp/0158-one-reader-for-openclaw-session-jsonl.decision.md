# LLP 0158: one reader for the OpenClaw session JSONL

**Type:** Decision
**Status:** Draft
**Systems:** Core, Plugins, Sources, Usage-Policy
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
> once, in one core reader, before the second caller exists.

## Context

The OpenClaw session file's first line is a header record:
`{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"..."}`
(verified against live files on this machine, 2026-07-30). Subsequent lines
carry `model_change`, `thinking_level_change`, `custom`, and `message`
records; each `message` envelope has its own short id, a timestamp, and for
assistant messages the `model`, `provider`, `api`, `stopReason`, and full
`usage` (tokens and cost).

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

LLP 0150 documented two shipped bugs (#453, #459) caused by exactly this
shape: two modules holding copies of the same session-header rules for the
Codex rollout. The placement argument there
(LLP 0150#placement, resting on LLP 0003#principle) also transfers: the
enricher lives in the `@hypaware/openclaw` plugin, the backfill provider in
the same plugin but on a different seam, and `hyp session` or other core
surfaces may join later; none of them owns the format for the others.

## Options considered

1. **Each caller parses the file itself.** Rejected: this is the
   pre-LLP-0150 state for Codex, which demonstrably drifted and shipped
   wrong answers to privacy questions twice.
2. **The plugin owns the reader and lends it out.** Rejected for the
   reasons LLP 0150#placement rejected it: a private plugin module is not
   a boundary other plugins or core can import across (LLP 0005), and
   single-caller ownership is what makes drift cheap.
3. **One reader in core, every rule stated in it, both callers consume
   it.** Chosen. `src/core/openclaw/` mirrors `src/core/codex/`.

## Decision

- One core module (`src/core/openclaw/`, sibling of `src/core/codex/`)
  owns parsing of the OpenClaw session file. It exposes a bounded
  header read returning `{ sessionId, cwd, startedAt }`, each field present
  only when the header states it as a non-blank string, with the absolute
  path predicate applied to `cwd`, and a full-transcript iteration for the
  consumers that need the message stream.
- The `cwd` predicate is shared with (or identical in behavior to) the
  Codex one, so "no usable cwd" means the same thing at every site that
  feeds the `.hypignore` gate.
- The settlement enricher and the backfill provider both consume this
  reader. A future consumer that re-derived the fields for itself would be
  the same defect LLP 0150 removed, in a new place.
- The invariant is tested once in core, with each caller keeping a short
  test pinning the rules at its own seam, following the LLP 0150
  Consequences test shape.

## Consequences

- A client's on-disk format lands in core again. As with LLP 0150, the
  narrower cost is accepted: one bounded, read-only parse of one product's
  session file, versus a privacy invariant stated twice.
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
