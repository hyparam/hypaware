# LLP 0143: one reader for the Codex `session_meta` header

**Type:** Decision
**Status:** Active
**Systems:** Core, Plugins, Gateway, Sources, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0003, LLP 0045, LLP 0049, LLP 0066, LLP 0067, LLP 0083, LLP 0085

> A Codex rollout's first line, its `session_meta` header, is read by exactly
> one module: `src/core/codex/rollout_session_meta.js`. Two plugins ask it the
> same question to gate two privacy controls, the rules for asking it are three
> and non-obvious, and holding a copy each has already shipped the wrong answer
> twice. The reader states the rules once; both callers consume it.

## Context

Two modules read the header, for different fields, in service of the same kind
of decision:

- `@hypaware/codex`'s live cwd resolver (`codex/src/rollout-cwd.js`) wants
  `payload.cwd`, because the ChatGPT-subscription route carries no in-band cwd
  and `.hypignore` would otherwise fail open for the whole traffic class
  ([LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)).
- `@hypaware/ai-gateway`'s `hyp session` verb
  (`ai-gateway/src/session_command.js`) wants an id, because a hand invocation
  or a pre-`CODEX_THREAD_ID` Codex leaves the rollout as the only local record
  of which session this invocation is in
  ([LLP 0067 §cli-session-id](./0067-session-opt-out.design.md#cli-session-id)).

Both answers gate a privacy control, so a wrong one is **silent**: the verb
prints success for a drop that drops nothing, or `.hypignore` is evaluated
against a directory the user never named. It has happened twice, from two
copies of the same rule:

- [#453](https://github.com/hyparam/hypaware/issues/453): `hyp session ignore`
  stated a thread id the gateway drop never matched, reported success, and
  recording continued.
- [#459](https://github.com/hyparam/hypaware/issues/459): a subagent turn
  resolved the **root**'s cwd, so `.hypignore` was evaluated against the wrong
  directory.

By the time [#462](https://github.com/hyparam/hypaware/pull/462) was reviewed,
the two readers no longer agreed on which rules they enforced, and mutation
testing found survivors on exactly those predicates. That is drift observed in
progress between two files whose whole job is to agree.

## Decision

**One reader, in core, and every rule stated in it.**
`parseRolloutSessionMeta` / `readRolloutSessionMeta` return
`{ threadId, sessionId, cwd }`, each field present only when the header itself
states it as a non-blank string, and enforce three rules:

1. **The raw JSONL line is the input, never a deserialized struct.** Codex's
   hand-written `Deserialize` for the record back-fills `session_id` from `id`,
   so a struct read answers "the thread" to a question about the session
   container and looks confident doing it. Reading the line means an absent
   field reads as absent.
2. **`type` must be `session_meta`.** Other rollout records carry `id` and
   `cwd` in their payload too (`turn_context` does), so without the guard a
   rollout whose first line is one of them yields a plausible id that belongs
   to no session and a cwd that governs nothing.
3. **Unconfirmable is unresolvable.** Absent, non-string, and blank all read as
   `undefined`; a caller that needs the field refuses rather than substituting.
   In particular `sessionId` is never derived from `threadId`: the two are the
   same uuid for a root thread and different for a subagent thread, which is
   precisely how #453 and #459 went wrong. For `cwd`, "unconfirmable" also
   covers a relative path ([below](#usable-cwd)).

`sessionId` has no consumer yet on purpose. The verb still resolves the thread
id, matching `CODEX_THREAD_ID` and what the gateway stamps today; moving the
drop onto the session container is #453's job. The field is on the reader
because rule 1 exists **for** it: without it the "never back-filled" property
is unstated and untestable, which is the state that let it drift.

### Why core, and not one plugin lending it to the other {#placement}

The reader is Codex-format knowledge, so `@hypaware/codex` looks like its
owner. It is not, for two reasons. `@hypaware/ai-gateway` would have to import
another plugin's module internals to reach it, which is not a boundary the
plugin model has ([LLP 0005](./0005-plugin-manifest.spec.md): a plugin's
surface is what it `requires`, `provides`, and `contributes`, and a private
`src/` module is none of those). And ownership by one caller is what makes
drift cheap: the owner changes the rule for its own needs, and the borrower
finds out in production.

[LLP 0003](./0003-core-vs-plugin-surface.spec.md#principle) already answers
this: a behavior that would otherwise be copy-pasted into every plugin belongs
in core. The precedent is the partition-spec helpers, "promoted to a neutral
core home" because they are consumed across the boundary by several consumers
and owned by none of them
([LLP 0022 §shared-core-helpers](./0022-iceberg-export-partitioning.spec.md#shared-core-helpers)).
`src/core/codex/` is that neutral home here: core hosts the read, neither
plugin owns it, and both reach it by the same path
`src/core/backfill/scan_util.js` is already reached by.

This does put a client's on-disk format in core, which the boundary would
normally push into the adapter. That is the narrower cost: one bounded,
read-only parse of one line, versus a privacy invariant that provably will not
stay in step when it is stated twice.

### A relative `cwd` is not a usable container {#usable-cwd}

Rule 3 for `cwd` is stricter than "a non-blank string": the value must be an
**absolute** path, or it reads as absent. `sessionMetaCwd` is that predicate,
and it is exported because the codex backfill folds `turn_context.cwd` as a
fallback for the same field into the same gate, and so must answer the question
identically instead of keeping a looser copy.

The reason is that a `cwd` is not consumed as a string, it is consumed as a
directory that has to be found. The matcher's first act is `path.resolve(cwd)`
([LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope) walks upward
from there), and for a relative value `path.resolve` silently supplies the
**daemon's** process cwd as the base. A session whose header said
`../elsewhere` therefore gets a confident `.hypignore` verdict governed by a
file under wherever the daemon happens to have been started. Nothing on the line
says what the value is relative to, and the rollout's own location cannot stand
in for the missing base either: rollouts live under
`<CODEX_HOME>/sessions/YYYY/MM/DD/`, which has no relationship to where the
session ran. The base would have to be guessed, and rule 3 exists to forbid
exactly that.

Refusing is not a symmetric trade against accepting, which is why this is a
rule and not a judgement call:

- **Refusing** costs the ordinary "no cwd" fail-open: the row records
  `cwd = NULL`, the projector's `if (cwd)` skips the check, and that is a state
  the system already models and compensates for
  ([LLP 0049 R1](./0049-hypignore-usage-policy.spec.md#requirements) as extended by
  [LLP 0085](./0085-settlement-may-drop-late-ignore.decision.md)). It is also
  already the documented answer for an absent or unreadable rollout
  ([LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)).
- **Accepting** is wrong in *both* directions at once. It can drop a session no
  `.hypignore` covers (data lost), and - the failure this control exists to
  prevent - it can record a session whose real directory **is** ignored, because
  the verdict was computed for a different directory entirely. Worse than
  `cwd = NULL`, it also stamps a non-null bogus `cwd` on the row, so the value
  looks like a real answer to everything downstream that keys on cwd.

That is the same defect shape as [#459](https://github.com/hyparam/hypaware/issues/459)
(a verdict about a directory the session never named), reached through a
different field. The repo already applies this rule to the sibling case: a
client `settings_file` that resolves relative is refused rather than returned,
because handing it back "would return something re-resolved against
`process.cwd()` at read time instead of the value validated at call time"
([LLP 0045](./0045-client-attach.design.md)).

No legitimate rollout loses its `cwd`: Codex writes `session_meta.cwd` from the
process's own working directory, which is always absolute. And the `hyp session`
caller is unaffected either way, because it compares `meta.cwd` against an
absolute invocation cwd, so a relative value never matched; refusing only makes
that refusal explicit and earlier. Only `cwd` is path-tested - `threadId` and
`sessionId` are opaque provider tokens with no path semantics
([LLP 0066 R5](./0066-session-opt-out.spec.md)).

### Bounded, and part of the same contract {#bounded}

The bounded prefix read moves into the reader with the parse, rather than
staying duplicated at each caller. "Line 1 only, from a bounded prefix" is not
an optimization either caller chose independently: it is what makes this read
affordable on the live capture path at all
([LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements)), and a
truncated first line refuses like any other unparseable one rather than
resolving on half a record.

## Consequences

- The invariant is **tested once**, in `test/core/codex-rollout-session-meta.test.js`:
  the union of both callers' failure paths (legacy rollout with no `session_id`,
  subagent rollout, wrong envelope type, blank and non-string fields, an
  over-long or unreadable first line), with each guard mutation-checked to
  redden its own named test. Both callers keep a short test pinning the rules at
  their own seam, so a change cannot satisfy one caller and loosen the other.
- Blank now means blank-after-trim at every site that feeds the gate, not only
  at the two callers of the reader. The previous codex-side `stringValue` check
  accepted a whitespace-only `cwd` and handed it to the policy matcher as a
  path; the gateway side had the same latitude on its ids; and the backfill,
  which reads whole rollout files and so cannot delegate to a first-line reader,
  had it on `session_meta.cwd` and on its `turn_context.cwd` fallback. The
  backfill now shares the one `cwd` predicate (`sessionMetaCwd`) even though it
  keeps its own file walk, so the three sites cannot disagree about what "no
  cwd" means. The value that survives the test is still returned
  byte-identical, because these ids are opaque provider tokens
  ([LLP 0066 R5](./0066-session-opt-out.spec.md)) and a `cwd` is a path.
- **Still outstanding:** the live projector's *in-band* cwd
  (`x-codex-turn-metadata` / body `metadata.cwd`, LLP 0083's fast path) reaches
  the same `resolver.resolve` with no such predicate. It is a different source
  with a different trust story, and its value is also stamped on the row for
  workspace/git enrichment rather than only consulted for the gate, so tightening
  it is its own decision rather than a consequence of this one.
- Code that lands this carries `@ref LLP 0143` on the reader and on both
  callers' seams.
- Nothing about which id either caller *uses* changes here. This is the
  unification #462's review recommended and deferred; the id-grain questions
  stay with #453 and #459.
