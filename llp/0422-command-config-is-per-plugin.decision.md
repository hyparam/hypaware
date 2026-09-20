# LLP 0422: A plugin-owned command body reads the config through its own slice

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Config, Core
**Author:** Phil / Claude
**Date:** 2026-09-20
**Extends:** LLP 0420#split (the one member that decision left out of the split, recorded there as "a scope call left open"), LLP 0420#consequences (a verb projection is no longer ownerless)
**Related:** LLP 0004, LLP 0006, LLP 0009, LLP 0033, LLP 0034, LLP 0115, LLP 0421

> LLP 0420 split `CommandRunContext` by who owns the command about to run and
> narrowed `capabilities`, `sources` and `sinks`. It left `config` whole and
> said so: a plugin that contributed a command read every other plugin's
> section, and the inline credential an operator wrote into a configured sink
> (issue #1978). The same object reaches a plugin's verb `operation` through
> `buildOperationContext`. `config` now follows the owner, by the slice rule
> `activate()` already uses.

## Context {#context}

`bootKernel` hands each plugin `config.plugins[i].config` for its own `i` and
nothing else, so "this plugin's config" has had one definition since LLP 0004.
The dispatcher never applied it. Measured through the real `dispatch()` on
`cfd0aa10`, from a command owned by `@fixture/squatter`:

```
ctx.config.sinks["org-central"].config.token      "SECRET-TOKEN"
ctx.config.plugins[0].config.api_key              "GASCITY-PRIVATE-KEY"
```

That is the disclosure #1970 opens with (`handle.config` gave a neighbour's
inline token), one context member over, and it costs a plugin nothing but a
`contributes.commands` entry.

