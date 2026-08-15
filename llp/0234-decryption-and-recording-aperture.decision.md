# LLP 0234: Decryption follows the routing table; recording follows the path anchor

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Privacy
**Author:** Phil / Claude
**Date:** 2026-08-14
**Related:** LLP 0016, LLP 0044, LLP 0049, LLP 0050, LLP 0176, LLP 0192, LLP 0231

> A proxy sees all client egress. Two narrowings keep proxy-mode capture
> identical to what the reverse proxy already records: decrypt only hosts a
> registered upstream names, and record only paths that upstream's declared
> `path_prefix` claims. Everything else is a blind tunnel or an unrecorded
> pass-through.

## Context

This is the decision LLP 0231 exists to make. Under `HTTPS_PROXY` the gateway
receives every connection Claude Code opens, not just the ones aimed at it. The
validation run saw `http-intake.logs.us5.datadoghq.com` and `pypi.org` alongside
Anthropic; on the Anthropic host it saw eight distinct side-channel paths
(`/api/eval/sdk-*`, `/mcp-registry/v0/servers`, `/api/oauth/account/settings`,
`/api/claude_cli/bootstrap` and others).

LLP 0044 states as settled context that *"the gateway records only traffic a
client actually routes to it"*. That sentence is a promise about aperture that
happened to be implemented by the transport. When the transport stops enforcing
it, something else must.

## Decision

### Blind tunnel by default

**Blind tunnel is the default
disposition.** A `CONNECT` to any host outside the intercept set is piped
between client and destination without being decrypted. The gateway learns the
host and the byte counts and nothing else. This is not a performance choice: a
proxy that decrypts everything it *could* decrypt would be reading the user's
package installs and telemetry, which no part of this product has ever asked
for.

### Intercept set is the routing table

**The intercept set is derived
from the routing table, never configured separately.** A host is decrypted only
when a registered upstream's `base_url` names it. One fact lives in one place:
adding an adapter widens what is decrypted, and nothing else does. The CA's
`nameConstraints` are minted from the same list (LLP 0235), so the set of hosts
we can technically impersonate and the set we intend to intercept cannot drift
apart.

### Recording is opt-in per path

**Recording is opt-in per path, and the
opt-in is the upstream's declared `path_prefix`.** Decrypting a host does not
imply persisting it. An exchange is recorded only when the path matches the
prefix its upstream declares, which for the Anthropic preset is `/v1/messages`,
the exact set the reverse proxy already receives.

Reusing the *routing* matcher here would be wrong, and measurably so. The
Anthropic matcher deliberately accepts a request on an `sk-ant-` bearer header
alone so that reverse-proxy traffic still routes on an unfamiliar path. Under a
`CONNECT` that predicate is true of every request the client makes to the host:
a synthetic POST to `/api/eval/sdk-xxx` carrying a `messages` array projected
**2 stored rows** through exactly that hole. The path anchor closes it.

A catch-all (`/`) or absent prefix records **nothing**. Failing closed is the
only safe default when the question is "should this be persisted", and a
catch-all reading as record-everything is precisely the aperture being refused.

**The anchor comes from the adapter's preset, not from operator routing
config.** These are different questions: `path_prefix = "/"` in a config file
says "route everything on this host to this upstream", never "record everything
on this host". Because operator config wins over a same-name preset, reading the
routing prefix as the anchor meant a default `hyp init` install compiled a
routing table with prefix `/` and recorded **nothing at all** - the feature was
dead on arrival for the install everyone has, and every test that used a
hand-written upstream missed it. The preset's `path_prefix` (and its `provider`
label, which was also being dropped) is carried onto the merged entry as
`record_prefix` and used for the anchor.

An unrecorded request is not merely unwritten: no exchange is started at all, so
no request or response body is ever buffered. Beyond privacy this matters for
memory, since the side channels include multi-hundred-kilobyte
`/mcp-registry` responses and long-lived streams.

## Consequences

- **LLP 0044's aperture sentence is narrowed and re-grounded.** "Records only
  traffic a client routes to it" becomes "records only traffic a registered
  upstream's path anchor claims". Because the anchors are the prefixes today's
  presets already declare, the rows produced are the same rows: capture parity
  was measured at 4 rows / 35 populated columns either way.
- **No new null-`client_name` rows.** LLP 0192's open issue (unattributed rows
  escaping the client opt-out) is not made worse, because the only traffic
  recorded is traffic an adapter's projector already owns. It must be closed
  before any future widening of the anchor set.
- **`.hypignore` (LLP 0049 R1 / LLP 0050) is not newly holed.** Enforcement
  still happens in the adapters on a resolved `cwd`, and the only exchanges that
  reach a projector are ones an adapter claims. It would become a hole the moment
  a path anchor covered a request with no resolvable `cwd`.
- **LLP 0176's silent-blindness class is bounded, not solved.** Unrecognised
  traffic still passes through silently. The difference is that under proxy mode
  the set of things passing through unrecorded is now large and expected rather
  than small and surprising, which is why the disposition is a stated rule here
  rather than an emergent one.
- The pass-through path is covered by tests asserting the *negative*: a
  side-channel path is proxied faithfully and starts no exchange, and an
  Anthropic bearer token on an unmatched path cannot reopen the aperture.
- Interception is keyed on host **and port**. Decrypting
  `CONNECT api.anthropic.com:8443` and then forwarding it to the upstream's
  `:443` would send a request somewhere the client never addressed.
