# LLP 0420: A plugin-contributed command body reaches the registries through its own facade

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-09-20
**Extends:** LLP 0004#the-activation-context (the per-plugin facade rule now holds for the second context a plugin reaches the registries through), LLP 0009#core-owns-dispatch (core, which routes argv to the owning command, is also what records who owns it)
**Related:** LLP 0006, LLP 0012, LLP 0014, LLP 0130, LLP 0136

> `CommandRunContext` handed every command body the kernel's own
> `capabilities`, `sources` and `sinks`. Registering a command is a supported
> plugin extension point, so a plugin that contributed one held a second,
> unfaceted context: whatever `createSinksFacade` and `createSourcesFacade`
> refuse on `ctx`, the same plugin got for free inside its own `run()`
> (issue #1970). This splits the context by whether the command is a
> plugin's or core's.

## Context {#context}

LLP 0004 says a plugin reaches the registries through per-plugin facades, and
six issues made that true member by member: `ctx.sources` (#1944, #1946,
#1947, #1950, #1953, #1960) and `ctx.sinks` (#1961). Each closed the
**activation** door.

There are two doors. `createActivationContext` builds the one `activate()`
sees. The dispatcher builds the other, `CommandRunContext`, and it was the
kernel's registries verbatim. So a plugin that registered no sink at all
reached a neighbour's configured instance from inside its own command body:
the handle the sink driver calls, its `config` with whatever inline
credential the operator wrote, a `reader()` over the exported rows, a
writable `sink`, and a `closeAll()` that removed the neighbour's instance
from the registry with the neighbour's own `close()` never running.

The difference from #1961 is *when*, not *whether*. A command body runs only
from `dispatch`, so a plugin that merely loads gains nothing; but it runs on
any invocation of a command the plugin contributed, and through the
`ctx.commands.run` seam (LLP 0130), where the `hyp init` wizard runs a picker
row's `configure_command`. A user who picked a row reaches it without typing
the command's name. A CLI process holds the same credentials and reaches the
same destination as the daemon.

## Decision {#split}

The dispatcher splits `CommandRunContext.capabilities`, `.sources` and
`.sinks` by who owns the command it is about to run:

- A **plugin-contributed** command gets the very facades that plugin's
  `activate()` holds, read back from `KernelRuntime.activationContexts`. A
  plugin's command sees exactly what its activation sees, not a third
  narrowing that could drift from either.
- A **core** command keeps the raw registries. `hyp status` and `hyp sync`
  render every plugin's sources and sinks, `hyp sink maintain` drives them,
  and the wizard harvests them. Rendering that is core's job
  ([LLP 0009 #core-rendered-status](./0009-cli-registry.spec.md#core-rendered-status)),
  and no per-plugin facade can answer for a surface that is about all of them.

Everything else on the context is unchanged, and deliberately: `query`,
`storage`, `verbs`, `skills`, `agents`, `clients`, `initPresets`,
`backfills` and `backfillMaterializers` are already the raw registries on the
activation context too, so leaving them is the same-as-`activate()` rule, not
an exemption from it. `config` is the one member that rule does not cover:
activation narrows it to the plugin's slice, and `CommandRunContext.config`
stays the whole effective config, so a plugin-owned command body reads every
section, a neighbour's inline credentials included. That is a scope call
left open, not a boundary this decision provides; narrowing it to the slice
`activate()` gets is issue #1978.

## Who owns a command {#owner}

The owner is recorded by `CommandRegistry` inside a `registeringAs` bracket
and read back with `ownerOf(name)`, the way `SourceRegistry` and
`SinkRegistry` already bind a contribution to its registrar. The per-plugin
`ctx.commands` facade is what brackets.

It is deliberately **not** `CommandRegistration.plugin`. That field is
written by the plugin, and `get()`/`list()` hand the stored record back to
the plugin that registered it, so it is plugin-controlled twice over: a
registration may omit it, and one that declares it can rewrite it afterwards
to a neighbour's name, which would have turned the fix into a way to *ask
for* a neighbour's facade.

Core registers its commands on the registry directly, outside any bracket, so
a core command has no owner and the discriminator needs no allow-list to
maintain. A registry a host injected that carries no `ownerOf` falls back to
the declared field: narrower than the raw registries it had before, and the
same tolerance `createSinksFacade` extends to a registry without `ownerOf`.

## Consequences {#consequences}

- A command a **verb** projected (LLP 0034) has no recorded registrar, since
  the verb registry registers the projection itself, so it keeps the raw
  registries. As registered, nothing reaches a plugin through it: the
  projected `run` is kernel code (`runVerbCommand`), and the
  `VerbOperationContext` it builds for the plugin's `operation` carries
  `query`, `storage`, `config`, `env`, `refresh`, a no-op `log` and
  `callerCwd`, none of them a route back to a registry. But "as registered"
  is load-bearing: the stored record's `run` is writable (next bullet), so
  an ownerless projection is one of the records a plugin can rewrite.
- This split narrows what an honestly registered command body receives. It
  is **not yet a boundary against a hostile plugin**: `get()` and `list()`
  hand back the stored, mutable record, and `run` is the field that decides
  whose code executes. A plugin can assign `ctx.commands.get(name).run` on
  any ownerless command (every core command, every verb projection) and run
  its own code with the raw registries, or on a neighbour's command and run
  with the neighbour's facades. Closing that is a design decision of its own
  (freezing the record breaks 13 existing tests), deferred to issue #1977.
  Until it lands, #1970's "a plugin cannot shadow `hyp status`" holds for
  registration only, not for the stored record's body.
- The `ctx.commands.run` seam needs no rule of its own. It re-enters
  `dispatch`, which resolves the owner of the command actually invoked, so a
  core command running a plugin command narrows into it and a plugin command
  running a core command gets an exit code, not a context.
- A plugin command that genuinely needs a cross-plugin value asks for it the
  way `activate()` does, through `requireCapability` (LLP 0006). No bundled
  plugin's command body reads `ctx.sinks`, `ctx.sources` or
  `ctx.capabilities` today; `@hypaware/gascity`'s attach/detach commands
  already drive their source through the facade their activation stored.
