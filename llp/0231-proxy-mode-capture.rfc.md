# LLP 0231: Proxy-mode capture for Claude Code

**Type:** RFC
**Status:** Accepted
**Systems:** Gateway, Sources, Config, Plugins, Privacy
**Author:** Phil / Claude
**Date:** 2026-08-14
**Related:** LLP 0016, LLP 0044, LLP 0045, LLP 0049, LLP 0066, LLP 0086, LLP 0114, LLP 0116, LLP 0176, LLP 0192, LLP 0206
**Spawns:** LLP 0232, LLP 0233, LLP 0234, LLP 0235
**Designed-by:** LLP 0245, proxy-mode capture technical design

> Claude Code disables **Remote Control** whenever `ANTHROPIC_BASE_URL` points
> anywhere other than `api.anthropic.com`. Attach repoints exactly that key, so
> attaching a machine costs the user Remote Control. This is a deliberate
> client-side gate, not a gateway bug, so no amount of improving the gateway
> reaches it. The fix is to stop repointing the base URL: route Claude Code
> through the gateway with `HTTPS_PROXY` and a machine-local CA instead, leaving
> the endpoint genuinely first-party.

## Context

Today's Claude attach writes `env.ANTHROPIC_BASE_URL = http://127.0.0.1:18521`
into `~/.claude/settings.json` (LLP 0045). Everything downstream follows from
that one key:

