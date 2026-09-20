# LLP 0423: A plugin reads, releases and runs only the verbs it registered

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-09-20
**Extends:** LLP 0422#consequences (the carve-out that decision recorded: `ctx.verbs` was a narrowing for honest plugins and not a boundary), LLP 0421#private-body (the same shape, reaching the pair a verb projection closes over)
**Related:** LLP 0004, LLP 0009, LLP 0033, LLP 0034, LLP 0130, LLP 0264, LLP 0420

> LLP 0422 gave a verb a registrar, so the CLI command it projects is
> attributable, and recorded in the same breath that the rest of `ctx.verbs`
> was not a boundary: the read members hand back the stored registration by
> reference, `verb.operation` is the function the projection runs, and
> `unregister` checks no owner. So a plugin put its own code behind
> `hyp query sql` and read a configured sink's inline token out of core's
> context, or took any verb off both surfaces (issue #1983). The registry now
> keeps each verb's `operation` and `render` where the registrant cannot reach
> them, records who registered it, and the facade narrows what a plugin reads
> of a verb it does not own.

## Context {#context}

Measured through the real `dispatch()` on `ce2885ac`, from a fixture plugin
`@fixture/squatter` that registered no verb at all, with `PLACEHOLDER-*`
values standing where an operator's credentials would sit:

```
ctxB.verbs.get('query sql').operation = mine
hyp query sql "select 1"        ->  exit 0, stdout rendered from mine's rows
mine saw params {"sql":"select 1","include-local-only":false}
```

`list()` is the same reach without needing the name, and `getByTool()` is the
same reach keyed by the MCP tool. `ctxB.verbs.unregister('<A's verb>')`
returned cleanly and took the neighbour's verb off the name map, the tool map
and the CLI.

Three shapes were already settled for the sibling registries, and the answer
here is assembled from them rather than invented:

- **LLP 0420 #owner / #split.** Who registered a thing is a value core
  recorded, and the dispatcher splits the context by it.
- **LLP 0421 #private-body.** *Whose code runs* is also a value core recorded,
  kept where the registrant cannot reach it. That decision named the verb
  projection as a case it did not close: the projected `run` is kernel code,
  so `bodyOf` answered honestly with `runVerbCommand`, and the two plugin
  functions the closure read were still live properties of the stored record.
- **#1953 / #1969.** A read member that hands a neighbour's live object over
  is a write channel; the answer is a view that reads *through* rather than a
  copy, because a copy runs one plugin's accessors inside another's call.

## The operation and render dispatch runs are registry-private {#private-body}

`validateVerb` returns `operation` and `render` as **values**, for the reason
it already returned `name` and `tool` as values: every read of a plugin
property is a fresh answer, so a member that cleared `typeof === 'function'`
at registration was free to answer with something else by the time it ran.

The projection closes over that pair. `verbToCommand(verb, name, body)` takes
it the way it already takes the validated name, and `runVerbCommand` calls
`body.operation` and `body.render` rather than re-reading the registration.
Both are called **on** the registration, so a verb written as a method of its
own object sees the `this` it saw before, exactly as LLP 0421's `bodyOf` is.

**The closure is the private storage, and there is deliberately no `bodyOf`
to go with `ownerOf`.** LLP 0421 needed a lookup member because the command
registry only *holds* a record and the dispatcher is what calls it; this
registry **builds** what dispatch runs, so it can hand the pair straight into
the projection. A lookup member would be a public read member on a registry
the per-plugin facade reads through to by default, answering with the live
pair by reference: the defect this decision closes, one member along. The
same rule applies to anything added here later. `ownerOf` is safe to read
through because it answers with a plugin name, which the roster already
publishes.

A caller with no registry behind it still captures once. `registerCoreCommands`
pre-projects every core verb so `hyp --help` renders before the kernel boots,
and the default argument reads the pair there, at projection time, instead of
on every dispatch. That is what closes `hyp query sql`: the command the
dispatcher routes is the pre-boot projection, and the verb registry skips its
own projection when the name is already taken (LLP 0264 #verb).

The registry's own `get()`, `getByTool()` and `list()` still hand back the
stored record, still unfrozen, and so does a registrant's `ctx.verbs.get(name)`
for its own verb. Through the facade, `getByTool` and `list` narrow even the
owner's own entry, for the keying reason #facade gives, so a registrant asks
`get` by the name it registered under. Either way a plugin may still rewrite
its own `operation`, because it holds the object it registered. The rewrite
simply stops deciding anything, the way rewriting `CommandRegistration.plugin`
stopped deciding anything in LLP 0420.

## A plugin drives and reads the verb table through its own facade {#facade}

`VerbRegistry` records the registrar in an `owners` map, keyed by the
validated name and written only inside the `registeringAs` bracket LLP 0422
#verb-owner introduced, and answers it through `ownerOf(name)`. That is the
same value `CommandRegistry.ownerOf` answers for the command the verb
projected, so the two surfaces a verb claims agree about who owns it, and it
is deliberately not `VerbRegistration.plugin`, for the reason LLP 0420 #owner
rejected `CommandRegistration.plugin`.

`createVerbsFacade` brackets four more members against it:

- **`unregister`** refuses a verb this plugin is not recorded as having
  registered, which includes one the registry recorded no registrar for at
  all: a core verb is nobody's to retract from inside an activation. The
  refusal warns with the owner it found, the way a foreign source lifecycle
  call does. A **host** displacing a kernel-shipped verb (LLP 0264 #verb,
  LLP 0314 #sequencing) drives the registry itself and never sees a facade, so
  that affordance is untouched.
- **`get`** narrows a verb this plugin does not own to a read-only view. The
  name it is asked for is the key the registry validated and the key `ownerOf`
  answers on, so a plugin's own registration comes back unchanged and by
  identity.
- **`getByTool` and `list`** narrow every entry. Neither is keyed by that
  name, and the only name on a registration is `verb.name`, a live plugin
  property this registry already refuses to treat as a key and one a hostile
  verb could make answer with a neighbour's precisely to be handed that
  neighbour's object. A plugin that wants its own registration back by
  identity asks `get` for it by the name it registered under, as with
  `ctx.sources`.

The view is `narrowView`, the same read-through proxy `ctx.sinks` narrows a
handle with: the declarative fields of `VerbRegistration` read through to the
registration, `operation` and `render` replaced by refusals of the kernel's
own, and writes, defines, deletes and reparenting refused. Read through rather
than copied, so no accessor of the registering plugin's runs inside a
neighbour's `list()`. Views are cached per registration in a `WeakMap`, so
repeated reads keep a stable identity and live exactly as long as the verb.

`CommandRunContext.verbs` joins the split by the owner the dispatcher already
resolved: a plugin-owned command body gets that plugin's own `ctx.verbs`
facade, and a core command keeps the raw registry, because `hyp mcp` assembles
its tool list from every active plugin's verbs and that is core's job
(LLP 0009 #core-rendered-status). One discriminator, `ownerOf(invokedName)`,
unchanged from LLP 0420 #split.

## What this costs, and what it leaves open {#consequences}

- LLP 0422 #consequences recorded `ctx.verbs` as a narrowing for honest
  plugins rather than a boundary, and `CommandRunContext.verbs` as the raw
  registry. Both are now the boundary that bullet said they were not. The
  bullet stands as the record of what that decision left open.
- **A plugin's own registration is still its own.** It holds the object it
  registered and may rewrite anything on it at any time, with or without a
  facade. Nothing the kernel runs reads those rewrites: the body is the
  validated pair, the keys are the validated strings, and the listings order
  by key. What a rewritten `summary` costs is the plugin's own help line.
- **`inputSchema` and `aliases` are handed through by reference, and their
  contents stay shared.** The view refuses *rebinding* either member on a
  neighbour's registration, and nothing refuses a write inside the object it
  answers with. Measured from a narrowed view of core's `query sql`, held by a
  plugin that registered no verb at all: setting
  `view.inputSchema.properties['include-local-only']` to
  `{ type: 'boolean', default: true }` makes a plain `hyp query sql "select 1"`
  hand core's operation `include-local-only: true`, and makes `listTools()`
  advertise that default to an MCP client with the warning the replaced
  property carried gone with it, so the LLP 0105 control flips on both
  surfaces with no flag typed; `view.inputSchema.required.push(...)` exits
  every later `hyp query sql` at 2. The residual is therefore a disclosure and
  an availability hazard and not only a correctness one. What it is not is a
  credential: the schema carries the argv codec's rules. It is held as issue
  #1985 rather than settled here, because the shapes that close it (a copy
  taken once per view, so it is not per-call work, or a freeze of the
  registrant's own object) each trade something this decision has no
  measurement for, and `narrowView` is where that measurement belongs.
- **`hyp mcp`'s `runTool` still reads `verb.operation` off the registration.**
  The MCP host holds the kernel's raw registry and `hyp mcp` is a core
  command, so no plugin reaches that property through a facade any more and
  nothing can rewrite it; the read is of a value only the registrant can
  change. Making that path run the validated pair too needs the same tool-keyed
  owner lookup `hyp mcp` already owes (LLP 0422 #consequences, issue #1982)
  and belongs with it.
- **`ctx.commands.unregister` is still forwarded unbracketed**, so the owner
  check here has no twin on the command registry yet (issue #1980). The two
  registries now answer `ownerOf` the same way, so that fix is the refusal
  above in the other facade.
- Cost is one `Map` entry and one two-field object per registered verb, both
  written once at registration and released with the name, plus one `WeakMap`
  lookup per narrowed read and one proxy per neighbour verb a plugin actually
  reads. Nothing per-record, nothing per-row, and the dispatch path allocates
  nothing new: the projection closes over the pair instead of reading two
  properties.
