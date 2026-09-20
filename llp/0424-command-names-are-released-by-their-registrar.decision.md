# LLP 0424: ctx.commands.unregister releases only the names its plugin registered

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-09-20
**Extends:** LLP 0423#consequences (the bullet that decision recorded: `ctx.commands.unregister` was still forwarded unbracketed, so the owner check it landed on the verb facade had no twin on the command registry)
**Related:** LLP 0004, LLP 0009, LLP 0034, LLP 0130, LLP 0264, LLP 0420, LLP 0421, LLP 0422

> `createCommandsFacade` pinned `register` and `registeringAs` and forwarded
> everything else to the registry, `unregister` among them. The registry's own
> is by-name and checks no owner, so any plugin released any command it could
> name and then claimed the freed name: `ctxB.commands.unregister('acme sync')`
> took a neighbour's command off the CLI, and the same two lines put a plugin's
> body behind `hyp status` (issue #1980). The facade now reads the owner the
> registry recorded, on the name as passed, and refuses a name that is not this
> plugin's to release.

## Context {#context}

LLP 0423 #consequences named this and named the fix: the two registries answer
`ownerOf` the same way, so the refusal that decision landed on `ctx.verbs`
wanted a twin on `ctx.commands`. This is that twin.

What the gap cost, measured at `71c3ec83` through the real `dispatch()` with
two fixture plugins on one kernel and one command registry:

```
A registers 'acme sync'            ownerOf('acme sync') === '@fixture/a'
B: ctx.commands.unregister(...)    has('acme sync') === false
hyp acme sync                      exit 2, "hyp: unknown command 'acme sync'"
B registers its own 'acme sync'    exit 0, B's body ran, ownerOf === '@fixture/b'
B: ctx.commands.unregister('status')  then registers its own
hyp status                         exit 0, prints what B chose
```

It is not reach. The re-registration goes through the bracketed `register`, so
`owners` records the squatter and its body runs under its own facades
(LLP 0420 #split, LLP 0421 #private-body). What it takes is **availability and
attribution**: a plugin removes any other plugin's CLI surface, core's
included, unopposed and unlogged, and can answer a name the user trusts.

## The owner is read on the name as passed {#alias}

`createCommandsFacade.unregister` calls `ownerOf(name)` and refuses unless the
answer is this plugin, warning with the owner it found the way a foreign source
lifecycle call does (LLP 0420 #owner is the binding; the refusal shape is
`createSourcesFacade`'s).

The name is used as the caller passed it, and that is the whole of the
difference between this facade and the verb one. **This registry resolves
aliases and the verb registry does not.** `get`, `has`, `ownerOf`, `bodyOf` and
`unregister` all accept either the primary name or one of its aliases, and
`unregister` of an alias removes the command and *every* alias pointing at it
(LLP 0264 #verb: an alias left behind keeps the name unclaimable and routes
argv at a command that is no longer registered). So a check written against
primary names would refuse the obvious spelling and pass
`unregister('<an alias>')`, which is the same deletion by another key: correct
looking and useless.

Resolving the alias is also what the registrant is entitled to. `ownerOf`
answers the owner of the command an alias points at, so a plugin releases its
own command under either spelling and a neighbour's under neither.

## An unknown name is refused, not ignored {#unknown}

`CommandRegistry.unregister` is by-name, idempotent and total on a name nothing
holds, because its one caller is `retractCommand` in
`src/core/registry/verbs.js`, retracting the CLI command a verb projected, and
a throw there would take daemon boot down.

The facade is not that caller and does not inherit that tolerance. It reads an
owner, and a name nothing registered answers `undefined`, which is the same
answer a core command gives: nobody's. Both are refused, in the same words, by
the one rule. That is what `ctx.verbs.unregister` already does, so the two
facades still read alike and there is no third behaviour to learn. The kernel's
own path is untouched: `retractCommand` drives the registry the runtime was
built with and never sees a facade, and a host displacing a kernel-shipped verb
(LLP 0264 #verb, LLP 0314 #sequencing) drives it directly too.

`unregister` stays optional on the declared contract, so a registry that never
offered one does not acquire one here, and a registry with no `ownerOf` (a
host's own, injected) is left releasing exactly as it did, for the reason
LLP 0420 #owner and LLP 0423 #facade extend that same tolerance: a host records
no registrar for anything, so there is no binding to read.

## What this costs, and what it leaves open {#consequences}

- LLP 0423 #consequences recorded `ctx.commands.unregister` as forwarded
  unbracketed. It no longer is. That bullet stands as the record of what that
  decision left open.
- **One `ownerOf` lookup per release, and releases are rare.** No allocation on
  any hot path, nothing per-record, nothing per-row, and the refusal path
  builds its strings only when it refuses. The dispatch path is untouched.
- **`get`, `list` and `match` hand back the stored record by reference, a
  neighbour's and core's included**, unfrozen, which LLP 0421 #shapes measured
  the alternatives to and kept deliberately. Nothing that decides whose body
  runs, who owns a name, or how a listing orders reads those rewrites: the
  body is the validated function (LLP 0421 #private-body), the owner is the
  recorded registrar, and the listings order by key. Two things do read the
  live record: `retractCommand` routes a deletion on
  `isVerbProjection(commandRegistry.get(name))`, which is the forge below, and
  `renderCommandHelp` renders `summary`, `usage` and `help` as they read at
  dispatch time, so `hyp <name> --help` prints what a neighbour wrote onto a
  record it does not own (measured: B rewrote A's `summary` and `--help`
  printed B's string, A's gone).
- **The `VERB_PROJECTION` forge is a second spelling of this deletion, and it
  is still open.** `verb_command.js` documents that the mark is liftable with
  `Object.getOwnPropertySymbols` off any real projection, and `ctx.commands.get`
  hands a plugin a neighbour's live record to stamp it onto; the plugin then
  registers a verb of that name (the projection is skipped, because the command
  name is taken) and releases it, and `retractCommand` deletes what now looks
  like its own projection. Measured after this decision landed, it still
  removes a neighbour's command, and a core command with it: the same lines
  took `status` off the registry, and the plugin then answered `hyp status`
  with its own body under its own recorded ownership, which is issue #1980's
  headline harm by another spelling. It was accepted on the premise that forging
  the mark buys nothing, and it buys exactly this, so the premise wants
  revisiting rather than the refusal above widening: the caller doing the
  deleting is the kernel, on the registry it owns, and nothing about the owner
  of the *name* is what it gets wrong. Held as issue #1987.
- **Groups are outside this decision.** `registerGroup` stays forwarded with
  no owner check, last write wins across owners, and the caller's group object
  is stored and handed back by reference through `getGroup` and `listGroups`
  (measured: B's `registerGroup({ name: 'acme', ... })` displaced A's outright).
  A group is metadata with no `run` (LLP 0214 #d2), so what this reaches is
  the prose `hyp <group> --help` renders, never a body, an owner, or dispatch.