- Remote Control refuses to run ("Remote Control is only available when using
  Claude via api.anthropic.com"), and Remote Control itself runs over
  `api.anthropic.com`.
- Claude Code flips a single is-first-party predicate, which is why attach also
  has to set `ENABLE_TOOL_SEARCH` and the undocumented
  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` (LLP 0045). The second is an
  undocumented key carrying a standing duty to re-verify it every release.

Under a proxy the base URL is untouched, so the endpoint *is*
`api.anthropic.com`, the predicate is true on its own terms, and both override
keys stop being needed rather than merely being unset.

### What was validated before this was proposed

Measured on 2026-08-14 against Claude Code 2.1.232 (native binary):

1. `HTTPS_PROXY` is honoured by the native binary. A plain CONNECT tunnel saw
   all 14 `api.anthropic.com` connections and the session completed normally.
2. TLS interception works and the binary accepts an inspecting CA via
   `NODE_EXTRA_CA_CERTS`. No pinning, no TLS errors, the SSE stream survived
   being teed. The system trust store was never touched.
3. Captured data is equivalent. The same prompt captured through both mechanisms
   and run through the real projector produced **4 rows / 35 populated columns**
   either way, with identical `provider`, `model`, `tools`, `user_id`,
   `client_version`, `conversation_source` and `entrypoint`. The only delta was
   a per-request billing-header nonce.

So the question this RFC settles is not whether proxy capture works. It is what
it costs, because a proxy sees strictly more than a reverse proxy does.

## The real problem: aperture, not transport

A reverse proxy only ever receives what a client deliberately sends it. A proxy
receives **all** client egress. In the validation run that included
`http-intake.logs.us5.datadoghq.com` and `pypi.org` alongside Anthropic, and on
the Anthropic host it included `/api/eval/sdk-*`, `/mcp-registry/v0/servers`,
`/api/claude_code_penguin_mode`, `/v1/mcp_servers`,
`/api/oauth/account/settings`, `/api/claude_cli/bootstrap`,
`/v1/ultrareview/quota` and `/api/claude_code_grove`.

This collides with settled decisions, and the collisions are the substance of
this RFC:

- **LLP 0044** states as settled context: *"Live capture is opt-in per client.
  The gateway records only traffic a client actually routes to it."* A naive
  proxy mode makes that sentence false.
- **LLP 0016** and **LLP 0116** describe the gateway as a byte-transparent
  passthrough holding no secret-bearing code. A CA private key is secret-bearing.
- **LLP 0049 R1** keys the `.hypignore` drop on a resolved `cwd`, and **LLP
  0050** puts enforcement in the adapters because only they resolve one.
  Arbitrary host traffic has no `cwd` and no owning adapter.
- **LLP 0192** (open issue) records that rows with a null `client_name` escape
  the client opt-out entirely. Recording arbitrary host traffic would manufacture
  those at scale.
- **LLP 0114 #interception-accepted** accepted daemon-down port squatting on the
  reasoning that "a local process able to bind the port can already read the
  client settings files and tokens directly". It also says explicitly: do not add
  mutual authentication as a drive-by hardening without revisiting this decision.

The measured hole is not hypothetical. The claude projector's matcher
(`isAnthropicExchange`) accepts a request on an `sk-ant-` bearer header alone,
without requiring the `/v1/messages` path. That is correct for a reverse proxy,
where the only traffic arriving is traffic pointed at us. Under a proxy it is
true of *every* request the client makes to the host: a synthetic POST to
`/api/eval/sdk-xxx` carrying a `messages` array projected **2 stored rows**.

## Options

1. **Do nothing.** Keep base-URL attach; users lose Remote Control while
   attached. Rejected: the whole point of the product is to be invisible to the
   user's workflow, and this is a visible, permanent tax.
2. **Proxy mode, record everything we can decrypt.** Simplest to build, and the
   one that actually contradicts LLP 0044, 0049, 0050 and 0192. Rejected.
3. **Proxy mode with a narrowed aperture.** Decrypt only hosts a registered
   upstream names; blind-tunnel everything else; record only paths an upstream's
   declared `path_prefix` claims. Capture is byte-for-byte what it is today; only
   the *transport* changes.
4. **A separate `@hypaware/http-proxy` plugin**, as LLP 0016 anticipated for a
   general HTTP proxy. Rejected for this change: that plugin's purpose is to
   capture arbitrary HTTP into its own table, which is the opposite of what this
   needs. This is the same capture, reached a different way, so it belongs to the
   same plugin and the same table.

## Decision

**Option 3.** Proxy mode is added to `@hypaware/ai-gateway` as a second front
door on the existing listener, with an aperture deliberately narrowed to match
what the reverse proxy already captures.

The four separable choices are spawned as their own decisions so code can cite
them granularly:

- **LLP 0232** - Claude Code attaches through an HTTPS proxy, not a repointed
  base URL.
- **LLP 0233** - One listener serves both front doors, and proxy mode is
  explicit.
- **LLP 0234** - Decryption follows the routing table; recording follows the path
  anchor.
- **LLP 0235** - The interception CA is minted in-process, name-constrained, and
  removed on detach.

## Consequences

**LLP 0044's sentence is narrowed, not discarded.** "The gateway records only
traffic a client actually routes to it" becomes "the gateway records only
traffic a registered upstream's path anchor claims". LLP 0234 carries the
narrowing and the reasoning. Because the anchor set is exactly the set of paths
today's presets already declare, the rows produced are the same rows.

**LLP 0016 / 0116's passthrough claim is qualified.** The gateway now holds a
private key. It is generated locally, never leaves the machine, is constrained
by `nameConstraints` to the hosts it intercepts, and is deleted on detach (LLP
0235). The claim that survives is the one that mattered: the gateway still adds
no credential of its own to any request and remains byte-transparent to the
upstream.

**LLP 0114 #interception-accepted is revisited, and its conclusion holds.** A
squatter on 18521 in proxy mode receives more traffic than before. But the CA
key is mode 0600 in the state root, so reading it already requires the same-user
access that section conceded lets an attacker read the client's tokens directly.
The boundary has not moved; the blast radius within it has, and this is recorded
rather than waved away. Mutual authentication is still not added.

**LLP 0206 (uninstall detaches clients) matters more.** A leftover
`ANTHROPIC_BASE_URL` with nothing listening breaks model calls. A leftover
`HTTPS_PROXY` with nothing listening breaks *all* of Claude Code's HTTPS,
including authentication and updates. This is the single worst failure mode the
change introduces, and LLP 0232 answers it with a preflight that refuses to
attach unless proxy mode is genuinely running.

**The session-start hooks are unaffected.** Proxy mode still writes
`~/.claude/settings.json`, just different keys inside the same `env` block, so
the LLP 0106 and LLP 0107 hook installs, `cwd` attribution and the LLP 0085
settlement sidecar are untouched. This was the largest thing that could have
broken and does not.

**Codex is out of scope.** It is a Rust client and will not honour
`NODE_EXTRA_CA_CERTS`; its attach stays base-URL. Both mechanisms therefore have
to coexist, which LLP 0233 provides for.

## Open questions

- **LLP 0192 remains open and is now more load-bearing.** Nothing here creates
  null-`client_name` rows (the path anchor prevents it), but the issue should be
  closed before any future widening of the anchor set.
- **`.hypignore` and side-channel traffic.** Not a new hole, because unmatched
  paths are never recorded. It becomes one the moment a path anchor covers a
  request with no resolvable `cwd`.
- **Corporate proxy chaining is implemented but untested against a real
  enterprise proxy.** `upstream_proxy` chains both blind tunnels and the
  intercepted leg; it has unit coverage and no field evidence.
