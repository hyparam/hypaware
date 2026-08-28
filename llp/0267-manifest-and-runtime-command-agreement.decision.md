# LLP 0267: A plugin's manifest and its `activate()` must agree about commands

**Type:** decision
**Status:** Accepted
**Systems:** Plugins, CLI
**Generated-by:** neutral
**Date:** 2026-08-18
**Related:** LLP 0005, LLP 0009, LLP 0034, LLP 0153, LLP 0154, LLP 0214
**Extended-by:** LLP 0268 (#not-deletion replaces D3's manifest-omission mechanism with matched `hidden: true` declarations)

> [LLP 0009 #layered-help](./0009-cli-registry.spec.md) says the help levels
> "read the same registry, so they cannot drift". That holds for core and not
> for plugins: `hyp --help` renders before boot and reads `contributes.commands`
> out of the manifest, while group and leaf help read the command registry
> `activate()` filled. Two sources, no comparison, and
> `@hypaware/context-graph-enrich` shipped with two of its five commands
> described differently at the two levels
> ([issue #837](https://github.com/hyparam/hypaware/issues/837)). This settles
> that the agreement is checked, where it is checked, and what dispatch says
> when a declared command still does not run.

## Context {#context}

LLP 0009 #top-level-help-lists-plugin-commands-without-booting is not a
mistake: booting to populate the registry would import every plugin entrypoint
and bind the listeners some plugins open during activation, which is too much to
pay for `hyp --help`. Reading the manifest instead is the right trade. The cost
of that trade is a second source of truth, and the cost was never paid: nothing
compared the two.

`hyp plugin doctor` was already close. It dry-run activates a plugin and diffs
`contributes.<category>` against what registered, so a *missing* or *undeclared*
command was already a finding. It did not look at what either side said, it was
never run over the bundled plugins, and two of its own behaviours got in the
way (#d3, #d4).

## Decisions {#decisions}

### D1: the manifest and the registration are one contract, and the doctor checks it {#d1}

For every command a manifest declares, the summary in `contributes.commands` and
the summary passed to `ctx.commands.register` must be the same string. The
doctor reports a difference as `command_help_drift`, severity `error`.

There is no preferred direction: the check compares, it does not pick a winner.
Which wording is right is a judgement about the command (LLP 0009 #layered-help
says a bare group command's summary should name its headline subcommands), and
the fix is to make both sides say it.

A **verb** is covered by the same check with no extra machinery: the kernel
projects a verb into a CLI command on the same registry
([LLP 0034 #verbs](./0034-mcp-host-intrinsic.decision.md)), so `graph neighbors`
is compared exactly like an imperative command.

A registered **group description** ([LLP 0214 #d2](./0214-verbs-and-plugin-groups-carry-long-help.decision.md#d2))
whose namespace no declared command lives under is a `warn`: `hyp <group>
--help` then describes a group top-level help never lists. It is not an error
because the description still renders correctly for anyone who reaches it.

### D2: the bundled set is held to the check a plugin author gets {#d2}

`test/plugins/bundled-command-manifest-agreement.test.js` runs the doctor's diff
over every plugin in `hypaware-core/plugins-workspace` and fails on any
command-scoped finding. The generic tool, not a second harness: a bespoke
comparison would drift from the doctor, and then the bundled plugins and
third-party plugins would be held to different contracts.

The test fails on an unreachable `activate()` as well, so a plugin whose dry run
never registers anything cannot pass by registering nothing.

### D3: a hidden command is omitted from the manifest, and that is not a finding {#d3}

> Extended by [LLP 0268 #not-deletion](./0268-plugin-commands-classified-as-surface-or-mechanism.decision.md#not-deletion): hidden commands now remain in the manifest and set `hidden: true` on both the declaration and registration.

LLP 0009 #top-level-help-lists-plugin-commands-without-booting makes manifest
omission the mechanism by which an internal command stays out of help. The
doctor's `contribution_undeclared` warning contradicted that, nagging
`@hypaware/claude` and `@hypaware/codex` about their client hooks and pushing
authors to declare (and thereby advertise) exactly what `hidden` exists to hide.
Hidden commands are now exempt.

The converse is an error: a command the manifest declares but the registration
marks `hidden` is advertised at the top level and then absent from every listing
below it.

### D4: a doctor dry run does not run a source {#d4}

`dryRunActivate` builds a throwaway runtime to see what `activate()` registers.
`@hypaware/otel` starts its own OTLP source from `activate()`, so the dry run
bound a real port: diagnosing a plugin took `127.0.0.1:4318`, and on a host
where the daemon already held it the doctor reported `activate_threw` against a
plugin that was fine. The dry run now hands the plugin a source registry whose
`start()` records the call and runs nothing.

The capability stub grew the same kind of guard. It answered every property with
itself, including `Symbol.toPrimitive`, `valueOf`, and `toString`, so a plugin
that logged a value read off a required capability (`embed_model:
embedder.model`) hit a string conversion that could not terminate. Two bundled
plugins failed their dry run that way, and the doctor blamed them for the stub.

### D5: dispatch distinguishes selected-but-unavailable from not-selected {#d5}

This **extends** [LLP 0154](./0154-dispatch-miss-repair-by-cause.decision.md),
which classified a dispatch miss into `absent`, `disabled-local`, and
`disabled-central`. All three describe a plugin the effective config does not
select. A plugin the config *does* select can still fail to reach the registry:
its `activate()` threw, the dep graph eliminated it for an unsatisfied
`requires`, its manifest would not load, or the boot profile withheld it. None
of those are in the not-selected pool, so the miss fell through to the generic
`hyp: unknown command`, telling a user that a feature their own config names
does not exist.

A fourth state, `selected-unavailable`, is checked first (a selected plugin is
never also in the not-selected pool) and reports:

```
hyp: 'graph' is provided by @hypaware/context-graph, which your config selects but this run could not activate
  repair: the plugin is configured but unavailable this run; run 'hyp status' for why, then re-run this command
```

The repair names no config edit, because there is no config edit: the entry is
already there and already enabled.

This also keeps top-level help's epilogue honest. It promises that a command
missing from the list can be run anyway and will name its plugin, which was
true only while every listed command actually dispatched. With D5 the promise
holds for the selected-but-unavailable case too, so the wording stands as
written rather than being hedged.

## Consequences {#consequences}

- `hyp plugin doctor` gains one diagnostic kind, `command_help_drift`, and loses
  a class of false warning.
- `RegisteredSnapshot` carries `commandDetails` and `commandGroups` beside the
  name lists, because "was it registered" and "what does it say" are different
  questions. `CommandRegistry` implementations gain `listGroups()`: group
  descriptions are deliberately not in `list()`, so without it the only way to
  see one is to already know its name.
- A plugin author who renames a command's summary in one place now fails a
  check instead of shipping two answers to the same question.
- LLP 0009 #layered-help's "cannot drift" reads as a property of the *registry*,
  not of the help system: where a second source exists, something has to
  compare them.

## Rejected alternatives {#rejected}

- **Boot the kernel for top-level help so there is one source.** Rejected for
  the reason LLP 0009 gives: it imports every entrypoint and binds listeners to
  render a help screen.
- **Generate `contributes.commands` from the registrations at build time.**
  Tempting, and it would make drift impossible, but the manifest is read by
  discovery before any code loads (LLP 0005 #declarative); a generated file
  still has to be regenerated, which is the same failure with an extra step.
- **Make the drift check a warning.** Rejected: a warning is what the existing
  undeclared check already was, and it is why nobody noticed. The two summaries
  are shown to the same user minutes apart.
- **A bespoke bundled-only comparison harness.** Rejected under D2: the bundled
  plugins would then be checked by something no plugin author can run.