Two doors, not one. A **verb** is the second: `runVerbCommand` passes the
command context's `config` straight on as the `config` a plugin's `operation`
receives, and the CLI command a verb projects was registered by the verb
registry itself, outside any `registeringAs` bracket. `ownerOf` answered
`undefined` for it (LLP 0420 #consequences), so a fix keyed on command
ownership alone would have narrowed a plugin's command and left the same
plugin's verb reading everything.

## The narrowing is the slice rule, applied in place {#scope}

`pluginScopedConfig(config, plugin)` builds the effective config **as that
plugin may read it**. It is a projection of `HypAwareV2Config`, not a
substitution of the plugin's own `JsonObject` slice for it: the object has to
stay a config, because shipped code reads it as one. `@hypaware/claude`'s hook
walks `plugins[]` to find its own `telemetry.spool_max_bytes`, the gateway's
`hyp session ...` commands resolve their own pinned `listen` the same way, and
`runVerbCommand` resolves `--remote` out of `query` before the plugin's
`operation` is called at all.

So the shape is kept and the operator's per-plugin sections are removed:

- **`plugins[]`.** The owner's own entry is handed over untouched, which is
  exactly what `activate()` gets. Every other entry keeps its identity
  (`name`, `enabled`, `version`, `artifact_hash`, `source`) and loses `config`.
  The roster is not a secret and a command that could not see it would be
  unable to report on its own host.
- **One widening, along the declared dependency edge.** The owner also keeps
  the `plugins[]` `config` of every active plugin that provides a capability
  the owner's manifest names in `requires.capabilities`. That edge is the one
  LLP 0006 #resolution-rules already sanctions as the cross-plugin channel: a
  requirer holds the provider's live capability API, the coupling is written
  in the manifest where an operator can audit it, and dep_graph eliminates a
  plugin whose declared requirement is unmet, so the edge is load-bearing
  rather than free. It exists because a bundled requirer reads its provider's
  settings today: `@hypaware/claude-desktop` resolves the gateway's pinned
  `listen` to render a Desktop profile, and to refuse an ephemeral one
  (LLP 0115). The widening reaches `plugins[]` sections only, never a
  `sinks{}` instance `config`, and never a plugin the owner merely wishes to
  read: an undeclared runtime `requireCapability` call widens nothing.
- **`sinks{}`.** An instance's `config` is the operator's settings for the
  plugins the instance names at its top level (`writer` + `destination`, or
  `plugin`, the complete set of top-level naming keys the schema admits). So
  an instance keeps its `config` for the plugins it names and loses it for
  everyone else, while the instance itself stays visible. A `hyp` command that
  reported an empty sink list would be reporting something untrue. This is the
  slice's own rule, not a restatement of the kernel's: `SinkCreateContext`
  reaches one plugin per instance (the destination for a blob instance, the
  writer for a table-format one), and a table-format instance also names a
  fourth plugin through the plugin-name-valued `config.encoder` key. The
  encoder is deliberately outside the match: the same `config` object can
  carry the destination's inline credential, and the encoder is named as a
  codec choice, receiving no `SinkCreateContext.config` today either.
- **`version`, `query`, `disambiguate`, `auto_update`** are carried by
  reference. They are core's sections, not any plugin's, and core code runs on
  this object too.

The slice shares structure deliberately: a neighbour's `plugins[]` entry or a
`sinks{}` instance with no `config` to remove is handed back by reference, so
an untouched section keeps its identity and costs no allocation. That sharing
is safe for what it can disclose, not for what a body can write: the retained
sections carry no secret by construction (`query.remotes` holds a `url` only;
the remote token is never config), and exactly one owned body runs per
`dispatch()`, so there is no sibling slice in the same process to poison. A
design that runs a second owned body against the same `activeConfig` in one
process must revisit this before it relies on the slice.

A **core** command keeps the whole config, for the reason it keeps the raw
registries (LLP 0420 #split): `hyp status` and `hyp sync` render every
plugin's state and every configured sink, and rendering that is core's job
(LLP 0009 #core-rendered-status).

## A verb is attributable to the plugin that registered it {#verb-owner}

`VerbRegistry` records the registrar the way `CommandRegistry` does: a
`registeringAs(plugin, fn)` bracket around a synchronous `register`, driven by
a per-plugin `ctx.verbs` facade built beside the `ctx.commands` one. The
registry then registers the CLI command it projects **inside the command
registry's own bracket**, so the projection carries the registrar its verb was
registered under.

The answer is deliberately not `VerbRegistration.plugin`, for the reason
LLP 0420 #owner rejected `CommandRegistration.plugin`: it is written by the
plugin, the registry holds the registration by reference, and a plugin that
can name the owner can name a neighbour.

This is one discriminator, not two. Everything downstream already asks
`ownerOf(name)`: the dispatcher narrows `CommandRunContext` once, and
`buildOperationContext` copies that `config` onto the verb's operation
context, so the verb route needs no rule and no plumbing of its own. Core's
verbs register outside any bracket (`registerCoreVerbs` runs inside
`createKernelRuntime`) and stay ownerless, so `hyp query sql` is unchanged.

## What this costs, and what it leaves open {#consequences}

- A plugin's verb projection now also receives that plugin's `capabilities`,
  `sources` and `sinks` facades, where LLP 0420 #consequences recorded that it
  kept the raw registries. Nothing reaches a plugin through those on this path
  (`runVerbCommand` and `runRemoteVerb` read `config`, `env`, `stdout` and
  `stderr` only), so this is the split reaching a case it had no registrar for,
  not a new reach.
- **One bundled plugin reads across the plugin boundary, and the widening
  above exists for it.** Surveyed across `hypaware-core/plugins-workspace/`,
  `src/` and `bin/` (and independently re-swept in PR #1981's round 1 review,
  which caught the miss the first survey made): every bundled command body and
  verb operation that reads `ctx.config` reads its own `plugins[]` section
  (`@hypaware/claude`'s hook cap, the gateway's `session` commands) or passes
  the whole config to `executeQuerySql`, which forwards it to
  `discoverPartitions`, except `@hypaware/claude-desktop`, whose five commands
  resolve `@hypaware/ai-gateway`'s pinned `listen` (and refuse an ephemeral
  one, LLP 0115). That read survives through the capability-provider rule in
  #scope; without it the slice silently shipped a Desktop profile pointed at
  the fixed default port while the refusal became unreachable. No bundled
  dataset reads `ctx.config`.
- **`ctx.verbs` is a narrowing for honest plugins, not a boundary against a
  hostile one**, the same carve-out LLP 0420 #consequences recorded for
  `ctx.commands`. The facade pins `register` and `registeringAs`; `get()`,
  `getByTool()` and `list()` read through to the stored, mutable
  registrations, `verb.operation` is the field that decides whose code runs
  behind a verb (a projection's `run` is core's `runVerbCommand` closure over
  the live registration, so LLP 0421's `bodyOf` does not reach it), and
  `unregister` checks no owner. `CommandRunContext.verbs` is the raw registry
  besides; the obvious escalation through the in-process `ctx.commands.run`
  seam does not disclose today only because that seam's `activeConfig` stays
  `{ version: 2 }`, which is an accident of the seam and not a boundary. The
  reach predates this decision (`ctx.verbs` was the raw registry) and is held
  as issue #1983.
- **One reader crosses the line, and was measured rather than argued.**
  `hyp session ignore|unignore|status` is registered by whichever of
  `@hypaware/ai-gateway`, `@hypaware/opencode` and `@hypaware/cursor` activates
  first, and all three run the gateway's body, which falls back to
  `@hypaware/ai-gateway`'s pinned `listen` when no daemon is running. Owned by
  one of the other two, that fallback reads nothing and the command reports
  that it could not resolve the gateway endpoint. On the shipped plugin set the
  gateway always wins that race (dependency order puts it first), so the only
  reachable shape is a config that pins the gateway's `listen` while disabling
  the gateway itself, with an adapter active and no daemon running: a state
  where the fallback was naming a port nothing had bound. The live-daemon
  route, which is the one that can succeed, is untouched. The surface is the
  gateway's (LLP 0067 #cli); the repair, if that shape ever matters, is for its
  registrant to be its owner, not for the slice to widen.
- **`hyp mcp` is not covered.** Its `runTool` builds the operation context from
  the core `mcp` command's own, so a plugin's `operation` invoked as an MCP
  tool still receives the whole config. Closing it needs a second owner lookup
  keyed by the tool a request named, which is a shape of its own; deferred.
- Cost is one shallow object, one array of `plugins[]` length and one record of
  `sinks{}` size, built once per invocation and only for a plugin-owned
  command, plus one pass over the active plugins' manifests for the
  capability-provider rule (bounded by plugin count, allocating one small
  `Set`). Nothing per-record, nothing per-row, and core's path allocates
  nothing new at all.
