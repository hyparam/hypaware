# LLP 0421: The body dispatch runs is the one the registry validated

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-09-20
**Extends:** LLP 0420#consequences (the residual that decision recorded and deferred: the owner split narrows what a command body receives, but not whose body runs)
**Related:** LLP 0004, LLP 0009, LLP 0034, LLP 0130, LLP 0264

> LLP 0420 split `CommandRunContext` by who owns the command about to run,
> and read the owner off a registry-private map so a plugin could not claim
> a neighbour's. It still read the **body** off the stored record, which
> `get()` hands to the registering plugin and which nothing freezes. So
> `ctx.commands.get('status').run = mine` put a plugin's code behind a
> command the dispatcher resolves as core's, raw registries and all
> (issue #1977). The registry now keeps the registered `run` where the
> registrant cannot reach it, and dispatch asks for it by name.

## Context {#context}

LLP 0420 #owner established the shape: a question the dispatcher needs an
honest answer to is answered by a value core recorded, not by a field on the
plugin's own registration. `owners` is that map and `ownerOf(name)` reads it.

The shape was applied to one question and not to the one underneath it. The
dispatcher ran `matched.command.run(...)`, and `matched.command` is the
record `byName` holds, which `get()` and `list()` hand back to the
registering plugin during `activate()`. `run` is an ordinary writable
property on it. Three routes followed, all measured through the real
`dispatch()` on `7f3a7f88`:

- A **core** command. `ownerOf('status')` is `undefined`, so the body gets
  `kernel.capabilities`, `kernel.sources` and `kernel.sinks` verbatim. The
  rewritten body reported `{raw: true, rawSources: true, rawCaps: true}`,
  read a neighbour's inline `SECRET-TOKEN` off a configured sink instance,
  and landed a forged `exportBatch` at that neighbour's destination.
- A **verb projection** (LLP 0034). The verb registry registers the
  projection itself, outside any `registeringAs` bracket, so it is ownerless
  in exactly the same way. LLP 0420 #consequences already named this one: the
  projected `run` is kernel code, but "as registered" was load-bearing.
- A **neighbour's** command. The rewritten body ran under the neighbour's
  facades, which is the second half of what issue #1977 asks for: no plugin
  runs its code under another plugin's recorded ownership.

So the split LLP 0420 landed was a narrowing of what an honestly registered
command body receives, and not a boundary. This decision closes that.

## The registered body is registry-private {#private-body}

`CommandRegistry` keeps the `run` each registration was accepted with in a
private map keyed by the primary name it validated, beside `owners`, and
answers it through `bodyOf(name)`. `bodyOf` accepts whatever `get` accepts
and resolves an alias the way `ownerOf` does, so a command invoked by an
alias runs the same function as one invoked by its primary name.

`dispatch` calls that body. It is called **on** the stored record, so a
registration whose `run` is written as a method of itself sees the `this` it
saw before. A registry with no `bodyOf` (a host's own, injected) falls back
to `matched.command.run`, which is the reach it had before and the same
tolerance LLP 0420 #owner extends to a registry with no `ownerOf`.

`get()` and `list()` are unchanged: they still hand back the stored record,
still unfrozen. A plugin may still rewrite `run` on it. The rewrite simply
stops deciding anything, the way rewriting `CommandRegistration.plugin`
stopped deciding anything when the owner moved into the registry.

## Why not freeze, and why not copy {#shapes}

Both alternatives were measured against the suite rather than argued. The
baseline is three failures from a local `node_modules` that lags its
manifest.

`Object.freeze(record)` before `byName.set`: **13 existing tests break**.
They are not incidental. `CommandRegistry.list` is written to survive a
record whose `name` accessor throws or stops answering with a string
(#1555, after #1524 and #1519), and the plugin doctor's whole accessor
refusal suite is written to contain a record that turns hostile *after* it
registered. Every one of those tests arms its accessor on the object
`get()` returns, because that is the only way to make the stored record
hostile from outside the registry. Freezing does not make those tests
wrong: it removes the ability to write them, while the tolerance they hold
the code to is still the behavior the code needs in production, where a
plugin can redefine its own properties any time after `activate()` returns.

Returning a copy from `get()`/`list()`: **35 existing tests break**, and the
losses are in shipped code, not fixtures. `registeredName` and
`registeredAliases` in `src/core/plugin_doctor/dry_run.js` vouch for a name
by resolving it back through the registry and comparing identity
(`resolve(record, claimed) === held`, `commandRegistry.get(alias) !== record`).
A copy never reads back as the record it came from, so every command and
every alias is reported unreadable and `hyp plugin doctor` stops saying
anything true. The copy also has the hazard #1969 declined to take in the
sink registry: a spread reads the plugin's accessors, so copying inside
`list()` runs one plugin's `get name()` inside `hyp --help`, group help, and
the doctor's dry run, which is the escape #1555 took out of the listing path.

The private map has neither cost. It leaves every handed-out object exactly
as it was, so nothing that depends on record identity or on the registry's
deliberate tolerance of a hostile record changes, and it reads a value the
plugin never held.

## Consequences {#consequences}

- LLP 0420's owner split is now a boundary and not only a narrowing. Both
  halves of the discriminator (who owns the command, and whose code runs as
  it) are values core recorded at registration.
- A plugin can still rewrite anything else on the stored record. Nothing
  else routes: `name` is not the key `byName` or `owners` are read by, the
  listings order by key, and `plugin` stopped deciding the facades in
  LLP 0420. What a rewritten `summary` or `hidden` costs is the plugin
  doctor's report, which already refuses what it cannot vouch for.
- `CommandRunContext.config` is still the whole effective config for a
  plugin-owned command body, so a neighbour's inline credentials are
  readable there. That is untouched by this decision and stays where
  LLP 0420 #split left it, as issue #1978.
  **Settled by [LLP 0422](./0422-command-config-is-per-plugin.decision.md):**
  `config` is narrowed to the owner's slice, so this bullet records what this
  decision left open and is no longer the current behavior.
- One `Map` entry per registered command, one lookup per dispatch, and no
  per-invocation allocation. The entry is written once at registration and
  released by `unregister` with the name's owner.
