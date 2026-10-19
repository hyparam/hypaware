# LLP 0533: `collect` is deferred, not shipped

**Type:** Decision
**Status:** Accepted
**Systems:** Query, CLI
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0015 (#collect-the-ad-hoc-on-ramp), LLP 0004 (#state-directories)
**Related:** LLP 0002 (V1 scope), LLP 0009 (#layered-help), issues #839 and #840

> [LLP 0015](./0015-query-and-datasets.spec.md) and
> [LLP 0004](./0004-activation-and-paths.spec.md) are Active, so they are not
> edited. 0015 #collect-the-ad-hoc-on-ramp specifies a core `hypaware collect`
> command, and 0004 #state-directories lists collection entries among the
> state the kernel owns. Neither has ever shipped. This records that the
> command is deferred, so both docs stop reading as a description of what
> runs today. Their design text is kept as the intent a future feature would
> start from.

## Context {#context}

Issue #839, found by a CLI consistency audit: no `collect` command is
registered, there is no collection-state store under the recording root, and
nothing in the cache or dataset registry knows about a user-registered
collection. [LLP 0002](./0002-v1-scope.decision.md) did not put `collect` in
the V1 acceptance criteria, but 0015 stayed Active and presents it as part of
the intrinsic query surface. A reader of 0015 or 0004 had no way to tell the
section apart from the shipped parts around it.

The same audit found the `config` group's help summary, "Inspect or validate
the HypAware config", promising an inspect operation (issue #840 proposed
`hyp config show`) when `config validate` is the only registered subcommand.

## Decision {#decision}

### Deferred {#deferred}

`collect` is unimplemented and unscheduled. It is neither retired nor owed:
0015 #collect-the-ad-hoc-on-ramp and its subsections, and the collection-entry
mention in 0004 #state-directories, remain the recorded design intent for a
future explicit feature request, which would start from them and settle what
they leave open. Until then, nothing registers `collect`, nothing creates
collection state, and no help, README, or reference page advertises the
command.

The rest of 0015 (the intrinsic query surface, datasets, and the cache
plumbing) and the rest of 0004 are unaffected.

### Help claims only what registers {#help-claims-registered}

A group's help summary names only the operations its registered subcommands
perform. The `config` group therefore reads "Validate the HypAware config"
while `config validate` is its only subcommand. A later `config show` (or any
other inspect operation) changes the summary in the same change that registers
it.

## Consequences {#consequences}

- 0015 and 0004 each gain an additive forward reference to this record at the
  sections it scopes. Their settled text is unchanged.
- `test/core/cli-consistency-gate.test.js` pins that `collect` and `config
  show` stay unregistered, that the `config` group's only child is `validate`,
  and that neither the top-level help nor `hyp config --help` advertises what
  is not registered.
- Shipping `collect` later needs a new LLP that extends or supersedes this
  one, and the command's registration, state, and tests land with it.
