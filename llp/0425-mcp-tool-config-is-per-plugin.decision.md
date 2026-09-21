# LLP 0425: An MCP tool call reads the config its verb's registrar reads

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Plugins, Config, Core
**Author:** Phil / Claude
**Date:** 2026-09-20
**Extends:** LLP 0422#consequences (the residual that decision recorded and deferred: `hyp mcp` built every tool call's operation context from the core `mcp` command's own)
**Related:** LLP 0034, LLP 0105, LLP 0420, LLP 0421, LLP 0423

> LLP 0422 made a plugin's verb `operation` read the plugin's own slice of the
> config, by narrowing `CommandRunContext` once at dispatch and letting
> `buildOperationContext` copy it. `hyp mcp` is the one route with no
> projection to narrow: it is core's own command, so its context carries the
> whole effective config and every `tools/call` ran against it. The surface
> that exists to hand a verb to an AI client was the one surface that still
> disclosed every other plugin's `plugins[]` config and a configured sink's
> inline credential (issue #1982). The host now settles the owner at the instant
> it resolves the tool, before any plugin property runs, and carries it into the
> call.

## Context {#context}

The CLI and the MCP host reach the same `operation` by different keys. The CLI
reaches it through the command a verb projects, which `CommandRegistry.ownerOf`
answers for by the name argv matched, so LLP 0422's narrowing needed no rule of
its own. The MCP host dispatches on the **tool**: `verbs.getByTool(name)`. The
verb name never enters that path, so `VerbRegistry.ownerOf`, keyed by name, had
no question the host could ask it. That is why LLP 0422 #consequences deferred
this rather than widening the CLI fix.

## The owner is captured at the instant the tool is resolved {#tool-owner}

`VerbRegistry` keeps a second ledger of the same registrar, keyed by the tool
name it validated, and answers it as `ownerOfTool(tool)`. Both ledgers are
written from one read of `register`'s validated pair and released together with
the tool slot, so the two keys a verb claims cannot come apart.

The answer is deliberately not derived from `VerbRegistration.tool` at call
time, for the reason LLP 0422 #verb-owner rejected `VerbRegistration.plugin`:
the registry stores the registration by reference and hands it back, so `tool`
is a live plugin property free to answer a neighbour's key. Deriving the owner
from it would have made "which plugin's config do I read" a thing a plugin
could ask for.

**When** the host asks is as load-bearing as **what** it asks. `callTool`
resolves the registration with `getByTool(name)` and then reads plugin-controlled
properties before dispatch: `verb.exposure` and `verb.authClass` (the visibility
gate) and `verb.inputSchema` (argument validation). Any of those can be an
accessor that unregisters this very verb, emptying the tool slot the host is
mid-dispatch on, so a `ownerOfTool` asked after them answers `undefined` for a
plugin verb and the slice widens back to the whole config (issue #1982, the
defect this decision's first shape reopened). So the host captures the owner
from the same resolution that produced the verb, before it reads a single plugin
property, and carries that value into `runTool`. This is the CLI route's order:
`dispatch` settles `commandOwner` from `registry.ownerOf(matched.invokedName)`
before it builds the context or runs any plugin code. Nothing plugin-controlled
runs between `getByTool(name)` and `ownerOfTool(name)`, so the captured owner is
authoritative and no later mutation of the ledger can reach it.

Core's verbs register outside any activation bracket and stay ownerless, and
`undefined` is the signal for "core", not a missing answer: `query_sql` keeps
the whole config on the MCP surface exactly as `hyp query sql` does on the CLI.
Because the owner is captured at the resolution instant and not re-asked later,
this `undefined` can only be a core verb (a present tool with no registrar),
never a plugin verb whose registrar a mid-dispatch `unregister` erased. A host
driving its own verb registry records no registrar for anything, so a registry
with no `ownerOfTool` is read exactly as it was.

## The slice is per owner, and built once for the session {#session-slice}

`hyp mcp serve` is a long-lived process answering many calls from one
`CommandRunContext`, so the *bindings* `ctx.config` and `ctx.plugins` do not
change across the session: no call rebinds them, so a slice built from them
stays a correct slice of the same config. The host keeps each owner's slice in a
`Map` keyed by the owner name and builds it on that owner's first tool call. A
session pays one slice per plugin that owns a tool, bounded by the active plugin
set, rather than the per-invocation slice the CLI route pays once and exits.

This says nothing about *mutation*. `pluginScopedConfig` returns a shallow
`{...config}`, so core's own sections (`query`, `version`, `disambiguate`,
`auto_update`) and the owner's own `plugins[]` entry are carried by reference
into every slice (LLP 0422 #scope documents this deliberately: core code reads
the same `query` block to resolve `--remote`). A tool's `operation` that mutates
one of those objects therefore changes what a later call in the same session,
core's `query_sql` included, resolves out of it. On the CLI this sharing exists
too but the process handles one command and exits; the long-lived host is what
makes it cross-call. Whether to freeze or copy those shared sections is left
open here and tracked separately (issue #1992): it is a cross-surface change to
`pluginScopedConfig`, and LLP 0421 #shapes measured that freezing and copying a
live record broke shipped identity checks, so the trade wants its own decision
rather than a slice-site patch.

## Consequences {#consequences}

- The config member is now the only part of the MCP operation context that
  differs by caller. `refresh` is still `'auto'` for every tool and `callerCwd`
  is still the host process's cwd (LLP 0105 #unknown), because neither is a
  question about who registered the verb.
- `runTool` takes the resolved owner as a third argument, and the host settles
  it (via `ownerOfTool`) at the instant it resolves the tool, before it reads
  any plugin property. It is the server assembly's only new coupling to the
  host, and it carries the captured owner rather than a registration or a key to
  re-resolve, which is what keeps a mid-dispatch `unregister` from widening the
  slice.
- Per tool call the host allocates the operation context it already allocated,
  plus a `Map` lookup. The slice itself, one shallow object, one array of
  `plugins[]` length and one record of `sinks{}` size (LLP 0422 #scope), is
  built once per owner per session. Nothing per-record, nothing per-row, and
  core's tools allocate nothing new at all.
- This closes the last route LLP 0422 left open. `--remote` and the stdio proxy
  are unaffected: both run the operation on the server, which builds its own
  context.
