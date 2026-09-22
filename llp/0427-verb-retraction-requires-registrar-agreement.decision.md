# LLP 0427: Retracting a verb's projected command requires the recorded registrars to agree

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-09-20
**Extends:** LLP 0424#consequences (the bullet that decision recorded: the `VERB_PROJECTION` forge reaches the same deletion the facade refusal closed, held as issue #1987)
**Related:** LLP 0009, LLP 0034, LLP 0264, LLP 0314, LLP 0420, LLP 0421, LLP 0422, LLP 0423

> `VerbRegistry.unregister` retracted the CLI command under a released verb
> name whenever `isVerbProjection(commandRegistry.get(name))` answered true.
> The mark that test reads is an enumerable symbol on a record
> `ctx.commands.get` hands back live, liftable off any real projection with
> `Object.getOwnPropertySymbols` and stampable onto a neighbour's command, so
> a plugin forged it, squatted a verb of the victim's name, released it, and
> the kernel deleted the neighbour's command for it, `hyp status` included
> (issue #1987). `retractCommand` now also requires the released verb's
> recorded registrar to equal the one the command registry recorded for the
> name, two bindings the kernel wrote inside `registeringAs` brackets and no
> plugin write reaches.

## Context {#context}

The mark was accepted as forgeable on an explicit premise, recorded in
`src/core/cli/verb_command.js`: it separates a verb projection from a plugin
command that happens to share the name, and "the only thing forging it buys a
plugin is having its own command retracted". LLP 0424 #consequences measured
that premise false the day it closed the direct route (issue #1980): with
`ctx.commands.unregister` bracketed, the forge still removed a neighbour's
command and a core command, after which the squatter registered the freed name
and its body ran under its own recorded ownership. That bullet said the
premise "wants revisiting rather than the refusal above widening", and held
the gap as issue #1987. This decision is that revisit.

Measured at `a175baff` through the real `dispatch()`, two fixture plugins on
one kernel and one command registry:

```
A registers 'acme sync'                        ownerOf === '@fixture/a'
B registers a verb of its own, lifts the mark  Object.getOwnPropertySymbols ->
                                               [ Symbol(hypaware.verbProjection) ]
B stamps it on ctx.commands.get('acme sync'), registers verb 'acme sync'
  (no projection: the command name is taken), releases it
  registry.has('acme sync')                    === false
same lines against 'status'                    === false
B registers both names                         hyp status prints B's string,
                                               ownerOf === '@fixture/b'
```

## The premise, revisited {#premise}

The refusal LLP 0424 landed does not widen here, for the reason its
consequences bullet gave: the caller doing this deleting is the kernel, on the
registry it owns, and nothing about the owner of the *name as a facade
argument* is what it gets wrong. What is wrong is that an unforgeable fact,
"this released verb projected this command", was being read off a forgeable
mark on a plugin-reachable object. A plugin-stamped symbol is a plugin-declared
field, and every prior instance of this defect class (LLP 0420 through
LLP 0425) was closed the same way: the discriminator moved to something the
kernel recorded.

The mark itself is not retired, because half of what it answers is still not
forgeable into harm and still not answerable any other way. LLP 0264 #verb's
objection to a per-registry projection ledger stands: `registerCoreCommands`
pre-projects every core verb before the kernel boots, so a ledger of "names
*this* registry projected" is empty for exactly the core verbs a host
displaces, and would leave `hyp query sql` routed at the verb the host just
took the tool slot from. The mark answers *what* the command is, a projection
rather than a plugin's own command sharing the name, and that half was never
the defect.

## Two facts, both kernel-recorded {#two-facts}

Retraction now requires both:

- **The mark**: `isVerbProjection(commandRegistry.get(name))`, unchanged. A
  plugin's own command that merely shares a released verb's name survives,
  whoever releases it.
- **Registrar agreement**: `commandRegistry.ownerOf(name)` equals the
  registrar the verb registry recorded for the released verb, read before the
  verb's own ledger entry is deleted. Both sides are written only inside
  `registeringAs` brackets (LLP 0420 #owner, LLP 0422 #verb-owner), never read
  off a registration, so no plugin write moves a name from one answer to the
  other.

The two ledgers agree by construction on every legitimate path. A plugin's
verb projects its command inside the command registry's bracket under the same
registrar (LLP 0422 #verb-owner), so its release compares equal names. A core
verb is registered outside any bracket and is ownerless, and the pre-boot core
projection it retracts is ownerless too, so core retracting core, and the host
displacement LLP 0264 #verb rests on and LLP 0314 #sequencing keeps as the
bridge, compare `undefined === undefined`. The forge is the only path on which
they disagree: the squatter's verb carries the squatter's name and the victim's
command carries the victim's, or nobody's.

A command registry without `ownerOf`, or without the `registeringAs` bracket
that is, in the registry this repo ships, the only thing that ever fills it,
retracts on the mark alone: the tolerance LLP 0420 #owner and LLP 0424
#unknown extend to a host's own injected registry, which records no registrar
for anything, so there is no binding to read. Both members are tested, because
the projection keys its own tolerance on the bracket (LLP 0422 #verb-owner):
against a registry answering an `ownerOf` nothing ever fills, every plugin
verb's projection reads ownerless while the verb registry holds the plugin, so
enforcing agreement there would refuse every legitimate release and leave its
command behind. A host registry that filled `ownerOf` by some other means
would skip the agreement check on the strength of a premise it does not hold;
no registry in this tree is that shape, neither member is on the published
`CommandRegistry` contract, and no plugin can produce one, so the premise is
recorded here rather than enforced. The refusing branch warns
(`verb.retract.registrar_mismatch`) the way the two tolerated branches already
did, because the caller's prescribed success check is `getByTool`, which the
map deletions satisfy either way, so a refusal that stayed silent would read as
a win. It names both registrars, the way `command.unregister_owner_mismatch`
does: this warn is the whole signal a squat leaves, and the verb name alone
cannot say which plugin to remove.

## What this costs, and what it leaves open {#consequences}

- **One `ownerOf` lookup and one `Map.get` per verb release, and releases are
  rare.** Nothing per-record, nothing per-dispatch, no allocation outside the
  refusal path, which builds its strings only when it refuses.
- The mark stays enumerable, liftable, and stampable; forging it now buys a
  plugin what the premise always said it did: its own command retracted when
  a verb name it owns is released, which `ctx.commands.unregister` already
  allows it directly.
- `ctx.commands.get` still hands back a neighbour's live record, unfrozen
  (LLP 0421 #shapes, deliberately). Of the two readers LLP 0424 #consequences
  named, `retractCommand` no longer routes a deletion on what a plugin wrote
  there; `renderCommandHelp` still renders `summary`, `usage` and `help` as
  they read at dispatch time, so a rewrite still reaches what
  `hyp <name> --help` prints. That is prose, not a body, an owner, or a
  deletion, and stays open.
- Issue #1980 closes with this: the direct route was refused by LLP 0424, and
  the forge was the one spelling that survived it.
