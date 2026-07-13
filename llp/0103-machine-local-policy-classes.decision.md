# LLP 0103: machine-local usage-policy entries carry a class

**Type:** Decision
**Status:** Accepted
**Systems:** Usage-Policy, Config, CLI
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0049, LLP 0050, LLP 0069, LLP 0071, LLP 0100, LLP 0106

> The machine-local list ([LLP 0071](./0071-machine-local-exclusion-list.decision.md))
> stops being local-only-only: each entry names a **class**, `ignore` |
> `local-only` | `full`, making class and authoring surface orthogonal. A
> user can mark a directory "never recorded" without a `.hypignore` dotfile
> landing in the repo, and "asked and answered: syncs" becomes representable
> at all.
>
> @ref LLP 0071 [constrained-by] - the store stays machine-local, private, never merged with central config; this only widens what an entry can say.
> @ref LLP 0049#classes [implements] - the class vocabulary is 0049's, unchanged; this adds a second source, not a new class model.

## Context

The privacy flow ([LLP 0100](./0100-enrollment-privacy-review.spec.md)) needs
the skill to mark directories `ignore` without touching the user's working
trees, and the classification hook ([LLP 0106](./0106-session-start-classification-hook.decision.md))
needs to distinguish "user chose sync" from "never asked". Today neither is
expressible: the machine-local file is a bare dir list (implicitly all
`local-only`), and `ignore` has exactly one home, the committable
`.hypignore` dotfile ([LLP 0049](./0049-hypignore-usage-policy.spec.md)).
Every argument LLP 0071 made against dotfiles for `local-only` (the choice
is private; login and review flows must not mutate repos; candidate paths
may be non-repos or no longer exist) applies with equal force to a
review-driven `ignore`, and worse: a dotfile in a directory the user is
hiding *because it discusses coworkers* is a breadcrumb pointing at exactly
the sensitive thing.

## Decision

**The machine-local store becomes a class-per-entry map:**

```json
{ "version": 2,
  "entries": [
    { "dir": "/Users/phil/side-project", "class": "local-only" },
    { "dir": "/Users/phil/journal", "class": "ignore" },
    { "dir": "/Users/phil/work/app", "class": "full" }
  ] }
```

- **Version 1 files migrate on read**: a bare `dirs` array means every entry
  is `local-only`, exactly what those files meant when written.
- **`ignore` entries** are a second source into the shared resolver
  ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)), enforced at
  the capture seam like dotfile ignore. Composition stays
  most-restrictive-wins across sources
  ([LLP 0069 §neighbours](./0069-local-only-dir-selection.spec.md#neighbours)).
- **`full` entries** exist to record "asked; syncs". The resolver treats
  them identically to the implicit default; their sole consumer is the
  classification hook's "do we have settings for this folder?" check
  ([LLP 0106](./0106-session-start-classification-hook.decision.md)).
  The implicit default for unlisted directories remains `full`: enrollment,
  backfill, and the first sync keep meaning "everything you did not opt out
  ships".
- **CLI**: `hyp ignore <path>` keeps its [LLP 0049 §cli](./0049-hypignore-usage-policy.spec.md#cli)
  dotfile meaning unchanged (repurposing a settled verb silently would be
  worse than a new flag). Machine-local writes get flags on the same verb:
  the existing `--local-only`, a new `--private` for a machine-local
  `ignore` entry, and an explicit-sync marking whose spelling the design doc
  picks. `hyp unignore` grows symmetric removal. The review skill and the
  hook only ever use the machine-local forms.

## The surface matrix, settled

| class | `.hypignore` dotfile (committable, team-visible) | machine-local entry (private, per-machine) |
|---|---|---|
| `ignore` | yes ([LLP 0049](./0049-hypignore-usage-policy.spec.md), unchanged) | **new, this decision** |
| `local-only` | no ([LLP 0071 §not-dotfiles](./0071-machine-local-exclusion-list.decision.md#not-dotfiles), unchanged) | yes ([LLP 0071](./0071-machine-local-exclusion-list.decision.md), unchanged) |
| `full` | no (absence of policy is the dotfile-world default) | **new: explicit "asked" marker** |

## Consequences

- A machine-local `ignore` suppresses *future* capture and backfill re-import
  ([LLP 0049 R1](./0049-hypignore-usage-policy.spec.md#requirements) applies
  to the new source unchanged); already-cached rows are
  [`hyp purge`](./0104-hyp-purge.decision.md)'s job.
- `hyp ignore --check` and `hyp status` reporting must name which source
  governs (dotfile vs machine-local entry) or debugging gets harder.
- The store keeps every LLP 0071 property: never forwarded, never merged with
  config, survives cache rebuilds, untouched by `hyp leave`.
