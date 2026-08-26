# LLP 0314: One `grep_search` Registration With an Injected Backend

**Type:** RFC
**Status:** Accepted
**Systems:** Query, MCP, Plugins
**Author:** Brendan / Claude
**Date:** 2026-08-25
**Related:** LLP 0034, LLP 0105, LLP 0265, LLP 0302, LLP 0303;
hypaware-server LLP 0129, LLP 0178, LLP 0184 (out of tree, the server half)
**Supersedes:** LLP 0264#verb (the registration-collision rule only; the
mirror decision and the shared column allowlist stand unchanged)

## Context {#context}

[LLP 0264](./0264-grep-search-mirrors-the-server.decision.md) shipped
`hyp query grep` as a read-class core verb whose tool is the server's own
`grep_search`, so that `--remote <target>` reaches the server's
archive-backed search with no server-side feature work. Sharing the tool
name is the feature, not an accident.

`#verb` of that document also decided what happens when both registrants
are in one process. On a server host the kernel boots before the daemon
wires up, so the twin holds the tool name first; the server takes it back
through `unregister`, which the kernel gained for exactly this
(`src/core/registry/verbs.js`). That rule shipped on both sides.

## The collision is structural, not incidental {#collision}

Taking the name back put an arbitration problem in the server that keeps
producing work. The registry keeps two unique keys, the verb name and the
tool name, and refuses a duplicate of either. The daemon's `register` runs
inline during wiring with nothing above it to catch a throw, so a
collision it fails to detect is a dead server rather than a missing verb.

Server-side that has cost two decisions (hypaware-server LLP 0178 and LLP
0184), a dedicated guard module (`src/search/verb-slot.js`), four pull
requests and two follow-up issues, and the guard is still only as good as
what the registry can be asked. It can see which key a registration holds.
It cannot see whether the holder is this kernel's twin, a plugin, or a
third party that picked a natural name, and the identity is what an
operator needs when a verb vanishes at boot.

None of that arbitration buys a capability. Both registrants implement the
same contract; only the data plane differs, and which one should answer is
known at wiring time by the host itself.

## Proposal {#decision}

**`VerbOperationContext` gains an optional `search` backend, and
`queryGrepVerb` uses it when the host supplies one.** There is one
`grep_search` registration in the process, always the kernel's. A host
that owns a different data plane hands it in instead of registering a
second verb for it.

```
operation(params, ctx) {
  const search = ctx.search ?? (await import('./grep_service.js')).executeGrepSearch
  ...
}
```

The verb already reads its data plane off the context: `ctx.storage` is
what `executeGrepSearch` searches, alongside `ctx.refresh` and
`ctx.callerCwd`. This adds one more field of the same kind, optional, so
every existing host is unaffected and no plugin has to change.

The server then supplies the backend in the operation context it already
builds per org (`buildMcpAssembly`), beside the `org` and `admin` fields it
already passes there for this very verb, and stops registering a verb of
its own.

**What this does not touch.** LLP 0264's decision is that the client
implements the same two-tier mechanism over its own tiers, with one shared
column allowlist and one hit shape. All of that stands. `hyp query grep`
on a laptop is unchanged. `--remote` is unchanged, because it never enters
the local verb registry at all. What changes is only how a process holding
both a kernel and a daemon decides which data plane answers, and the
answer becomes "the host says" instead of "whoever wins the name".

## What the backend must carry {#backend}

- **Shape.** It takes the parameters `executeGrepSearch` takes minus the
  local-only ones, and returns the same `GrepSearchResult` hit shape. That
  shape is already shared by LLP 0264#shared, so the render path needs no
  change: a server result carries no `localOnly`, `freshnessMessages` or
  `limitCeilingReached`, and the renderer already falls back for those.
- **Its own refusals.** A serving host restricts regex mode to the
  operator (hypaware-server LLP 0127#regex-gate); a local one does not
  (LLP 0303#regex-reachability). That gate belongs inside the backend, not
  in the verb, so the verb never learns which host it is running on.
- **`include-local-only`.** Today the server rejects this parameter because
  its schema does not know the name. With one declaration the schema is
  shared, so the backend must refuse it explicitly instead of inheriting a
  refusal from schema validation. Naming it here because it is the one
  parameter that silently changes meaning under this proposal.

**Rejected: swapping `ctx.storage` instead.** The obvious cheaper shape is
the one `query_sql` already uses, where the host swaps a *data* handle and
one execution serves both sides. It does not reach here. `executeGrepSearch`
reads `storage.cacheRoot`, `storage.discoverCachePartitions()` and
`discoverSpoolTables()`, an interface shaped around a local cache
directory, while a server's plane is org-sliced archive blob stores plus an
export ledger and fan-out. Presenting that through
`ExtendedQueryStorageService` would push an archive through a local-cache
abstraction, and it would put this client's mutable-versus-immutable tier
rule in charge of a layout it does not describe. The seam is a service
because the two implementations share a mechanism (LLP 0264) but not a
physical layout.

## Sequencing {#sequencing}

This ships first and alone. The server cannot consume the seam until its
`hypaware` floor rises, so until then the LLP 0264#verb displacement rule
stays in force and `unregister` keeps its caller. Only after the floor
rises does the server drop its registration and retire its guard module.

Retiring `unregister` itself is **out of scope**: it is a published
registry method, it is idempotent and harmless, and nothing here requires
its removal.

## Consequences {#consequences}

- The server retires `src/search/verb-slot.js`, hypaware-server LLP 0178
  and LLP 0184, and the boot-failure mode they guard.
- A plugin registering `grep_search` collides with the kernel's own verb at
  kernel boot, the ordinary way every other tool name already collides, and
  fails loudly at its own registration instead of silently losing a slot
  during someone else's wiring.
- `unregister` keeps no caller in this pair. It stays.

## Open questions {#open}

- **Summary drift.** The coverage clause is built from the client's
  `SEARCHABLE_COLUMNS`. If the server's allowlist (hypaware-server LLP
  0157) ever diverges, one declaration would state the wrong coverage to a
  remote agent, and that clause is load-bearing: it is what stops zero hits
  reading as "not stored". Either the two allowlists are asserted equal at
  wiring time, or the backend may override the summary. Deciding this is
  the first task of the implementation.
