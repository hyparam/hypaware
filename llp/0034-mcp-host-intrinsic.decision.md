# LLP 0034: MCP hosting is intrinsic — any host exposes its plugins' tools

**Type:** Decision
**Status:** Active
**Systems:** Core, Plugins, Query, MCP
**Author:** Phil / Claude
**Date:** 2026-06-23
**Related:** LLP 0003, LLP 0015, LLP 0016, LLP 0024, LLP 0026, LLP 0033; hypaware-server LLP 0006, LLP 0010 (out of tree)

> A HypAware **host** — a local gateway *or* the fleet server — can expose an
> authenticated **MCP server** whose tools are assembled **dynamically from the
> plugins active on that host**. The kernel owns MCP hosting; core and plugins
> contribute tools. This supersedes the bespoke per-capability REST transport
> sketched in the first draft of [LLP 0033](./0033-remote-query-attach.spec.md):
> a new server/plugin capability becomes a new MCP tool, discoverable via
> `tools/list`, with **zero client change** — the requirement that motivated the
> rethink.

> **Status note:** design settled (this document is the record, following the
> [LLP 0031](./0031-layered-config.decision.md) "settled before code" pattern).
> The **kernel + client half is implemented**: the verb surface (`ctx.verbs`,
> the argv↔schema codec, verb→command/tool projection), the intrinsic
> `query_sql` verb + `graph_neighbors` (read-class), the `hyp mcp` stdio host
> (hand-rolled JSON-RPC — see the dependency note below), dataset schemas as
> MCP resources, the `--remote` MCP client + stdio proxy, `query.remotes`
> targets, and the `0600` credential store + `hyp remote` commands. The
> **server-side half** (scoped credential + MCP route) remains pending and the
> remote path is E2E-blocked on it — see [Server coordination](#server-coordination)
> and [Implementation sequencing](#implementation-sequencing--follow-ups).

## Why MCP, not a homegrown transport

The original plan was an authed HTTP pipe (`@hypaware/remote`) with a `--remote`
branch on each owning command. It solved *transport* but not *discovery*: the
client still had to know each endpoint, so every new server capability touched
client code. MCP's `tools/list` makes the host **self-describing** — the standard
already solves the discovery problem a homegrown `/v1/capabilities` would
reinvent. And it lands the mission directly: [LLP 0000](./0000-hypaware.explainer.md)
is *"surfaces it for efficient LLM-native querying"* — an MCP over the data is
exactly that, consumable by Claude/Codex without bespoke wiring.

## Kernel-wide, not server-only

MCP hosting is a **kernel capability available to any host**, gated on
deployment, not baked into the server:

- **Local MCP** — a gateway exposes its own active plugins' tools to a local AI
  client (query my own cache/graph from Claude). Opt-in.
- **Remote/fleet MCP** — the server ([kernel-reuse, server LLP 0002](../../hypaware-server/llp/0002-kernel-reuse.decision.md))
  exposes the converged fleet graph + logs, authenticated.

Same assembly mechanism; the tool list differs only by which plugins the host
runs. This generalizes the `attach` model ([LLP 0016](./0016-ai-gateway.decision.md))
from "wire an AI client to the local gateway" to "wire an AI client to any
HypAware host's MCP."

## Maps onto the intrinsic/plugin boundary (LLP 0003)

The split that already governs query governs tools:

- **SQL/dataset surface is intrinsic** → core contributes a `query_sql` tool (and
  dataset schemas as MCP resources) **for free, on every host** with a registered
  dataset. No plugin work.
- **Other modalities are plugin capabilities** → graph traversal
  ([LLP 0026](./0026-context-graph-query.decision.md)), vector search
  ([LLP 0024](./0024-vector-search-plugin.decision.md)) contribute their own typed
  tools, present only where those plugins are active.

So a bare host offers `query_sql`; add `@hypaware/context-graph` and
`graph_neighbors` appears; add vector search and `vector_search` appears — exactly
the dynamic, plugin-driven surface the rethink asked for.

## Verbs: one declaration, two surfaces

<a id="verbs"></a>"Built dynamically by the plugins present" is realized by a new
**verb** contribution surface. A query-shaped operation — *typed params in,
structured result out* — is declared **once**, and the kernel **projects both a
CLI command and an MCP tool** from it:

```js
ctx.verbs.register({
  name: 'graph neighbors',          // CLI:  hyp graph neighbors <node> --depth 2
  tool: 'graph_neighbors',          // MCP:  graph_neighbors({ node, depth })
  inputSchema: { /* JSON Schema: node, depth, direction, edge_type, limit */ },
  operation: (params, ctx) => queryNeighbors(params),   // the shared core
  render: (result) => formatNeighbors(result),          // CLI-only: stdout text
})
```

The reusable thing is the **operation**, not the surface glue. A command and a
tool share the middle and differ at the edges:

| Layer | CLI command | MCP tool |
|---|---|---|
| Parse | argv → params (kernel, via `inputSchema`) | MCP delivers typed params |
| **Operation** | **`operation(params)` — identical** | **`operation(params)` — identical** |
| Render | `render` → stdout + exit code | return structured result |

This is the split [LLP 0026](./0026-context-graph-query.decision.md#thin-in-memory-traversal)
already mandates ("the traversal core is a **pure function**… the IO wrapper is
thin glue"), generalized: the kernel owns both adapters, so the CLI flag set and
the MCP JSON Schema can never drift — they are the same `inputSchema`. The
intrinsic `query_sql` verb is core's own registration; dataset schemas surface as
MCP **resources**.

**Scope and boundaries:**

- **Verbs are for query-shaped operations only** (typed params → structured
  result). Imperative/interactive commands — `plugin install` (TTY confirm),
  `init` (walkthrough), `daemon install` — do **not** reduce to a flat typed
  input and stay ordinary `ctx.commands.register` commands
  ([LLP 0009](./0009-cli-registry.spec.md)). `verbs` is a typed superset for the
  query family, not a retrofit of every command.
- **Existing query-shaped commands migrate onto verbs** — `graph neighbors`,
  `graph project`, `query sql` are refactored to `ctx.verbs.register` so they
  yield their MCP tools for free; their pure-operation cores already exist.
- **New machinery: a kernel argv↔schema codec** (map flags/positionals to schema
  properties, coerce types) — bounded, and the single place CLI parsing for the
  query family lives.

<a id="tool-exposure-emergent"></a>**The tool list is emergent, not a central
scope.** A host's MCP tools are exactly the verbs its **active plugins** register
— add `@hypaware/vector-search` and `vector_search` appears with **zero core
change** (the dynamic, plugin-driven surface the rethink demanded). There is no
gate-list the kernel consults. Two per-verb controls, owned by the registering
plugin:

- **Exposure** — default is *CLI command + MCP tool*; a verb may be marked
  **CLI-only** (no tool) or **local-only** (tool on the local host, never the
  remote/HTTP transport) for operations that shouldn't be remotely invokable.
- **Auth class** — see [Tool auth class](#tool-auth-class).

> *Which existing first-party commands get migrated to verbs first is an
> implementation-sequencing detail, not an architecture cap — any command (or
> third-party plugin) self-migrates later with no core change.*

## Reframes the server's bespoke endpoints

Server LLP 0006 (`/v1/query`) and LLP 0010 (`/v1/admin/graph/*`) are bespoke REST
per capability — the churn this avoids. Under this decision they become **MCP tool
handlers over the same kernel functions** (`executeQuerySql`, `queryNeighbors`,
`projectGraph`), so MCP **subsumes** them rather than sitting beside them. Server
coordination (a server LLP) is required; the operator-only admin REST (token
minting, config authoring) can stay on `hypaware-server-admin` and out of the
queryable tool surface.

## Transport, deployment, and auth

<a id="pluggable-transport"></a>There is **one server assembly** (verbs → tools);
the transport is a **thin, pluggable adapter** over it (the MCP SDK ships
`Stdio`/`StreamableHTTP` server transports). The HTTP adapter is needed for the
fleet server regardless, so stdio is a near-free *second* adapter over the
identical server — not a parallel implementation.

| Mode | How | Auth |
|---|---|---|
| **Local (default)** | `hyp mcp` over **stdio**; AI client spawns it (`command: "hyp", args: ["mcp"]`) | **none** — local-user trust, same as running `hyp query` at the terminal |
| **Local (optional)** | `hyp mcp --http --port N` — *reuses the server's HTTP adapter* for a warm, multi-client, or LAN endpoint | local token (a loopback port is reachable by any local process) |
| **Remote / fleet** | authed **Streamable HTTP** as a new route on the server's HTTP plane (server kernel, server LLP 0002) | **query-scoped token** (safe to hold in a client config — see below) |

<a id="scoped-credential"></a>**Direct install is the primary remote-attach path,
enabled by a query-scoped credential.** An AI client adds the server's MCP
endpoint the standard way (`claude mcp add --transport http <url>`, a Desktop
remote connector, …) — the endpoint is self-describing, so this needs no `hyp`
in the data path. What makes direct install *safe* is **server-side token
scoping**: the server mints a **query-scoped credential** that can call the
read/compute tools (`query_sql`/`graph_*`/`vector_*`) but **cannot author configs
or mint tokens**, so the credential that lands in a client config is low-stakes.
The all-powerful operator token (config authoring = fleet code execution, server
LLP 0006 §admin-token-stakes) **stays server-side only** (`hypaware-server-admin`)
and is never installed in a client.

This is the [multi-admin identity work server LLP 0006 explicitly deferred](../../hypaware-server/llp/0006-admin-query-attach.decision.md#admin-token)
("the auth check is isolated so replacing the token scheme doesn't touch the
query path"), pulled forward as a **scope claim / second token type** — smaller
than full OAuth (OAuth 2.1, which the MCP auth spec supports, is the fuller
later option for browser-based short-lived sessions).

<a id="proxy-fallback"></a>**The stdio proxy + `hyp mcp attach` survive only as
optional convenience / fallback**, not the primary path:

- `hyp mcp attach --remote <target> --client claude` is **sugar** that writes the
  client's MCP entry for the user (like `hyp join` is sugar for MDM) — optional.
- `hyp mcp --remote <target>` (stdio proxy injecting a `0600`-stored credential)
  is the **fallback** for clients without remote-MCP support, or environments
  still issuing only the unscoped token.

<a id="tool-auth-class"></a>**Tool auth class.** One MCP endpoint now carries
operations the server today splits across `/v1/query` (read) and `/v1/admin/*`
(operator). That read/operator boundary moves **onto the tools**: each verb
declares an auth class, and the credential scope gates it.

- **Read/compute tools** — `query_sql`, `graph_neighbors`, `vector_search` —
  reachable by the **query-scoped** credential ([§scoped-credential](#scoped-credential)).
- **Operator/mutating tools** — `graph_project`, `github_backfill` — require the
  **operator** token, never the query-scoped one.

So a verb being a tool does **not** mean a query-scoped client can call it:
`graph_project` (a fleet re-projection) stays operator-gated by token scope, not
by whether it was migrated to a verb. The V1 *capability set* a query-scoped MCP
client sees is decided by per-tool auth class, not by the migration order above.

<a id="stdio-stdout-discipline"></a>**stdio constraint:** stdout is the JSON-RPC
channel — `hyp mcp` must route *all* logs and human text to stderr/file; a stray
write corrupts the stream. (`@ref` when the code lands.)

**Dependency note (implementation, not architecture):** kernel-intrinsic MCP
makes the MCP SDK a **kernel dependency, bundled** per
[LLP 0008](./0008-plugin-runtime-dependencies.decision.md) (kernel never
`npm install`s). The alternative — hand-rolling minimal MCP (JSON-RPC 2.0 +
`initialize`/`tools/list`/`tools/call`/`resources/*`) to avoid the dep — was an
implementation call. **Resolved: hand-rolled**, in keeping with the kernel's
no-new-heavy-deps house style; the surface MCP needs is small and the
transport is a thin line-delimited-JSON adapter (`src/core/mcp/{jsonrpc,server,stdio}.js`).

## Consumer side

`hyp` is also an MCP **client**, so the LLP 0033 `--remote` flag **survives,
re-pointed**: `hyp <verb> --remote <target>` runs the verb's `operation` against
the remote MCP *tool* (same `inputSchema`) instead of locally, then renders with
the **same `render`**. One verb declaration thus powers four surfaces — local
CLI, local MCP tool, remote CLI (MCP client), and the optional stdio proxy — from
`operation` + `inputSchema` + `render`. The human-CLI remote path needs `hyp`'s
target registry + query-scoped credential store ([LLP 0033](./0033-remote-query-attach.spec.md));
AI clients that install the endpoint directly do not.

## Server coordination

The server is the design authority for the server-side half:

- **Query-scoped credential** (this decision §scoped-credential) — server LLP
  0006's deferred multi-admin identity, pulled forward; the server mints a
  read/compute token distinct from the operator token. A server LLP records it.
- **MCP route on the server HTTP plane** — verb→tool assembly running in the
  server kernel (server LLP 0002), subsuming the bespoke `/v1/query` (LLP 0006)
  and `/v1/admin/graph/*` (LLP 0010) endpoints.

## Implementation sequencing & follow-ups

- **First migration pass (read-class):** `query_sql` (core) and `graph_neighbors`
  (`@hypaware/context-graph`) onto the verb surface, so a query-scoped MCP client
  is useful day one. `graph_project` / `github_backfill` follow as operator-class
  tools ([§tool-auth-class](#tool-auth-class)); `vector_search` lights up when
  `@hypaware/vector-search` registers a verb. `graph compact` stays an imperative
  command.
- **MCP SDK vs hand-rolled JSON-RPC** — resolved **hand-rolled** (see dependency note). ✅
- **`graph_project` / `github_backfill` as operator-class verbs** — not yet
  migrated; `query_sql` + `graph_neighbors` (read-class) landed first. The
  operator auth-class machinery + gating is in place and tested, so this is a
  per-verb migration with no core change.
- **OS keychain** for the human-CLI credential store — follow-up
  ([LLP 0033](./0033-remote-query-attach.spec.md)).
- **Local HTTP MCP** (`hyp mcp --http`) and **LAN-shared** local endpoints —
  ship after stdio (the command rejects `--http` today with a follow-up note).
- **`@ref`s added when the code landed:** verb registry + argv↔schema codec →
  `#verbs`; per-verb exposure/auth-class → `#tool-exposure-emergent` /
  `#tool-auth-class`; stdio transport → `#stdio-stdout-discipline`; HTTP/proxy
  transports → `#pluggable-transport` / `#proxy-fallback`. ✅
