# LLP 0160: a refused workspace substitution is an ancestor test, not a byte test

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-30
**Related:** LLP 0049, LLP 0050, LLP 0069, LLP 0083

> The Codex live projector reports
> `plugin.codex.usage_policy_workspace_cwd_refused` only when the substituted
> `workspaces` key lies **outside the in-band `cwd`'s ancestor chain**, not
> whenever the two strings differ. An ancestor key cannot have changed the
> `.hypignore` verdict, so refusing it is not a refusal worth a `warn`. The test
> is the shared `isEqualOrDescendant`
> ([LLP 0069 R8](./0069-local-only-dir-selection.spec.md#requirements)), not a
> second copy of the path rule.

## Context {#context}

[LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md#decision) decided that
a substituted `workspaces` key never decides the `.hypignore` verdict: an
explicit in-band `cwd` outranks it for both the gate and the stamp, and the
discarded guess is reported rather than dropped silently. It named the signal and
its `error_kind`; it did not state the predicate, which lived only in the code:

```js
refused_workspace_cwd: workspace && inBandCwd && !pathsEqual(workspace.path, inBandCwd)
```

`pathsEqual` is byte equality after a trailing-slash trim. So the completely
ordinary shape "a session running in a **subdirectory** of its declared
workspace" tripped it, on every single turn, with both directories clean and no
`.hypignore` anywhere. Verified on the merged projector: `workspaces = {/work/proj}`
with an in-band `cwd` of `/work/proj/sub` records the row and emits one `warn`
per exchange, where the same session emitted none before LLP 0083's amendment
landed (#481).

That is not a cosmetic complaint. A privacy `warn` that fires constantly on the
common case is read as noise, and the other signals at this seam
(`usage_policy_cwd_unusable`, `usage_policy_drop` on a fail-safe clamp) are read
as noise with it.

## Decision {#decision}

**The key is refused only when it lies off the in-band `cwd`'s ancestor chain.**

The justification is not "a subdirectory is close enough". It is that in the
ancestor case the two verdicts are **ordered**, so the refusal is provably
harmless:

- The `.hypignore` walk from the `cwd` passes through the key and continues
  above it, so every governing file the key would have found, the `cwd` finds
  ([LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)).
- Every machine-local entry that governs the key also governs the `cwd`, because
  membership is equal-or-descendant and the `cwd` is a descendant of the key
  ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)).

So `resolve(cwd)` is at least as restrictive as `resolve(key)` would have been:
taking the `cwd` can only tighten. Nothing was lost, so nothing is reported.

Off the ancestor chain the two walks are **incomparable**, and both directions
matter:

- a **sibling** tree, the original #476 shape: a guess about a directory the
  session never ran in;
- a key **below** the `cwd`, whose own walk covers strictly more, so preferring
  the `cwd` there can genuinely loosen the verdict.

Those still warn, at `warn`, which is now a level the signal earns.

**Demoting to `info` was the alternative** and is rejected: it would have made
the genuinely interesting case quiet too, to fix a frequency problem that is
really a predicate problem. Narrowing the predicate fixes both, and leaves the
symmetry with `usage_policy_cwd_unusable` (#474) intact, since that sibling also
fires only on values that are actually unusable.

**Lexical, not spelling-agnostic.** The comparison trims trailing slashes on both
sides (the one normalization the byte test already did) and does nothing else.
The spelling-agnostic predicates next door - `scopeGoverns`, `sameDirectory`
([LLP 0050 §canonicalization](./0050-ignore-enforced-in-adapters.decision.md#canonicalization))
- buy their extra reach with `realpath` syscalls, and this runs once per
exchange on the capture hot path, which
[LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements) keeps free of
unbounded fs work. The residue is that a symlinked spelling of the same tree
still reads as a refusal. That is the status quo, it errs toward reporting rather
than toward silence, and it is the same gap
[LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md#decision) already files
as #479.

## What this does not decide {#not-decided}

The second finding deferred from PR #477 is **untouched here**: a row recorded
where it used to drop (clean in-band `cwd`, declared workspace that is itself
`.hypignore`-ignored) still carries that workspace's identity - its path, its git
remote, its head sha - through the key's surviving enrichment role. Only identity
leaks, never content, and the ignored directory's own sessions still drop. Whether
to suppress enrichment sourced from a key that resolves to `ignore`, at the cost
of a second resolver lookup and of graph-bridge identity for genuinely multi-root
sessions ([LLP 0032 §capture](./0032-github-llm-graph-bridge.decision.md#capture)),
is a privacy-relevant default that this document does not take. It stays open
under #481.

## Corrections to LLP 0083 {#corrections-0083}

Recorded here rather than by editing an Accepted record.

Its "an unusable in-band `cwd` is a miss" bullet says that *"on the Codex route
the value the predicate sees is usually not the request's `cwd` but the workspace
key `selectCodexWorkspace` selected for it ... so an absolute-but-unrelated
directory can still reach the gate (#476)"*. Since that document's own amendment
landed (PR #477), `usableInBandCwd` sees the request's `cwd` whenever the request
states one. The residual case is narrower than the sentence: **only** a request
that states no `cwd` at all lets a substituted key reach the gate, which is the
open #480 ranking question, not #476.

## Consequences

- `hypaware-core/plugins-workspace/codex/src/exchange-projector.js` carries the
  predicate as `workspaceCoversCwd`, annotated `@ref LLP 0160#decision` and
  `@ref LLP 0069#requirements` for the shared-matcher reuse.
- Pinned by two tests in `test/plugins/codex-exchange-projector.test.js`, over
  real directories and the real shared resolver: an ordinary
  subdirectory-of-workspace session logs no refusal; a sibling key and a key
  below the `cwd` both still do.
- No row, schema, gate, or drop behaviour changes. This is purely which
  exchanges emit one log line.
