# LLP 0062: Ship a built-in default remote so the central server needs no `remote add`

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Query, MCP
**Author:** Kenny / Claude
**Date:** 2026-07-02
**Related:** LLP 0033, LLP 0031, LLP 0084

> LLP 0033 gave every install a target registry (`query.remotes`) and a
> `default_remote`, but reaching the Hyparam-hosted central server still took a
> `hyp remote add <name> <url>` on each machine, and the `default_remote` field
> was validated yet never consumed. This decision ships the central server as a
> built-in target and wires the default so `hyp <verb> --remote` (no name) and
> `hyp remote login` (no name) both resolve it. It extends LLP 0033 §targets; it
> supersedes nothing.

## Decision

### D1 — A built-in target, shipped in the client

<a id="builtin"></a>The client ships a constant registry of built-in targets
(`BUILTIN_REMOTES`), currently the single entry `hyperparam →
https://hypaware.hyperparam.app`, plus `BUILTIN_DEFAULT_REMOTE = 'hyperparam'`.
Target resolution reads the **effective** registry: built-ins with the user's
`query.remotes` layered on top, so a user entry of the same name repoints or
shadows a built-in (`effectiveRemotes`). The URL is non-secret and committable,
exactly as a `hyp remote add` URL is (LLP 0033 §targets); shipping it in the
public client is therefore consistent with that section, not a secrets leak.

This keeps the local-first default intact: a bare `hyp <verb>` still runs
locally. The built-in only changes what a target *name* resolves to, never
whether a plain command goes remote.

> **Extended-by: [LLP 0084](./0084-mcp-endpoint-from-base.decision.md).** This
> base URL is not the MCP endpoint; the client derives `<base>/v1/mcp` for the
> actual tool calls (LLP 0033 originally documented the url as the full endpoint,
> so a url already ending in `/v1/mcp` is still honored verbatim). Issue #274 was
> this base 404ing before that derivation existed.

### D2 — Bare `--remote` and bare `remote login` resolve the default

<a id="bare-remote"></a>`--remote` becomes optionally-valued. A bare `--remote`
parses to an empty-string sentinel (distinct from `undefined`, which stays
"local"); the command path resolves it to `effectiveDefaultRemote(config)` — an
explicit `query.default_remote` if set, else `BUILTIN_DEFAULT_REMOTE`. A named
`--remote <name>` is unchanged. Symmetrically, `hyp remote login` with no
positional target resolves the same default, the companion of bare `--remote`
so the one-time sign-in needs no name either.

The resolver is never empty, so bare `--remote` always resolves to a target;
this is the behavior LLP 0033's schema comment already anticipated ("`--remote`
with no arg never silently resolves to nothing").

### D3 — `default_remote` may name a built-in

<a id="validation"></a>Config validation for `query.default_remote` accepts a
name defined in the user's `remotes` **or** in `BUILTIN_REMOTES`, so a config may
default to the central server without restating its URL.

## Consequences

- Onboarding drops to `hyp remote login` then `hyp <verb> --remote`; no
  `remote add`, no URL to copy.
- Credentials are still per-target (`HYP_REMOTE_TOKEN_HYPERPARAM`, or the stored
  `0600` session under the `hyperparam` key), unchanged from LLP 0033 §credentials.
- Changing the central URL is a client release (it is compiled in). A user who
  must override it before then adds a `query.remotes.hyperparam` entry, which wins.
