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
> whenever the two strings differ. An ancestor key was never a *guess about where
> the session ran*, so declining to substitute it is not a refusal worth a `warn`.
> It is **not** that an ancestor key could not have changed the verdict: it can
> (see [§decision](#decision)), and that is disclosed, not claimed away. The test
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
and `ignore`->`full`. The two source-pure slices are the stable part and
reproduce exactly (50 from `.hypignore` alone, 75 from the list alone, 256 cases
each); the remainder depends on how the mixed slice is enumerated, so treat 131
as "on the order of a fifth of the space", not as a constant of the resolver.

That is accepted rather than overlooked, and the ground is that **the warn being
removed never carried the information in the first place**. It has no class
field: on `master` the same `plugin.codex.usage_policy_workspace_cwd_refused`,
with an identical field set, fires on a subdirectory session with no `.hypignore`
anywhere, on one where key and `cwd` both resolve `ignore`, and on the loosening
arrangement above. All three were run through the real projector. A reader could
never have told a loosening from an ordinary subdirectory turn by this signal, so
silencing it on the ancestor chain removes no privacy information: it removes a
constant. What is lost is only this signal's *appearance* of doubling as a
verdict-change detector, which it never was, because it fired on string
difference, not on verdict difference. A real detector would have to compare
`resolve(key)` with `resolve(cwd)` directly; that is a different signal, it costs
a second (TTL-cached) resolver lookup, and it is deliberately **not** taken here.

**On whose declaration does the loosening.** In every measured arrangement the
declaration that governs the `cwd` sits *strictly below* the key, so it is always
a nested declaration, which is exactly what nearest-governs exists to honour
(`selectGoverning` calls it "a nested loosening"). Whether that nested
declaration is always the **user's own** is narrower than it looks, and worth
saying rather than assuming:

- A machine-local list entry, which is the only source that can reach an explicit
  `full` and so the only one behind the `local-only->full` and `ignore->full`
  transitions, has exactly two writers in the tree, both `runMarkMachineLocal`
  and `runUnmarkMachineLocal` behind the `hyp ignore` / `hyp unignore` /
  `hyp policy set|unset` verbs. Nothing central, layered or org-pushed can write
  one, which [LLP 0071 §not-central](./0071-machine-local-exclusion-list.decision.md#not-central)
  makes doctrine. So those transitions really are the user's own answer. (The one
  indirection: on the LLP 0106 classification path an agent runs `hyp policy set`
  on the user's behalf, and nothing verifies the human was actually asked.)
- A `.hypignore` is by design a **committable** file
  ([LLP 0071 §not-dotfiles](./0071-machine-local-exclusion-list.decision.md#not-dotfiles)), and
  the ancestor walk has no vendored-tree exclusion. So the `ignore->local-only`
  transition can be driven by a `.hypignore` that arrived inside a dependency, a
  submodule or any other cloned tree, authored by someone other than the user.

The second case is bounded twice over: the walk only ever goes *up*, so a
vendored file governs only sessions at or under it and can never reach the parent
project, and `.hypignore` cannot express `full`
([`format.js` `IMPLEMENTED`](../src/core/usage-policy/format.js)), so the worst a
third party can do is downgrade a subtree from `ignore` to `local-only`, never
re-enable forwarding. It is also a property of nearest-governs that predates this
document and is unchanged by it: the row records as `local-only` either way, on
`master` and here alike. Only the constant `warn` differs, and per the paragraph
above that `warn` could not have told anyone about it. Whether a third-party
`.hypignore` should be able to loosen a tree the user marked `ignore` is a
resolver question, not a reporting one, and belongs in LLP 0049/0070 rather than
here.

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
