# LLP 0233: One listener serves both front doors, and proxy mode is explicit

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Config
**Author:** Phil / Claude
**Date:** 2026-08-14
**Related:** LLP 0016, LLP 0114, LLP 0195, LLP 0231
**Extended-by:** LLP 0243, LLP 0244 (#proxy-mode-is-explicit: the key stays
the only switch; 0243 has fresh-install composition write it by default, 0244
has attach write it into an existing config behind an explicit consent
prompt); LLP 0247 (#one-listener-two-front-doors: absolute-form
request-targets become a third front door, host-routed and restricted to
intercepted hosts); LLP 0366 (#loopback-peers-only: the parenthetical about
what attach writes is overstated, two attach surfaces write the configured
host verbatim; 0366 records the per-writer facts and re-derives the rationale)

> `CONNECT` tunnels and ordinary origin-form requests are served by the same
> listener on the same port. Proxy mode is off unless a config explicitly turns
> it on.

## Context

Claude moves to proxy-mode attach (LLP 0232); Codex stays on base-URL attach,
because it is a Rust client that will not honour `NODE_EXTRA_CA_CERTS`. Both
mechanisms therefore have to work at once, on the same machine, against the same
daemon.

A proxy-mode client reaches the gateway with `CONNECT host:443` rather than an
origin-form request, so the two mechanisms differ in how a request *arrives*,
not in what happens to it afterwards.

## Decision

### One listener two front doors

**Both front doors share one
listener.** `CONNECT` is handled by a handler installed on the existing HTTP
server; every other request path is unchanged. A terminated tunnel is handed
back to the same server with `server.emit('connection', tlsSocket)`, after which
the normal request handler runs with an ordinary request/response pair and no
knowledge that a tunnel was involved.

This keeps the fixed default port (LLP 0114) meaning one thing, keeps
`localEndpoint()` and every status and discovery surface unchanged, and means
proxy mode reuses the entire recording, projection and write path rather than
duplicating it. The terminated socket is stamped with the host the client named
in its `CONNECT`, which is the only new fact the request path needs.

Two mechanical constraints make it work, and both are load-bearing:

- The TLS socket must offer **`http/1.1` only** in ALPN. Claude Code negotiates
  h2 when it is offered, and the HTTP/1.1 server on the other side of the socket
  cannot parse an h2 frame: the session would hang rather than fail.
- The `200 Connection Established` must be written to the raw socket, and any
  early bytes pushed back onto it, **before** it is wrapped in TLS. Replaying
  those bytes past the decryption layer corrupts the stream.

### Proxy mode is explicit

**Proxy mode is off unless configured on.**
`proxy_mode = true` in the `ai-gateway` config section is the only thing that
turns it on. Without it the listener behaves exactly as it always has and a
`CONNECT` is refused.

Installing a certificate authority and decrypting traffic is a materially larger
ask than repointing a base URL, so it is never something a config acquires by
inference, by upgrade, or as a side effect of installing an adapter. This is the
same "config is explicit" invariant the kernel already holds (LLP 0010).

### Loopback peers only

**The CONNECT front door answers the machine it runs on and nobody else.** A
`CONNECT` whose peer address is not loopback (127.0.0.0/8, `::1`, or their
IPv4-mapped forms) is refused with `403` and logged, before the target is even
parsed.

The check is on the *peer*, not the bind, and the distinction is the decision.
`listen` is operator-configurable to a non-loopback address, and before proxy
mode that exposed only reverse-proxying to registered upstreams. `CONNECT` is
categorically more: an unauthenticated tunnel to any host and any port,
including services on the gateway machine that trust 127.0.0.1, which would
make a `listen = "0.0.0.0"` install an open relay for its whole network.
Refusing the peer rather than the bind keeps that install working unchanged
for its own client - attach always writes `http://127.0.0.1:<port>` whatever
the bind host says - while closing the relay to everyone else. Blind tunnels
are refused on the same rule as terminated ones: an unrecorded relay is still
a relay.

## Consequences

- Shutdown must destroy hijacked tunnel sockets itself. `server.close()` stops
  accepting and waits on connections it knows about, and a `CONNECT` socket is
  no longer one of them, so without this `stop()` blocks until every peer gives
  up.
- A gateway with `proxy_mode` on but no upstream host to intercept idles the
  interception path and says so, rather than binding a CA for nothing. This
  follows LLP 0195's rule that an empty routing table is a legitimate state that
  must be visible.
- If the CA cannot be prepared, the gateway still starts and still reverse
  proxies; the failure is reported in `hyp status` as `proxy_mode_error` rather
  than taking capture down. A gateway that still proxies is strictly better than
  one that refuses to boot, and LLP 0232's attach preflight is what stops a
  client being pointed at the degraded mode.

### Degrade to blind tunnels

**A listener that might have a proxy-mode
client pointed at it always serves CONNECT, even when it cannot intercept.** An
attached client sends *all* its egress here, so a listener that refuses CONNECT
kills its authentication and updates, not just its capture - and refusing is
what a plain reverse-proxy listener does. Whenever interception is unavailable
but a CA is on disk (the operator turned `proxy_mode` off, or CA preparation
failed), the front door is installed in blind-tunnel-only mode. The failure
degrades to unrecorded-but-working, which is the only failure this feature is
allowed to have, and the condition is logged and surfaced in status so the
repair (`hyp attach claude`, or `hyp detach claude`) is discoverable.
- `hyp status` reports `proxy_mode`, the CA fingerprint, its expiry and the
  intercepted hosts, so the aperture is readable without grepping a boot log.
