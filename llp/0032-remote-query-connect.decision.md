# LLP 0032: Remote query — `hyp query connect` to an admin server

**Type:** Decision
**Status:** Draft
**Systems:** Query
**Author:** Phil / Claude
**Date:** 2026-06-18
**Related:** LLP 0009, LLP 0010, LLP 0013, LLP 0015, LLP 0017, LLP 0025, LLP 0031; hypaware-server LLP 0006 (out of tree, design authority — "Admin Query Attach Is a Remote SQL Endpoint")

> The admin's **local** `hyp` gains a `--server` selector on **`hyp query sql`
> only**: `hyp query sql "…" --server <url>` runs **on the server** (spanning its
> cache tier + Iceberg archive) instead of over local recordings. A bare
> `hyp query sql` is **always local** — `--server` is the sole, explicit opt-in.
> `hyp query connect <url>` just **saves a URL** so a bare `--server` can omit it;
> `disconnect` forgets it. `schema`/`status`/`refresh` stay local. The admin
> bearer token is resolved from the environment
> (`HYP_ADMIN_TOKEN`), never persisted. `hyp query disconnect` returns to local.
> This is the client half of hypaware-server LLP 0006 — the server endpoint
> (`POST /v1/query`) already exists; this doc specifies the client surface.

> **Status note:** **not yet implemented.** This is the design of record for the
> client-repo work. Until it lands, the only ways to query the server are the
> server-local `hypaware-server-admin query` CLI (docker-exec / SSH) or raw
> `curl` against `POST /v1/query`. See [Annotations](#annotations-to-add-when-code-lands)
> for the `@ref`s the code will carry.

## Problem

`hyp query sql` reads **local recordings + the local query cache only** — it
"does not query the central server" (the `hypaware-query` skill says so
outright). The only path to the pooled, org-wide data on the central server is
hypaware-server's `POST /v1/query`, reachable today through:

- `hypaware-server-admin query "…"` — a **server-local** wrapper "for
  docker-exec workflows" (its own header comment), assuming the admin is *on
  the box* (or SSHs / `docker exec`s in), or
- hand-rolled `curl` with the admin bearer token.

Neither is an admin-from-their-own-laptop experience. hypaware-server LLP 0006
already calls for one — *"the admin's local `hyp` gains a remote-attach mode …
that points at the server URL, sends SQL, and renders results with the kernel's
standard formatters"* — but defers the client work to this repo. This doc is
that work.

## Remote query is not `hyp join`, and not `hyp attach` {#not-join}

Two existing verbs are deliberately **not** reused:

- **`hyp join <url>`** ([LLP 0025](./0025-remote-config-join-flow.spec.md),
  [LLP 0031](./0031-layered-config.decision.md)) enrolls a **gateway** to
  *ingest* — it writes central config, installs the daemon, and exchanges a
  bootstrap token for a **gateway JWT** that grants `POST /v1/ingest/{signal}`
  rights and nothing else. An admin's machine is usually **not** a joined
  gateway: it pushes no logs, runs no daemon, and holds a **different
  credential** (the operator admin token, which the gateway JWT is explicitly
  not — hypaware-server LLP 0006 §admin-token). So remote query cannot
  piggyback on join's stored URL; an admin may have no central config at all.

- **`hyp attach [claude|codex]`** / **`hyp detach`** already mean "attach an AI
  client to the local gateway" (`src/core/cli/core_commands.js` command
  registry). Overloading `attach` for remote query would collide with a
  user-facing verb. hypaware-server LLP 0006 uses "attach" only as a *concept
  label*, never a prescribed command name, so the client is free to choose a
  clearer verb.

#### The verb: `connect` / `disconnect` {#connect-verb}

**Decision: the verb is `connect` / `disconnect`, namespaced under `query`.**
`hyp query connect <url>` / `hyp query disconnect`. `connect`/`disconnect` is
the universal database-client idiom (psql, mysql), unmistakably "point at a
server," and has zero overlap with the AI-client `attach`. Namespacing under
`query` keeps it adjacent to the surface it modifies and away from top-level
`attach`.

## Decision

### Command surface {#command-surface}

```
hyp query connect <url> [--token-file <path>] [--no-verify]   # save the server URL
hyp query disconnect                                          # forget it
hyp query sql "<sql>"                # always LOCAL
hyp query sql "<sql>" --server <url> # this server, one-off
hyp query sql "<sql>" --server       # the saved server (from connect)
```

- **`--server` is the selector; absence is always local.** A bare
  `hyp query sql` reads local recordings — *always*, with no hidden state that
  could silently reroute it. The server is only ever reached when `--server` is
  present.
