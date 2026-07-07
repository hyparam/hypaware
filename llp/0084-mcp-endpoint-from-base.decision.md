# LLP 0084: The remote MCP endpoint derives from the registered base URL

**Type:** decision
**Status:** Active
**Systems:** MCP, Query, CLI
**Generated-by:** neutral
**Date:** 2026-07-07
**Related:** LLP 0033, LLP 0058, LLP 0062, LLP 0034

> [Issue #274](https://github.com/hyparam/hypaware/issues/274) (a real user
> report): a remote target registered with the server's **base** URL (e.g.
> `https://hypaware.hyperparam.app`, exactly what the built-in `hyperparam`
> target ships, LLP 0062 D1) 404s on the first `hyp <verb> --remote`. The MCP
> client POSTed the registered URL **verbatim**, but hypaware-server serves MCP
> only at `<base>/v1/mcp`. It was deceptive because `hyp remote login` still
> succeeded (identity derives from the URL *origin*, LLP 0058 D6), so the break
> only surfaced on the first remote verb. This decision settles that the MCP
> endpoint is **derived** from the registered URL, mirroring the identity
> derivation, with a back-compat rule for URLs that already carry the full path.

## Context

LLP 0033 §targets registered a target as `query.remotes.<name> = { url }`, and
LLP 0058 D6 called that url "the MCP endpoint" - i.e. the *full* path was the
registered value (its example was `https://hyp.internal/mcp`). But LLP 0062 D1
then shipped the built-in `hyperparam` target as the server **base**
(`https://hypaware.hyperparam.app`, no path), because that is the natural,
committable, copy-once form, and the same origin the identity base already
derives from. Those two are in tension: a base URL is not a full MCP endpoint.
Issue #274 is that tension surfacing as a 404 on the first remote verb.

## Decision

### D1 - Derive the MCP endpoint from the registered base

<a id="derive"></a>The MCP client no longer POSTs the registered `url`
verbatim. Both consumers of the URL - the one-shot verb attach (`runRemoteVerb`
-> `callRemoteTool`) and the stdio proxy fallback (`runMcpProxy`, LLP 0034) -
derive the endpoint via `deriveMcpEndpoint(url)` and POST **that**. The default
treatment is *base*: `/v1/mcp` is appended to the registered URL's path,
preserving any path prefix (a base `https://host/hypaware` ->
`https://host/hypaware/v1/mcp`). This is the sibling of `deriveIdentityBase`
(LLP 0058 D6): both derive a server endpoint from the single registered URL, so
a target is still one URL, never two.

### D2 - Back-compat: a path already ending in `/v1/mcp` is honored verbatim

<a id="back-compat"></a>If the registered URL's path already ends in `/v1/mcp`
- the full-endpoint form LLP 0033 documented, and the form a direct MCP-client
config already uses - it is used as-is, not double-suffixed to `/v1/mcp/v1/mcp`.
A trailing slash on either form is normalized away so the endpoint never
double-slashes, and an unparseable URL is returned unchanged so the derivation
never masks a bad URL (the fetch fails exactly as it did before). This keeps
every previously-working full-URL target working untouched while making a
base-URL target - the built-in, and the documented onboarding path - work for
the first time.

## Consequences

- The two query-skill docs that said "pass the full endpoint including the path
  ... used verbatim, never auto-suffixed" now describe the derive-from-base
  contract; a bare base URL is the recommended registration form.
- `deriveMcpEndpoint` lives beside `deriveIdentityBase` in
  `src/core/remote/credentials.js`, annotated `@ref LLP 0084#derive`, and is
  called at both attach entry points, matching how `deriveIdentityBase` is
  already called at each.
- Path-prefixed hosting (the LLP 0058 D6 open question) is now covered for the
  MCP side: the endpoint is appended after the prefix. Identity under a path
  prefix is still the open `identityUrl` follow-up in LLP 0058; this decision
  does not close that, it only aligns the MCP side with a path-preserving append.
- No new config surface: a target stays a single `url`. The built-in
  `hyperparam` base URL (LLP 0062 D1) is unchanged and now reaches MCP.

## References

- [Issue #274](https://github.com/hyparam/hypaware/issues/274)
- LLP 0033 §targets, §commands - the target registry and `remote add`
- LLP 0058 D6 - identity endpoints derive from the URL origin (the sibling derivation)
- LLP 0062 D1 - the built-in `hyperparam` target ships the base URL
- LLP 0034 - the stdio proxy fallback that also POSTs MCP
