# LLP 0182: One Reconfigure for every returning machine

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Related:** LLP 0129 (the returning gate this amends), LLP 0011 (the original gate), LLP 0031 (layered config: central wins), LLP 0132 (managed-local additions stay local-only), LLP 0135 (wizard orchestration), LLP 0137 (retention defaults)
**Extended-by:** [LLP 0185](./0185-wizard-defaults-gate.decision.md#fork-disconnect) (a managed machine choosing the local pathway is now asked once whether to disconnect; yes runs `hyp leave`, no keeps the behavior decided here)

> [LLP 0129 §returning-gate](./0129-init-wizard-fork.decision.md#returning-gate)
> gave a managed machine its own menu row and its own pathway: "adjust
> what this machine collects", skipping the fork. This replaces that with
> one `Reconfigure` for every returning machine. Being managed stops
> deciding what the menu offers and what pathway runs; it decides only
> which picker rows arrive locked.

## Context {#context}

The gate's two rows encoded a permissions idea - a joined machine is a
machine with less to say - that HypAware does not otherwise hold. It also
did not survive contact with who is actually running it: individuals and
small teams, where the person at the keyboard and the person who set up
the org are frequently the same person. Enterprise separation of duties
is not a current priority, and when it becomes one, a menu row is not
where it will be enforced.

Two facts made the scoped row cheap to remove:

1. **The lock is a truth about the merge, not a policy.** LLP 0031 settles
   that the central layer wins and the local layer "can never override or
   remove" what central names. A dimmed org row is honesty about what the
   next pull will do, not a permission being withheld. That honesty is
   worth keeping regardless of which menu row led to the picker.
2. **`scoped` was almost entirely a label.** Its itinerary in
   `wizard/steps.js` was identical to `local`'s, and `opts.scoped` reached
   exactly one consumer: a span attribute. The only real behavior on the
   scoped path was skipping the fork and computing the locked set.

## Decision

<a id="one-reconfigure"></a>**The returning gate offers the same three
rows to every configured machine**: `Reconfigure`, `See full status`,
`Quit`. `buildReturningGateOptions()` takes no `managed` argument, so
there is no branch left to drift. `Reconfigure` re-enters the wizard at
the fork exactly as a first run does, managed or not, which means an
enrolled user can re-join, switch org, or set up locally without first
knowing that `hyp leave` exists. Quit stays the default on a bare enter
(LLP 0011's never-reconfigure-by-accident rule, still untouched).

**Managed survives as the locked-set input, not as a pathway.** The gate
still reports `managed` from the on-disk central layer, and
`runInitWizard` still calls `computeCentralLockedSources` off it before
the fork runs. The picker therefore renders org rows checked and disabled
(LLP 0031 provenance vocabulary) and every other row with its
`stays on this machine` suffix (LLP 0132 #never-silent) on a managed
machine, whichever fork branch the user took to get there. The
`'scoped-reconfigure'` gate action and the `'scoped'` pathway are removed;
`WizardPathway` is `'team' | 'local'`.

**The retention default keys on `managed`, not on the pathway label.**
LLP 0137 #pathway-defaults gives a local install 120 days because its
cache is the only copy of history, and a team install 90 because the org
server holds the durable copy. A managed machine can now walk the local
pathway, so the condition becomes `pathway === 'local' && !managed`. The
reason the default existed is unchanged; only the test for it is.

## Consequences

- A managed machine's Reconfigure now shows "Join a team" as a live
  option. Enrolling elsewhere from there is a re-enrollment through the
  ordinary login lane (LLP 0031 §re-enrollment), not a new mechanism.
  `hyp leave` is still the way to stop being managed; the wizard has no
  toggle for it.
- What a managed user cannot change is now discovered one screen later,
  in the picker, rather than by the absence of a menu row. That is the
  screen where it is true, and it names the reason on each row.
- If org-level restriction on who may reconfigure a joined machine is
  ever wanted, it belongs in the server's config or the merge, not in the
  wizard's menu. Nothing here forecloses it.
