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

The justification is not "a subdirectory is close enough", and it is **not** that
the two verdicts are ordered. It is that in the ancestor case the key is not a
*guess about where the session ran*: it names the same tree, less specifically,
and the `cwd` is strictly the better answer to the question the key was standing
in for. Under the resolver's nearest-governs rule the most specific declaration
is authoritative for the `cwd`, so the key never held authority over it. There is
no doubt about the location inference to report.

Off the ancestor chain the key names a tree the session **did not run in**, the
location inference is genuinely in doubt, and that is what the signal reports:

- a **sibling** tree, the original #476 shape: a guess about a directory the
  session never ran in;
- a key **below** the `cwd`, whose own walk covers strictly more, so preferring
  the `cwd` there can genuinely loosen the verdict.

Those still warn, at `warn`, which is now a level the signal earns.

**What this narrowing gives up, stated plainly.** The signal now answers "is the
location inference in doubt", not "could the verdict have differed". Those are
not the same question, because the resolver is **not** monotone down the ancestor
chain: nearest-governs means a declaration *between* the key and the `cwd`
overrides the key's, and it may be **less** restrictive. A `.hypignore` reading
`ignore` at the key with `local-only` at the `cwd`, or a machine-local entry
(LLP 0103) marking the key `ignore` and the `cwd` an explicit `full`, both
resolve the `cwd` *less* restrictively than the key - and both are now silent.
This was measured, not assumed: sweeping `.hypignore` bodies and list classes at
four depths along one ancestor chain against the real
`createUsagePolicyResolver`, **131 of 576** arrangements resolve the `cwd` less
restrictively than the key, spanning `ignore`->`local-only`, `local-only`->`full`
and `ignore`->`full`.

That is accepted rather than overlooked. In every such arrangement the loosening
is the user's **own nested declaration**, which nearest-governs exists to honour
(`selectGoverning` calls this "a nested loosening"), so the `cwd`'s verdict is
the intended one and no restriction the user asked for was lost. What is lost is
this signal's ability to double as a verdict-change detector, which it was never
reliable at: it fired on string difference, not on verdict difference. A detector
for "the substitution changed the verdict" would have to compare
`resolve(key)` with `resolve(cwd)` directly; that is a different signal, it costs
a second (TTL-cached) resolver lookup, and it is deliberately **not** taken here.

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
unbounded fs work. The residue is that this predicate reads paths, not
directories: a symlinked spelling of the same tree still reads as a refusal (a
spurious `warn`), and the converse also holds - a lexical descendant that is
really a symlink out of the key's tree reads as covered, so it stays silent. Both
were checked against the real projector. This is the gap
[LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md#decision) filed as
#479 for the **gate**, which #482/#484 have since closed there; it is knowingly
retained *here*, at this reporting-only predicate, for the hot-path reason above.
Nothing about the gate's own verdict depends on it: the resolver still resolves
over every spelling and still takes the most restrictive.

## What this does not decide {#not-decided}

The second finding deferred from PR #477 is **untouched here**: a row recorded
where it used to drop (clean in-band `cwd`, declared workspace that is itself
`.hypignore`-ignored) still carries that workspace's identity - its path, its git
remote, its head sha - through the key's surviving enrichment role. Only identity
leaks, never content, and the ignored directory's own sessions still drop. Whether
to suppress enrichment sourced from a key that resolves to `ignore`, at the cost
of a second resolver lookup and of graph-bridge identity for genuinely multi-root
sessions ([LLP 0032 §capture](./0032-github-llm-graph-bridge.decision.md#capture)),
is a privacy-relevant default that this document does not take. It is split out
of #481 (which this PR closes) and stays open under **#492**.

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
