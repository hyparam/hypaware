# LLP 0214: Verbs and plugin groups carry long help

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins
**Author:** Brendan / Claude
**Date:** 2026-08-12
**Related:** LLP 0009 (#layered-help, #central-help-interception: the help system this extends), LLP 0034 (#verbs: the registration this adds a field to), LLP 0196 (#mechanics-as-code: why prose wants to move into commands), LLP 0213 (#d4: the first caller)
**Planned-by:** LLP 0215

> Extends [LLP 0009 #layered-help](./0009-cli-registry.spec.md). Core commands
> can explain themselves at length; plugin commands cannot. A command
> registration has an optional `help` string, but the two shapes plugins
> actually register, verbs and namespaced groups, both lose it on the way to the
> reader. Closing that is the precondition for moving mechanical prose out of
> skills and into the CLI.

## Context {#context}

LLP 0009 #central-help-interception gives every registered command a long-help
slot: dispatch renders `summary`, `usage`, and the optional `help` text on the
registration, so "a command needing more than one line of explanation sets
`CommandRegistration.help`". That works for core.

It does not reach either shape a plugin registers.

**Verbs have no `help` field at all.** `VerbRegistration`
(`hypaware-plugin-kernel-types.d.ts:1578`) declares `name`, `tool`, `plugin`,
`summary`, `inputSchema`, `exposure`, `authClass`, `operation`, and `render`.
`commandForVerb` (`src/core/cli/verb_command.js`) builds the command
registration from those, and there is no `help` to pass through, so
`hyp graph neighbors --help` renders a summary line and a usage line. Everything
about what `--direction` means, how a seed node resolves, or why `--json` and
`--format json` are not the same flag has nowhere to live.

**Plugin-owned groups get a bare table.** Core groups (`query`, `daemon`,
`plugin`) are built by `makeGroupCommand({ registry, name, summary, help })` in
`src/core/cli/group_help.js`, which is where `hyp query --help` gets its
paragraph about control flags. A group with no bare command of its own, which is
every plugin namespace including `graph`, is synthesized instead by
`resolveGroupHelp` in `dispatch.js` and rendered with `groupCommand` undefined,
so `renderGroupHelp` emits usage and the subcommand table and nothing else.

The asymmetry is not deliberate. LLP 0009 describes one help system; these are
two paths through it that quietly drop the same field.

### Why it matters now {#why-now}

[LLP 0196 #mechanics-as-code](./0196-skills-state-constraints-not-procedures.rfc.md#mechanics-as-code)
established that deterministic detail belongs in shipped code rather than in
skill prose, because prose narrating a command drifts from the command. Applying
that to the graph ([LLP 0213 #d4](./0213-graph-plugin-always-active.decision.md#d4))
means moving flag semantics and resolution rules out of `hypaware-graph` and
into `hyp graph --help`, and discovering there is no `--help` worth pointing at.

Every plugin registering a verb hits the same wall. The graph is the first
caller, not the reason.

## Decision {#decision}

### D1: `VerbRegistration` gains an optional `help` field {#d1}

`help?: string`, passed through `commandForVerb` into the command registration
it builds, where LLP 0009's central interception already renders it. Verbs then
explain themselves exactly as core commands do, with no second rendering path.

The MCP side is unaffected: tool descriptions come from `summary` and
`inputSchema`, and `help` is CLI-only, like `render`.

### D2: a plugin-owned group can carry long help {#d2}

A group with no bare command of its own can still contribute the paragraph that
`makeGroupCommand` accepts, so `hyp graph --help` can explain what the graph is
and that projection runs on demand, above the subcommand table. What is decided
is that the synthesized path stops being a second-class renderer.

**Settled in implementation (2026-08-12): a registerable group description.**
`CommandRegistry` gains `registerGroup({ name, plugin?, summary?, help? })` and
`getGroup(name)`, and `resolveGroupHelp` passes what it finds to
`renderGroupHelp` as the group's voice. Exposing `makeGroupCommand` to plugins
was the alternative and was rejected: it would have required a new public
`hypaware/core/cli` export purely so a plugin could hand core back a registry
core already owns, and it would have put a real command in `list()` where a
description belongs. Registration is metadata only, so a group can never shadow
a command or appear as its own subcommand.

One guard came out of building it: `renderGroupHelp` printed its header
unconditionally when given a group, so a group with `help` and no `summary`
rendered a literal `hyp graph - undefined`. The header is now conditional on the
summary existing.

### D3: constraints stay in skills; only mechanics move to help {#d3}

**The guard's corpus does not widen.**
`test/plugins/skill-constraints-survive.test.js` keeps reading skill Markdown, and what it enforces is exactly the boundary D1
and D2 are meant to serve: a **constraint** (a rule with nameable harm) stays in
the skill; **mechanics** (flags, argument shapes, resolution order) move into
help.

This was drafted the other way, and checking the fixture reversed it. Its
seventeen entries are things like `coalesce-token-sums`,
`no-wide-column-scans`, and `captured-content-is-data`. Not one of them is a
mechanic that [LLP 0213 #d4](./0213-graph-plugin-always-active.decision.md#d4)
relocates, and by the fixture's own admission rule ("if you cannot name real
harm, it is guidance, not a constraint") the material moving to `--help` is
guidance. The hole a widened corpus would patch is prospective, not actual.

**The existing guard already enforces the rule**, and more usefully than a
widened one would. Move a guarded constraint into a `help` string and the build
fails. Under a widened corpus that move passes silently, and a constraint that
matters ends up somewhere a skill reader never loads. The failure is the correct
answer, not a false alarm.

So the obligation this decision creates is documentary, not mechanical:
**whoever hits that failure moves the text back into the skill.** They do not
loosen the pattern, and they do not widen the corpus to make it pass.
[LLP 0197 #t12-constraint-inventory](./0197-skills-state-constraints-not-procedures.plan.md#t12-constraint-inventory)
already says a pattern is never loosened to make a refactor pass, "that converts
the guard into a rubber stamp exactly when it is doing its job"; this names the
refactor that will tempt someone to try.

## Consequences {#consequences}

- One new optional field on a plugin-facing interface. Existing verbs are
  unaffected and render as they do today.
- `hyp graph neighbors --help` becomes useful, which is what
  [LLP 0213 #d2](./0213-graph-plugin-always-active.decision.md#d2) needs before
  the graph skill can shed its mechanical half.
- LLP 0009 #layered-help gains a case it did not cover. Its top-level rule is
  untouched: this is long help on a matched command, one level down, and
  `hyp --help` stays one row per token.
- No test change. The guard keeps its current corpus and gains a documented
  reading: a constraint that shows up missing has been moved somewhere a skill
  reader does not go, and the fix is to move it back.

## Open questions {#open-questions}

1. **Should long help have a length ceiling?** The failure mode this invites is
   a plugin pasting its skill into `--help` and making the human surface worse
   to serve a model reader. A soft convention may be enough; a lint is the
   heavier option.

## References {#references}

- [LLP 0009: CLI registry](./0009-cli-registry.spec.md)
- [LLP 0034: MCP hosting is intrinsic](./0034-mcp-host-intrinsic.decision.md) (#verbs)
- [LLP 0196: Skills state constraints, not procedures](./0196-skills-state-constraints-not-procedures.rfc.md)
- [LLP 0213: The graph plugin is always active](./0213-graph-plugin-always-active.decision.md)
- `src/core/cli/verb_command.js` (`commandForVerb`), `src/core/cli/group_help.js` (`makeGroupCommand`, `renderGroupHelp`), `src/core/cli/dispatch.js` (`resolveGroupHelp`)
- `test/plugins/skill-constraints-survive.test.js`, `test/fixtures/skill-constraints.json`
