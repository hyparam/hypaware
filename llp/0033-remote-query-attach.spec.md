# LLP 0033: Remote Attach (client consumer half)

**Type:** Spec
**Status:** Active
**Systems:** Query, CLI, MCP
**Author:** Phil / Claude
**Date:** 2026-06-23
**Related:** LLP 0003, LLP 0009, LLP 0015, LLP 0025, LLP 0031, LLP 0034; hypaware-server LLP 0006, LLP 0010 (out of tree, design authority)

> The **client consumer half** of remote attach: how a local `hyp` (and the AI
> clients on a developer's machine) reach a HypAware server's data. The
> *producer* half — a host exposing an MCP server assembled from its plugins'
> verbs — is [LLP 0034](./0034-mcp-host-intrinsic.decision.md); this document
> owns the consumer side. Sibling to [LLP 0025](./0025-remote-config-join-flow.spec.md)
> (the client half of remote *config*). The server (LLP 0006/0010) is the
> design authority for the server's MCP surface and the scoped credential.

> **History.** This doc began as a bespoke-REST design (`POST /v1/query`, an
> `@hypaware/remote` HTTP-pipe plugin, a `--remote` flag over HTTP). The rethink
> recorded in [LLP 0034](./0034-mcp-host-intrinsic.decision.md) replaced the
> transport with MCP and dissolved the plugin (its transport rationale evaporated
> once MCP hosting + client became kernel-intrinsic). The surviving decisions —
> named targets, the `0600` credential store + `hyp remote login`,
> secrets-never-in-config, explicit truncation, `--remote`/`--refresh` flag
> compat — are carried here, reframed onto MCP and **core** (not a plugin).

> **Status note:** the **consumer half is implemented in core** — `--remote` on
> every verb (routing to the MCP client), `query.remotes` targets + validation,
> the `0600` credential store with env→file resolution, `hyp remote
> add/login/list/remove`, and the two-line truncation surfacing + the
> `--remote`/`--refresh` hard error. The remote path is **E2E-blocked** on the
> server's MCP route + scoped credential (out of tree); the client code is
> written against the wire contract and unit-tested via an injectable `fetch`.

## Summary

There are **two ways** to consume a remote host's data, and `hyp` is **core** on
both (no `@hypaware/remote` plugin):

1. **AI clients install the server's MCP directly** — `claude mcp add
   --transport http <url>`, a Desktop connector, etc. — authenticated by a
   **query-scoped** credential ([LLP 0034 §scoped-credential](./0034-mcp-host-intrinsic.decision.md#scoped-credential)).
   `hyp` is **not in the data path** for this; the server endpoint is
   self-describing.
2. **A human at the terminal** runs `hyp <verb> --remote <target>` — `hyp` acts as
   an **MCP client**, calls the remote tool, and renders locally. This needs
   `hyp`'s target registry + credential store (below).

`hyp mcp attach` ([LLP 0034 §proxy-fallback](./0034-mcp-host-intrinsic.decision.md#proxy-fallback))
is optional sugar that writes (1)'s client entry for the user; the stdio proxy is
the fallback for clients without remote-MCP support.

## Surface: `--remote` re-pointed at the MCP tool

A verb declares `operation` (local) + `inputSchema` + `render`
([LLP 0034 §verbs](./0034-mcp-host-intrinsic.decision.md#verbs)). The original
draft's `--remote` flag **survives, re-pointed**:

> `hyp graph neighbors <node> --remote prod` runs the verb against the remote
> **`graph_neighbors` MCP tool** (same `inputSchema`) instead of `operation`, then
> renders with the **same `render`**.

One verb declaration thus powers local CLI, local MCP tool, **and** remote CLI —
no separate remote code path or renderer. `--remote` is a **core** flag on a core
verb routing to a core MCP client; it is not a plugin injecting an option (no
conflict with [LLP 0009 §no-cross-plugin-option-injection](./0009-cli-registry.spec.md#no-cross-plugin-option-injection)).
Only read-class tools are reachable with a query-scoped credential
([LLP 0034 §tool-auth-class](./0034-mcp-host-intrinsic.decision.md#tool-auth-class)).

## Targets

<a id="targets"></a>Named targets live in **core config** under the **local-only**
`query{}` block ([LLP 0031 §query-is-local-only](./0031-layered-config.decision.md#query-is-local-only)):

```json
{ "query": { "remotes": { "prod": { "url": "https://hyp.internal/mcp" } },
             "default_remote": "prod" } }
```

This **supersedes** the earlier draft's plugin-config-block home: with the MCP
client now core (LLP 0034), "which server a verb talks to" is a core concern, and
`query.remotes` is the natural seat. Because `query{}` is structurally local-only,
the **central layer can never inject a remote target** ([LLP 0031](./0031-layered-config.decision.md#query-is-local-only)) —
a free invariant. The URL is non-secret and committable; the token is not config.

## Credentials

<a id="credentials"></a>The query-scoped token is **never in config**
(secrets-never-in-config, server LLP 0000). Resolution for the human-CLI path:

- **Storage:** `<state>/remote-credentials.json`, mode `0600`, atomic tmp+rename, a
  single map `{ "<target>": { "kind": "…", … } }` (kernel-managed state,
  [LLP 0004](./0004-activation-and-paths.spec.md); mirrors `central`'s
  `identity.json` single-file precedent). One `hyp remote login` per server. Each
  record is **discriminated by `kind`** ([LLP 0046 D4](./0046-oidc-login-client.decision.md#d4)):
  a `static` record is the bare `{ token }` of this spec; an `oidc` record carries
  a refresh token plus a cached short-lived access JWT from a browser login. A
  legacy `token`-only record (no `kind`) reads as `static`, so existing files keep
  working without a rewrite.
- **Resolution at query time:** per-target env `HYP_REMOTE_TOKEN_<NAME>`
  (CI/ephemeral) → stored file → error (`no token for '<target>' — run 'hyp
  remote login <target>'`). A *per-target* env var so a stored var can never
  silently authenticate the wrong server. For an `oidc` record the attach path is
  **session-aware** ([LLP 0046 D5](./0046-oidc-login-client.decision.md#d5)): it
  silently refreshes a near-expiry access JWT, and on a live `401`/`403` it
  refreshes once and retries before surfacing; a refresh that fails `invalid_grant`
  surfaces the same re-login guidance, now meaning re-run the browser flow. The
  stdio proxy fallback ([LLP 0034 §proxy-fallback](./0034-mcp-host-intrinsic.decision.md#proxy-fallback))
  shares this session-aware path, resolving a fresh JWT per forwarded message so a
  long-lived proxy does not pin one short-lived access JWT.
- AI clients that install the endpoint directly hold the token in **their own** MCP
  config — `hyp`'s store is only for the human-CLI client path.

<a id="credential-stakes"></a>**Stakes — much reduced by scoping.** The credential
`hyp` stores is the **query-scoped** token ([LLP 0034 §scoped-credential](./0034-mcp-host-intrinsic.decision.md#scoped-credential)):
read/compute tools only, **cannot author configs or mint tokens**. So unlike the
original design's single fleet-code-exec admin token, what lands in `hyp`'s `0600`
store (or an AI client's config) is low-stakes. The all-powerful operator token
stays server-side (`hypaware-server-admin`) and is never installed client-side.
**OS keychain** for the store is a named follow-up.

## Commands

<a id="commands"></a>Core `remote` commands manage targets + credentials (verbs/
MCP are kernel-intrinsic, so these are core, not plugin):

| Command | Effect | Writes |
|---|---|---|
| `hyp remote add <name> <url>` | register a target (creates/augments local config) | `query.remotes.<name>` |
| `hyp remote login <name>` | store the query-scoped token (`--token-file`/stdin/prompt) | `remote-credentials.json` (0600) |
| `hyp remote list` | targets + `token: stored / missing` (never the token) | — |
| `hyp remote remove <name>` | drop target + its credential | local config + store |

`hyp remote add` is a [local-layer writer](./0031-layered-config.decision.md#local-layer-writers)
(create-or-augment), so an admin who never ran HypAware gets queryable in two
commands: `hyp remote add prod <url>` → `hyp remote login prod` → `hyp query sql …
--remote prod`. `hyp mcp attach` (LLP 0034) optionally wires an AI client.

## Results: truncation and flag compatibility

<a id="two-truncations"></a>A remote result can be clipped **twice**, surfaced as
**two distinct stderr lines**:

1. **Server cap (data volume).** The server's read tools enforce row/byte caps and
   mark `truncated` + the limit hit; *those rows never left the server*. Surfaced
   as e.g. `remote: showing first N rows (server cap rows:10000) — narrow the
   query, or read the Iceberg archive directly for bulk` (server LLP 0006
   §result-caps). The client **cannot lift this cap**.
2. **Client display budget (context volume).** The rendered result flows through
   the same `applyContextControls` path as local (`DEFAULT_QUERY_MAX_BYTES`,
   32 KB) with its "rows withheld" notice. `--output` / `--max-bytes 0` lift
   **only this**, never the server cap.

`2>/dev/null` hides **both** signals — never suppress stderr on a remote query.

<a id="flag-compat"></a>**Flag compatibility.** `--format`/`--output`/`--max-cell`/
`--max-bytes` are client-side render controls and stay valid under `--remote`.
`--refresh` is a **local cache** operation, meaningless remotely (the server owns
its freshness), so `--remote` **with** `--refresh` is a **hard error**, not a
silent ignore.

## References

- [LLP 0034](./0034-mcp-host-intrinsic.decision.md) — producer half (MCP hosting
  intrinsic; verbs; transport; scoped credential)
- [LLP 0025](./0025-remote-config-join-flow.spec.md) — sibling: client half of
  remote *config*
- hypaware-server LLP 0006 (admin query attach), LLP 0010 (server-side graph) —
  design authority; a server LLP for the scoped credential + MCP route is pending
- [LLP 0031](./0031-layered-config.decision.md) — query is local-only
- [LLP 0009](./0009-cli-registry.spec.md), [LLP 0015](./0015-query-and-datasets.spec.md)
