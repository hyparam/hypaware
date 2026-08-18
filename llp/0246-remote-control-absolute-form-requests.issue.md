# LLP 0246: Remote Control sends absolute-form requests, and the gateway refuses them with a local 404

**Type:** Issue
**Status:** Draft
**Systems:** Gateway, Sources
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0231, LLP 0232, LLP 0233, LLP 0242

> With proxy-mode attach, `claude` Remote Control fails with "Remote Control
> environments are not available for your account." The account message is
> false: the client's registration request arrives in a shape the gateway
> does not serve, the gateway answers its own local 404, and Claude Code
> misreads that 404 as a missing account feature.

## Observed

On a proxy-mode install (post #782/#794), starting Claude Code Remote Control
fails immediately with the account-availability message. With
`NO_PROXY=api.anthropic.com` it works at once, so the account is fine and the
proxy is the variable.

On the wire (verified with a logging relay): Remote Control's first call is
`POST https://api.anthropic.com/v1/environments/bridge` to register the
machine, and unlike Claude Code's main API client, the bridge's internal HTTP
client does not open a `CONNECT` tunnel through `HTTPS_PROXY`. It sends the
request to the gateway port as **absolute-form plaintext HTTP**
(`POST https://api.anthropic.com/... HTTP/1.1`), bearer token included.

The same request replayed through a proper `CONNECT` tunnel returns 200, so
forwarding, auth, and TLS trust (LLP 0236/0237/0239) are all fine.

## Why

The gateway serves exactly two request shapes (LLP 0233
#one-listener-two-front-doors): path-routed reverse-proxy origin-form
requests, and `CONNECT` tunnels. Absolute-form is a third shape it never
anticipated, and the request path drops its one distinguishing fact:

- `handleRequest` (`hypaware-core/plugins-workspace/ai-gateway/src/proxy.js`)
  parses `req.url` with `new URL(requestUrl, 'http://placeholder')`. For an
  absolute-form request the absolute URL wins over the placeholder base, so
  `parsedUrl.host` is `api.anthropic.com`, but nothing reads it.
- The socket carries no `CONNECT` stamp, so `proxyMode` is false and routing
  falls to `matchUpstream` on `parsedUrl.pathname` alone. The host the client
  named is silently discarded.
- `/v1/environments/bridge` matches no upstream's path anchor, so the gateway
  answers its own `404 {"error": "no upstream matches path"}` and the request
  never reaches Anthropic.
- Claude Code interprets a 404 from the environments endpoint as "feature not
  available for your account", which produces the misleading message.

## Impact

- Remote Control inbound is broken on every proxy-mode install, which is the
  very defect proxy mode shipped to fix (LLP 0231, LLP 0242). The regression
  has a different mechanism than the base-URL one but the same user-visible
  outcome.
- The error message actively misdirects: it blames the account, so a user has
  no path from the symptom to the proxy.

## Resolution

LLP 0247: absolute-form request-targets become a third front door. The
request line's authority routes through `matchUpstreamByHost` with the same
per-path recording rules proxy-mode tunnels use; hosts no upstream names are
refused, as are non-loopback peers, so the listener does not become a general
open proxy. Implemented in the gateway's `handleRequest`, with regression
tests replaying the exact on-the-wire request shape (absolute-form plaintext
`POST` to the listener port) in
`test/plugins/ai-gateway-absolute-form.test.js`.

## Upstream

Separately worth filing with Anthropic as a Claude Code bug: the Remote
Control bridge client ignores standard `HTTPS_PROXY` tunneling semantics and
sends its bearer token in plaintext to the proxy port. Absolute-form to a
proxy is legitimate for `http://` targets, but an `https://` target should be
reached via `CONNECT`, both for interop and so credentials stay inside TLS.
