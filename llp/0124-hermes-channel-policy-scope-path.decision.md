# LLP 0124: channel sessions get a canonical policy scope path

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0049, LLP 0050, LLP 0070, LLP 0071, LLP 0103, LLP 0118, LLP 0120, LLP 0122

> Hermes sessions sourced from messaging channels (Telegram, Discord, Slack,
> WhatsApp, Signal, Email) are stamped with a canonical, per-channel policy
> scope path, `~/.hermes/channels/<source>`, in the `cwd` column. They are
> captured and sync-eligible by default (`full`), and a user opts a channel
> down to `local-only` or `ignore` with the standard policy marking machinery,
> no hermes-specific config key.

## Context

Hermes's messaging-gateway sessions contain messages written by third
parties, so users need a way to keep them off the org server (`local-only`)
or out of the cache entirely (`ignore`). The default is `full`: they are
ordinary captured sessions unless the user says otherwise.

The obstacle is that the entire usage-policy corpus is keyed on the `cwd`
column: the `.hypignore` resolver walks it
([LLP 0049](./0049-hypignore-usage-policy.spec.md#scope)), the machine-local
class list matches it ([LLP 0071](./0071-machine-local-exclusion-list.decision.md),
[LLP 0103](./0103-machine-local-policy-classes.decision.md)), and `local-only`
has exactly one enforcement point, the export seam, which withholds rows by
matching `cwd` ([LLP 0070](./0070-local-only-export-seam.decision.md), with
the scan hardened so a column projection cannot bypass it). Channel sessions
have no meaningful working directory, so without intervention they would be
policy-invisible: no scope to mark, no way to express `local-only` at all
short of teaching the export seam a second match key.

A bespoke `[hermes] channel_policy` config key was considered and rejected:
`ignore` it could enforce at the capture seam, but `local-only` would require
extending the export seam with a non-`cwd` key, a new mechanism with a new
bypass surface, invisible to `hyp status`, the privacy-review skill, purge
accounting, and every other tool that reasons about scopes.

## Decision

**The hermes projector stamps channel-sourced sessions with
`cwd = ~/.hermes/channels/<source>`** (e.g. `~/.hermes/channels/telegram`).
The session's real daemon working directory, when hermes recorded one, is
preserved verbatim in `attributes`. Interactive sessions (cli/tui/cron) keep
their genuine `cwd` untouched.

Consequences of the stamp, all free:

- **Default `full`:** nothing is listed, nothing is withheld, matching the
  chosen default.
- **`local-only` per channel:** marking `~/.hermes/channels/telegram`
  local-only in the machine-local list flows through the existing export
  seam unchanged.
- **`ignore` per channel:** the same marking machinery (machine-local list
  entry or a `.hypignore` in the scope path), honored by the shared resolver
  the projector already consults before projecting
  ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) R4 pattern).
- **All channels at once:** `~/.hermes/channels` covers every channel by
  ancestor walk.
- **Full tool coverage:** channel sessions are visible to `hyp purge`, the
  privacy-review flow, and `--check`-style scope inspection, because they now
  have a scope like every other row.

## Trade-off accepted

The `cwd` column widens semantically: for channel sessions it carries a
**policy scope path**, not a literal working directory. The path need not
exist on disk; the resolver and the export seam match on path shape, not
filesystem state. Downstream consumers that treat `cwd` as a repo hint (graph
repo derivation) simply find nothing there, which is correct: these sessions
have no repo. The alternative, a second match key at the export seam, was
judged strictly worse (see Context).

## Consequences for the cluster

- [LLP 0118](./0118-hermes-log-forwarding.spec.md) gains requirement R10 and
  loses the old non-goal 4 framing (channel policy is now representable, not
  deferred).
- [LLP 0122](./0122-hermes-log-forwarding.design.md#projection) stamps the
  scope in the projection table and its
  [usage-policy section](./0122-hermes-log-forwarding.design.md#usage-policy)
  resolves every session, channel or interactive, through the one shared
  resolver.
- Code that lands this carries `@ref LLP 0124 [implements]` on the scope
  stamping in the projector.
