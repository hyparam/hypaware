# LLP 0506: Codex repository enrichment needs a covering, unignored workspace key

**Type:** Decision
**Status:** Active
**Systems:** Plugins, Gateway, Usage-Policy, Privacy
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0032, LLP 0049, LLP 0050, LLP 0083, LLP 0160, LLP 0350;
hyparam/hypaware#1189, hyparam/hypaware#492, hyparam/hypaware#1194,
hyparam/hypaware#1202

> Extends [LLP 0083 §workspace-key-ranks-last](./0083-codex-live-cwd-from-rollout.decision.md#workspace-key-ranks-last)
> and [LLP 0160 §not-decided](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#not-decided)
> with the call [LLP 0350](./0350-codex-workspace-enrichment-is-capture-evidence.rfc.md#decides)
> asked for: options **(B) and (C)**, taken together (Phil, 2026-10-05, on
> #1189). Both earlier documents are settled, so the rule lands here and each
> carries a forward-ref to it.

## Context

LLP 0083 kept a `workspaces` turn-metadata key's **enrichment role**
(`git_remote`, `head_sha`, and the `attributes.codex` mirrors `workspace`,
`git_origin_url`, `git_commit`, `has_changes`) even after demoting the key to
the last-resort `cwd`. The key was chosen against the **in-band** `cwd` only,
falling back to the first-listed key. Two leaks followed, both verified on
master against the real projector and the real usage-policy matcher:

- **No covering key.** On the API-key route a request whose `cwd` no key
  covers took the first key's identity anyway. On the subscription route, which
  states no in-band `cwd`, the covering test never ran at all, so the
  first-listed key enriched even when the rollout `cwd` sat under a different,
  clean key (#1202 item 1). With an ignored directory listed first, the row
  carried that repository's remote, which under `inventory = "session_repos"` is
  admitted evidence authorizing GitHub capture of a repository the user marked
  `ignore` (LLP 0350 §evidence).
- **Ignored covering ancestor.** A key that covers the `cwd` but itself resolves
  `ignore`, beneath a nested `local-only` loosening that admits the row,
  enriched it with the ignored tree's identity (#1202 item 2, #492, #1194).

## Decision {#decision}

Repository enrichment comes only from a `workspaces` key that **covers the
resolved `cwd`** and **does not itself resolve `ignore`**. Otherwise the row
carries none of `git_remote`, `head_sha`, `attributes.codex.workspace`,
`git_origin_url`, `git_commit`, or `has_changes`.

- **Selection is against the resolved `cwd`.** The key is chosen by
  `nearestCoveringWorkspace` against the `cwd` the call site resolves (in-band,
  then rollout, then key, unchanged from LLP 0083), not against the in-band
  value alone. The nearest covering key wins, so map order no longer decides.
- **Covering is LLP 0160's ancestor test,** the same `workspaceCoversCwd`
  predicate the refusal diagnostic uses. A key that is an ancestor of the `cwd`
  (or the `cwd` itself) covers; a sibling or a descendant does not. A symlinked
  spelling that misses is "nothing covers", so the row goes unenriched: the
  safe side of the miss.
- **The ignore check is the shared resolver** over the selected key's path
  ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)), most
  restrictive wins as everywhere else. Only `ignore` withholds; `local-only`
  enriches, because the row is already governed by its own `cwd`'s class.
- **Only those six fields.** The row, its `cwd`, and the rest of the `codex`
  namespace (conversation identity, client provenance, lineage per
  [LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md)) stay.
  No column is added and no repository root is inferred from the `cwd`.
- **The drop is unchanged.** Whether the exchange is recorded is still decided
  by the resolved `cwd` alone ([LLP 0049 §scope](./0049-hypignore-usage-policy.spec.md#scope)).
  This decision changes what an admitted row carries, never whether it is
  admitted.
- **The withhold is observable and path-free.** Each withheld row logs
  `plugin.codex.workspace_enrichment_withheld` at info with
  `reason: not_covering | workspace_ignored` and the exchange id. It carries no
  path, raw or hashed: the reason is the whole diagnosis, and the paths involved
  are the ones the user may have asked us not to record.
- **The last-resort `cwd` is unchanged.** When neither the request nor a
  rollout supplies a `cwd`, the key still supplies it, and since it then covers
  itself it still enriches unless it is ignored (in which case the exchange
  drops anyway).

The rule is scoped to the Codex live projector. The Claude adapter derives
`git_remote` from a source it does not guess, so LLP 0350's general question is
answered for Codex only.

## Not covered {#not-covered}

- **Rows already projected.** Nothing rewrites history: rows written before
  this lands keep whatever enrichment they carried.
- **The Codex backfill** (`backfill.js`) stamps `workspace` and
  `git_origin_url` from the rollout's own `session_meta`, which describes the
  directory the session ran in rather than a guessed key. It is not a
  substitution and is out of scope here.
- **#1202 item 3** (a relative `cwd` matching a relative key silences the
  refusal diagnostic) is declined: the row it affects is refused at the gate
  anyway, so the cost is one missing log line.

## Cost {#cost}

One extra cached `resolve()` per admitted row whose covering key is not the
`cwd` itself. The resolver's TTL cache is keyed by path, so it grows by at most
one entry per distinct covering ancestor, and a hit does no filesystem work.
The rollout lookup stays lazy and is unchanged: enrichment is computed after
the `cwd` is resolved, from the same context.

## Corrections to LLP 0083 {#corrections-0083}

Its §workspace-key-ranks-last says "the key keeps its enrichment role"; that
role now holds only under the rule above. The same bullet's parenthetical "it is
also why `pathsEqual` misses symlinked spellings here" names a helper PR #1198
deleted; the symlink limit it describes now lives in `workspaceCoversCwd`,
where a miss withholds enrichment (#1202 item 4).

## Consequences

- `hypaware-core/plugins-workspace/codex/src/exchange-projector.js` carries the
  rule as `codexRepoEnrichment`, annotated `@ref LLP 0506#decision`.
  `resolveCodexContext` no longer enriches; it returns the raw `workspaces` map.
- Pinned in `test/plugins/codex-exchange-projector.test.js` and
  `test/plugins/codex-rollout-cwd.test.js` over real directories and the real
  shared resolver: no covering key, a clean covering key in both map orders, an
  ignored unrelated key, an ignored covering ancestor in both orders, the
  subscription route choosing the key that covers the rollout `cwd`, and the
  last-resort key.