- **`--server <url>`** runs that one query on the named server. No prior
  `connect` needed; persists nothing.
- **`--server`** (bare, no URL) resolves the URL saved by `connect`. No saved
  target → a clear error ("pass a URL or run `hyp query connect`").
- **`connect <url>`** persists **only the URL** (not a secret), mode `0600`,
  alongside the machine-local query state ([Where the target lives](#target-storage)),
  so you can type a bare `--server` instead of repeating it. By default it runs a
  **verification ping** ([The ping asserts reachability + auth](#ping-asserts-auth))
  so it fails fast rather than deferring discovery to the first query.
- **`disconnect`** forgets the saved URL.

#### `connect` saves a URL; it is not a mode {#target-not-mode}

**`connect` stores a default for `--server` — it does not change what a bare
`hyp query sql` does.** This is the deliberate correction of an earlier
"connected = bare queries go remote" sketch: a stateful mode makes a bare query
ambiguous (am I reading local recordings or org-wide server data?) and offered no
`--local` escape. Making **`--server` the sole, explicit selector** removes the
footgun entirely — local is the unmistakable default, the server is always
opt-in, and `connect` is pure convenience (a saved URL), not a hidden routing
switch.

Only `sql` is remote-capable. `schema`, `status`, and `refresh` are **always
local** by design — local-registry / local-cache inspectors, not
"deferred pending server work" ([Why schema/status stay local](#schema-status-local)).
This bounds the contradiction with
[LLP 0015](./0015-query-and-datasets.spec.md#query-is-intrinsic) to a single
scoped clause rather than overturning the spec. `--refresh` is a **no-op
remotely** (the server already spans cache + archive) and warns if passed.

### Credential resolution — env only, never persisted {#credential}

The admin bearer token is resolved from **`HYP_ADMIN_TOKEN`** in the
environment (mirroring the server's `HYPSERVER_ADMIN_TOKEN`), or, for the
`connect` verification ping only, from `--token-file <path>` / stdin. It is
**never** taken as a positional argument and **never written to disk** by
`hyp`.

This is forced, not stylistic:

- **Secrets-never-in-config** ([LLP 0010](./0010-config-model.spec.md),
  hypaware-server LLP 0006 §admin-token: the admin token is "resolved from the
  environment"). `connect` writes a config file (the target URL); the token
  must not live in it.
- **The token is operator-grade.** Per hypaware-server LLP 0006
  §admin-token-stakes it gates *fleet code execution* (config authoring
  distributes hash-pinned plugin artifacts), not just reads — the highest-value
  thing to keep off disk.
- **Positional secrets leak** into shell history and `ps`. `hyp join` already
  refuses argv for its token (prefers `--token-file`/stdin); remote query holds
  the line.

Operators export `HYP_ADMIN_TOKEN` from `~/.zshrc` (or a sourced `chmod 600`
secrets file, or a keychain line). Every `hyp query sql` re-reads it; a shell
without it set fails the query with the same "not set" error.

#### Plain `http://` is warned, not blocked {#scheme-warning}

**Plain `http://` is allowed but warned, not blocked.** The primary deployment is
`http://<host>:8740` reached over Tailscale (the server speaks plain HTTP behind
a TLS proxy / on a network-encrypted overlay), so hard-requiring `https://` would
break it. But the token is fleet-grade, so an unencrypted send to a *public* host
must be a visible choice. `connect`/query accept `http`|`https` (as `hyp join`
does) and emit, when the scheme is `http://` **and** the host is not loopback:

> `warning: sending the admin token over plain HTTP to <host>. Ensure the network is trusted (Tailscale/VPN/loopback) or use https://.`

Loopback and `https://` warn nothing. We deliberately do **not** special-case
Tailscale CGNAT ranges to suppress the warning — a harmless warning beats a wrong
guess.

### Fail-fast, distinct errors {#failure-modes}

`connect` (and each remote `sql`) distinguishes the real failure modes instead
of one vague error. Messages map to the server's actual responses:

| Situation | Detection | Behavior |
| --- | --- | --- |
| `HYP_ADMIN_TOKEN` unset/empty (and no `--token-file`) | before any network call | abort, exit 2: `HYP_ADMIN_TOKEN is not set — export it (e.g. in ~/.zshrc) or pass --token-file` |
| Token present but wrong | ping → `401 {"error":"unauthorized"}` | `connect failed: server rejected the admin token (401). Check HYP_ADMIN_TOKEN.` |
| URL unreachable / wrong port / no TLS proxy | fetch throws (ECONNREFUSED / timeout) | `connect failed: could not reach <url> (connection refused).` |
| Bad SQL at query time | `400 {"error":"query_failed","detail":…}` | surface `detail` verbatim |
| Success | ping passes auth (see below) | store URL, print `connected to <url> ✓` |

`--no-verify` skips the ping (offline/scripted setup): stores the URL without a
network call, so a missing token is *not* an error until the first query.

#### The ping asserts reachability + auth {#ping-asserts-auth}

**The ping asserts reachability + auth, not query validity.** The server checks
`isAdmin()` *before* executing SQL (`routes-admin.js`: `401` is returned ahead of
any query run), so a `400 {"error":"query_failed"}` is itself **proof the token
was accepted**. `connect` therefore classifies the ping by what it proves, not by
whether the query ran:

| Ping outcome | Verdict |
| --- | --- |
| connection error / timeout | **unreachable** |
| `401 unauthorized` | **bad token** |
| anything else — `200` **or** `400 query_failed` | **connected ✓** |

The payload is `SELECT 1` (cheap, obvious intent), but its *success is irrelevant*
— this keeps `connect` robust to the kernel's SQL dialect and to the exact result
shape; it only ever depends on getting *past auth*. **Future (hypaware-server):**
a dedicated `whoami`/ping endpoint would let `connect` assert auth without sending
dummy SQL and return a clearer message — a server follow-up, not required here.

### Wire contract (`POST /v1/query`) {#wire-contract}

Confirmed against hypaware-server `src/http/routes-admin.js`. This is the
client-side contract hypaware-server LLP 0006 defers here.

**Request** — `POST /v1/query`, `Authorization: Bearer <admin-token>`,
`Content-Type: application/json`:

```json
{ "query": "SELECT ..." }
```

The body key is **`query`** (not `sql`); extra fields are ignored. No
`limit`/`format`/`params` in V1.

**Success `200`:**

```json
{ "columns": ["…"], "rows": [{ "…": "…" }], "datasets": ["…"], "truncated": false }
```

When capped, adds `"truncated": true` and `"limit": "rows:10000"` (or
`"bytes:33554432"`). Caps are **server-side** and operator-configurable
(`HYPSERVER_QUERY_MAX_ROWS` default 10k, `HYPSERVER_QUERY_MAX_BYTES` default
32 MB). Read-only is enforced by the server's kernel parser (SELECT-only);
violations return `query_failed`.

**Errors:** `401 {"error":"unauthorized"}` · `400 {"error":"query_required"}` ·
`400 {"error":"query_failed","detail":"<engine msg>"}`.

### Result mapping reuses the local formatters {#result-mapping}

The response maps near-1:1 onto the kernel's `ExecuteSqlResult`
(`src/core/query/types.d.ts`: `{ columns, rows, datasets, freshnessMessages }`)
— the server already returns `columns`, `rows`, `datasets`. The client
synthesizes `freshnessMessages` from truncation:
`truncated → ["showing first N rows — narrow your query"]`. Everything
downstream is unchanged and source-agnostic: `buildQuerySqlOutput`,
`renderResult`, `applyContextControls`, and the `--format` / `--output` /
`--max-cell` / `--max-bytes` flags all operate on the result shape, not the
execution path. Two truncation layers stay distinct: **server caps**
(authoritative, surfaced as a freshness notice) and **client `--max-*`**
(terminal-rendering budget).

### A small standalone client, not the central plugin's {#http-client}

The remote-query call is a ~40-line standalone `fetch` in the CLI, not a reuse
of the `@hypaware/central` plugin client. The plugin's `IdentityClient` is
hard-wired to the gateway-JWT flow (wrong credential) and its ingest path
honors `Retry-After` with a multi-minute backoff ceiling (wrong behavior for an
interactive query — remote query **fails fast**, no retry on 429/503). Worth
lifting from the plugin: `joinUrl` and `readErrorDetail`
(`hypaware-core/plugins-workspace/central/src/sink.js`).

### Remote `sql` boots an empty local runtime; the daemon is irrelevant {#empty-runtime-boot}

HypAware is assumed installed (the admin uses the same `hyp`), but remote query
needs **none** of the local install's moving parts:

- **The daemon need not be running.** `hyp query` is a one-shot, self-booting
  CLI command — it builds its own kernel in `dispatch` and never does IPC to the
  daemon ([LLP 0017](./0017-daemon-runtime.decision.md)). The daemon's job is
  background recording/export; remote `sql` runs entirely on the server, so the
  daemon (and the local cache) play no part.
- **No plugins activate.** A remote-targeted `query sql` boots with the
  `{ activate: [] }` profile (`decideBootProfile`, `src/core/cli/dispatch.js`;
  the boot-profile contract is [LLP 0009](./0009-cli-registry.spec.md)) — the
  same empty-runtime profile `status`/`daemon` use — and **skips
  `materializeSinks`**. The intrinsic query kernel still boots
  (`kernel.query`/`kernel.storage` are core, not plugins —
  [LLP 0015](./0015-query-and-datasets.spec.md#query-is-intrinsic)), so result
  formatting works; it just carries an empty dataset registry, which is correct
  because remote `sql` ignores local datasets.

This is deliberate, not incidental. Booting the default `'config'` profile would
**activate the admin's own AI-gateway source** (which starts a listener on
activation — the reason `stopBootStartedSources` exists in `dispatch.js`; a port
conflict if the daemon already holds it) and **materialize the central sink**
(firing identity bootstrap/refresh network calls and scheduling exports). A
server-side *read* must not drag the admin's *ingest* stack into motion, nor fail
because a local plugin config is half-applied. The empty profile decouples remote
query from local install + daemon health.

**Detection is purely the `--server` flag.** A `query sql` invocation is remote
iff it carries `--server` (with or without a URL — bare resolves the saved
target). A saved target *alone* does not make a bare query remote (a bare query
is always local), so detection needs no file read: `argv` carries the whole
signal, read at `decideBootProfile` / dispatch to select `{ activate: [] }`
*before* boot.

### Where the target lives {#target-storage}

The remote target is **machine-local query state**, not fleet config. Per
[LLP 0031](./0031-layered-config.decision.md), `query{}` is structurally
local-only and central `query` blocks are ignored — so the target must **not**
go through the central/local config merge. Store it beside the local query
state (a small `query-remote.json`, mode `0600`, holding `{ "version": 1,
"server_url": "…" }`). It never enters the effective config the daemon boots.

### Why `schema`/`status`/`refresh` stay local — permanently {#schema-status-local}

This is **not** a server-capability gap waiting to be filled; it follows from
[target-not-mode](#target-not-mode):

- **`status`** reports *local cache freshness and partition state*. The concept
  has **no remote meaning** — the server transparently spans cache + archive
  (hypaware-server LLP 0006), so "is my cache stale?" is not a question to ask
  it. A "remote status" would be a *different* server-health concept, not a port
  of this one.
- **`schema`** surfaces the rich **local dataset-registry** metadata — column
  types, `primaryTimestampColumn`, partition discovery — which lives in the
  plugin's dataset *registration* ([LLP 0015](./0015-query-and-datasets.spec.md#query-is-intrinsic)),
  not on the wire. A degraded column-name list *is* reachable today via
  `SELECT … LIMIT 0` over `/v1/query` (no server change), but it is not the same
  artifact; conflating them would lie about fidelity. So `schema` stays the
  honest local inspector.
- **`refresh`** drives the *local* cache; the server owns its own.

The only read surface the server exposes is `POST /v1/query` (hypaware-server
`routes-admin.js`); there is deliberately no client dependency on more.

### V1 scope {#v1-scope}

- **In:** `hyp query connect` / `disconnect`, `hyp query sql --server`, env-token
  resolution, verification ping, the failure messages above, result mapping
  through the existing formatters. `sql` is the **only** remote-capable verb.
- **Out (follow-ups):** per-user / row-scoped query (needs the deferred
  multi-admin identity work named in hypaware-server LLP 0006); cursor
  pagination / streaming NDJSON for full result sets (bulk consumers read the
  Iceberg archive directly). Remote `schema`/`status` are **not** roadmap items
  — see [above](#schema-status-local).

## Annotations to add when code lands

- `// @ref LLP 0032#connect-verb [implements]` — `query connect`/`disconnect`
  registration in `src/core/cli/core_commands.js` (near the existing `query`
  subcommands).
- `// @ref LLP 0032#credential [constrained-by]` — `HYP_ADMIN_TOKEN` resolution
  + the no-persist rule.
- `// @ref LLP 0032#http-client` and `#wire-contract` — the new
  `src/core/query/sql-remote.js` (`executeQuerySqlRemote`).
- `// @ref LLP 0032#result-mapping` — the `truncated → freshnessMessages`
  synthesis and the remote/local branch in `runQuerySql`.
- `// @ref LLP 0032#target-storage` — the `query-remote.json` read/write helper.
- `// @ref LLP 0032#empty-runtime-boot [constrained-by]` — the remote-detection
  + `{ activate: [] }` branch in `decideBootProfile` / the `materializeSinks`
  skip in `src/core/cli/dispatch.js`.
