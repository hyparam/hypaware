# LLP 0509: An unresolved central set is not an empty one

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI, Config
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0289 (#not-done: the corner this closes), LLP 0182 (the swallowed resolution failure), LLP 0129 (#join-before-picker: the converge miss), LLP 0276 (#no-candidates), LLP 0188 (#never-silent, #locked); hyparam/hypaware#970

> Extends [LLP 0289 §not-done](./0289-sync-lane-asks-the-store-about-hidden-picks.decision.md#not-done),
> which accepted this corner and named the signal it lacked. It also
> qualifies what the empty locked set means on the two degraded paths of
> [LLP 0182](./0182-one-reconfigure-for-every-machine.decision.md) and
> [LLP 0129 §join-before-picker](./0129-init-wizard-fork.decision.md); the
> picker's behavior on those paths is unchanged.

## The problem {#problem}

The wizard computes the picker rows the central layer owns and hands them
on as `lockedSources`. Two paths return `[]` on purpose, because the picker
is not the org boundary and must not stall: `computeLockedSafe` when the
layered resolution throws, and the join when the org config has not
converged. A healthy enrolled machine whose org configures nothing also
returns `[]`. The sync lane could not tell these apart.

LLP 0289 §ask-the-store treats a hidden pick as non-central by
construction and asks the policy store whether it ships. On a degraded run
that does not hold: a hidden pick can be an org row whose `local-only`
entry predates adoption. The export seam ignores that entry and ships the
row, while the lane reads it as withheld and prints "Nothing syncs".

## Decision {#unknown-is-not-empty}

The wizard carries an explicit internal outcome next to the locked set:
resolved, or not. `computeLockedSafe` returns `resolved: false` on a
swallowed failure. A join whose config has not converged returns
`lockedResolved: false`, and a converged join returns `true`. The run keeps
the flag beside `locked` on every path that sets it: the gate, a fresh
join, a reused join, and a disconnect, which resets it. It passes the flag
to the sync lane. Failure is never inferred from an empty list, and
`managed` is not used as a proxy.

When the set did not resolve, the sync lane:

- does not print "Nothing syncs", and does not claim that a hidden row
  definitely ships;
- says "Your team's configuration could not be confirmed, so capture your
  team manages may still sync to <server>" where it has no visible pick to
  name;
- still names the visible picks, followed by the same qualification
  ("... may also sync to <server>").

Hidden rows stay unnamed. The lane's span carries `locked_resolved`, and
the join span carries it too, so a report of "it said unconfirmed" or "it
said nothing syncs" can be checked against the signal without any source
name. A later run whose resolution succeeds prints the ordinary summary.

## Not changed {#not-changed}

Opt-outs, export enforcement, enrollment, capture and send-now consent are
untouched. The picker still composes freely on a degraded run, and nothing
new is persisted: the flag lives only for the run.

## References

- `src/core/cli/wizard/index.js` (`computeLockedSafe`, `lockedResolved`, the
  sync lane's call site), `src/core/cli/wizard/join.js` (`runJoinFlow`),
  `src/core/cli/wizard/sync_scope.js` (`runWizardSyncScope`),
  `src/core/cli/wizard/types.d.ts` (`RunWizardSyncScopeOptions`,
  `WizardJoinResult`)
