# LLP 0245: Proxy-mode capture for Claude Code, technical design

**Type:** design
**Status:** Active
**Systems:** Gateway, Sources, Config, Plugins, Privacy, Core, Daemon
**Generated-by:** neutral
**Related:** LLP 0231, LLP 0232, LLP 0233, LLP 0234, LLP 0235, LLP 0236,
LLP 0237, LLP 0238, LLP 0239, LLP 0242, LLP 0243, LLP 0244, LLP 0246,
LLP 0247, LLP 0044, LLP 0045, LLP 0114, LLP 0192, LLP 0206

> Technical design for the proxy-mode capture stack the accepted RFC
> LLP 0231 asked for: Claude Code routed through the gateway with
> `HTTPS_PROXY` and a machine-local CA instead of a repointed
> `ANTHROPIC_BASE_URL`, with the aperture narrowed so the rows recorded are
> exactly the rows the reverse proxy already records. Named files, function
> seams, data flow, failure modes, and what the tests prove.

Coverage anchor:

`@ref LLP 0231: proxy-mode capture for Claude Code; the CONNECT front door, the routing-table intercept set and path-anchor recording aperture, the in-process name-constrained CA, the macOS keychain-trust and launchd-env delivery, and the proxy-mode Claude attach this document designs are LLP 0231's realization`

## 0. Scope and code status {#scope}

LLP 0231 is the accepted RFC; LLP 0232 through 0235 are its spawned
decisions, and LLP 0236 through 0239 are the research and follow-on
decisions that corrected the trust story after live testing. This document
is the implementation design that binds those decisions to the tree.

The design is realized on `master` by three commits: `fa701a7e` (#782, the
transport, aperture, CA and attach), `d0f7c4ad` (#792, the status and trust
reporting surface), and `04330abb` (#794, the LLP 0242-0244 rollout that
turns proxy mode on).
File paths and function names below are verified against that tree; the
tests named in section 7 exist and gate it. What this document adds to the
corpus is the request-level design of record: the one place the whole
mechanism is laid out end to end, with the request (LLP 0231) `@ref`'d
above.

This change set deliberately excludes who *turns proxy mode on*. Fresh
install composition and the existing-install migration are LLP 0242's
problem, settled by LLP 0243 (the picker row composes `proxy_mode`) and
LLP 0244 (attach offers the migration), and already landed on `master`.
Their own design of record belongs to that change set, not this one.

## 1. Data flow, end to end {#data-flow}

1. Attach writes `env.HTTPS_PROXY = http://127.0.0.1:<port>` and
   `env.NODE_EXTRA_CA_CERTS = <state root>/tls/ca-cert.pem` into
   `~/.claude/settings.json`. The base URL is untouched, so Claude Code's
   first-party predicate stays true on its own terms (LLP 0232).
2. Claude Code opens `CONNECT api.anthropic.com:443` against the gateway's
   one listener. The CONNECT front door checks the peer is loopback,
   answers `200 Connection Established` on the raw socket, and only then
   wraps the socket in TLS with a leaf minted for the target host
   (LLP 0233).
3. If no registered upstream names the target host and port, the socket is
   a blind tunnel: bytes piped, nothing decrypted, nothing recorded
   (LLP 0234).
4. An intercepted socket re-enters the same HTTP server via
   `server.emit('connection', tlsSocket)`, stamped with the CONNECT
   authority. The ordinary request handler runs; routing proceeds as for
   reverse-proxy traffic.
5. An exchange is recorded only when the request path matches the
   upstream's `record_prefix`, which is the adapter preset's declared
   `path_prefix` (`/v1/messages` for Anthropic). Unmatched paths are
   forwarded faithfully and never buffered (LLP 0234).
6. Recorded exchanges take the existing recorder, projector and cache
   write path unchanged; capture parity with base-URL mode was measured at
   4 rows / 35 populated columns for the same prompt (LLP 0231).

Two more macOS-only deliveries make the attach complete: the CA is
installed as a user-domain trusted root in the login keychain (LLP 0237),
and `NODE_USE_SYSTEM_CA=1` is set in the launchd user environment with a
login LaunchAgent to re-apply it (LLP 0239). Both exist because Claude
Code verifies TLS against two different stores (LLP 0236): the main client
honours `NODE_EXTRA_CA_CERTS`; the Remote Control SSE transport honours
only the keychain, merged in at process boot by that variable.

## 2. Core TLS toolkit: `src/core/tls/` {#core-tls}

The CA lives in core, not in the gateway plugin, because `hyp detach` and
`hyp daemon uninstall` must be able to remove it with no plugin loadable
(LLP 0235).

- `src/core/tls/x509.js`: minimal DER emitter signed with `node:crypto`,
  scoped to EC P-256 / ECDSA-SHA256 / UTCTime and the fixed extension set
  interception needs. Exports `generateKeyPair()`, `mintCertificate()`,
  `derToPem()`, and `readNameConstraints()`. Constraints are encoded with
  **implicit** tags for `permittedSubtrees [0]` / `excludedSubtrees [1]`
  (wrapping instead of replacing the `SEQUENCE OF` tag silently voids the
  constraint), all IPv4 and IPv6 space is excluded (a dNSName-only
  constraint leaves IP identities unrestricted per RFC 5280 4.2.1.10), and
  read-back is a structural DER walk, not a byte scan (LLP 0235).
- `src/core/tls/ca.js`: the CA lifecycle. Exports
  `INTERCEPT_PROVIDER_HOSTS` (the reviewed full-provider constant:
  `api.anthropic.com`, `api.openai.com`, `chatgpt.com`, per LLP 0238),
  `defaultStateRoot()`, `caPaths()` (the `tls/` directory in the state
  root), `fingerprint()`, `ensureLocalCa()` (mint or reuse; key written
  mode 0600; ten-year validity; regenerates when the stored key does not
  match the stored certificate, which concurrent daemon starts can
  produce; renewal roll kept for eventual expiry, deliberately longer than
  a leaf's lifetime), `createLeafStore()` (per-host leaves minted in
  memory, never written to disk), `readLocalCaInfo()`,
  `waitForLocalCa()` (polling used by attach-side flows), and
  `deleteLocalCa()` (uninstall and explicit purge only; detach keeps the
  CA per LLP 0238).
- `src/core/tls/darwin_trust.js`: keychain trust. Exports
  `CA_COMMON_NAME` (`HypAware Local CA`), `loginKeychainPath()`,
  `isCaTrusted()` (read-only `security verify-cert` probe, making the
  install idempotent and the password dialog once-per-machine),
  `installCaTrust()` (`security add-trusted-cert -r trustRoot`, user
  domain, no sudo; the native macOS dialog is the consent moment), and
  `removeCaTrust()` (LLP 0237).
- `src/core/daemon/launchd_env.js`: boot-environment delivery. Exports
  `ENV_VAR_NAME` (`NODE_USE_SYSTEM_CA`), `ENV_VAR_VALUE`,
  `ENV_AGENT_LABEL` (`com.hyperparam.hypaware.node-system-ca`),
  `envAgentPlistPath()`, `buildEnvAgentPlist()`, `installLaunchdEnv()`
  (`launchctl setenv` plus the login LaunchAgent), `removeLaunchdEnv()`,
  and `isLaunchdEnvSet()` (`launchctl getenv`, feeding status). Unlike the
  CA, these follow the attach: they are recreatable for free, so detach
  removes them (LLP 0239).

## 3. Gateway front door: `@hypaware/ai-gateway` {#front-door}

`hypaware-core/plugins-workspace/ai-gateway/src/connect.js`:

- `attachConnectFrontDoor(opts)` installs the `connect` handler on the
  **existing** HTTP server; there is no second port and every status and
  discovery surface keeps meaning one thing (LLP 0233). The two mechanical
  constraints it carries are load-bearing: the TLS socket offers
  `http/1.1` only in ALPN (an h2 negotiation would hang against the
  HTTP/1.1 server), and the `200 Connection Established` plus any early
  bytes are written to and pushed back onto the raw socket **before** the
  TLS wrap.
- `isLoopbackAddress()` gates the peer, not the bind: a non-loopback
  `CONNECT` is refused `403` before the target is parsed, blind tunnels
  included, so a `listen = "0.0.0.0"` install is never an open relay
  (LLP 0233 #loopback-peers-only).
- `CONNECT_HOST` / `CONNECT_PORT` symbols stamp the terminated socket with
  the CONNECT authority, the only new fact the request path needs;
  `connectHostOf()` / `connectPortOf()` read them back.
- `openUpstream()` dials the destination directly or through a configured
  `upstream_proxy` chain; `parseAuthority()` parses the CONNECT target.

`hypaware-core/plugins-workspace/ai-gateway/src/proxy.js`:

- `startProxy(opts)` boots the listener; with `proxy_mode` on and nothing
  to route it starts tunnel-only and says so, and with a CA on disk but
  interception unavailable it degrades to blind-tunnel-only rather than
  refusing CONNECT, because an attached client's whole egress arrives here
  (LLP 0233 #degrade-to-blind-tunnels).
- `interceptsHost(upstreams, host, port)` and
  `matchUpstreamByHost(upstreams, host, port)`: the intercept set is
  derived from the routing table and keyed on host **and** port; nothing
  configures it separately (LLP 0234).
- `shouldRecordProxyExchange(upstream, pathname)`: the recording anchor is
  `recordPrefix ?? prefix`, and an anchor of `/` or empty records nothing;
  failing closed is the default, so a routing prefix of `/` can never read
  as record-everything. Note the fallback: an upstream with no
  `record_prefix` records under its routing prefix, which is why the
  `source.js` merge below matters. The `hyp init` preset writes
  `path_prefix = "/"`, so without the merge the anchor was `/`, the
  fail-closed guard suppressed every request, and the default install
  recorded nothing at all. The routing matcher is deliberately not reused: the
  Anthropic route matcher accepts an `sk-ant-` bearer alone, which under a
  proxy is true of every request to the host and measurably reopened the
  aperture (LLP 0234 #recording-is-opt-in-per-path).
- `compileUpstreams()` carries `record_prefix` onto the compiled entry;
  `createChainedAgent()` chains the intercepted leg through
  `upstream_proxy`.

`hypaware-core/plugins-workspace/ai-gateway/src/source.js` merges each
adapter preset's declared `path_prefix` (and `provider`) onto the merged
upstream entry as `record_prefix`. Operator config still wins the *routing*
question, but the record anchor belongs to the adapter that registered the
preset: an operator writing `path_prefix = "/"` is saying "route everything
on this host here", not "record everything on this host", and the
fail-closed guard turns that into recording nothing at all on a default
install (LLP 0234). It also owns the gateway's own status details:
`proxy_mode`, `ca_fingerprint`, `ca_not_after`, `ca_cert_path`,
`ca_permitted_hosts`, `intercept_hosts`, and `proxy_mode_error` when CA
preparation failed while the gateway kept reverse-proxying.

`hypaware-core/plugins-workspace/ai-gateway/src/config.js` reads the
switch: `proxy_mode` is on only when the config field is literally `true`
(LLP 0233 #proxy-mode-is-explicit), and compiles `upstream_proxy`.

One front door post-dates this design's audit and is described here only so
the map is complete: Claude Code's Remote Control bridge sends absolute-form
plaintext requests straight at the proxy port rather than tunnelling them,
and until LLP 0246/0247 (landed as #797) the gateway routed them by pathname
alone and answered a local 404 that the client misread as an account
limitation. Absolute-form is now a third front door, routed by the host the
request line names through `matchUpstreamByHost` and recorded under the same
per-path anchor. Nothing above changes; it is the reason the acceptance
procedure's Remote Control step passes on current `master`, so a reader
diagnosing that step needs LLP 0247 as well as LLP 0237 and LLP 0239.

## 4. Claude attach: `@hypaware/claude` {#claude-attach}

`hypaware-core/plugins-workspace/claude/src/settings.js`:

- Exports `MODE_PROXY` / `MODE_BASE_URL`; `attach()` takes the mode and
  writes, for proxy mode, exactly `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`
  (`PROXY_MODE_ENV_KEYS`). `HTTP_PROXY` and `NO_PROXY` are never written;
  `ENABLE_TOOL_SEARCH` and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` are
  not needed and not written (LLP 0232).
- A displaced pre-existing `HTTPS_PROXY` is backed up to the marker's
  `prev_env`, warned about once with userinfo redacted, and the warning
  names `upstream_proxy` as the remedy for a corporate egress proxy.
- The marker (`value[MARKER_KEY]`) records `mode`, `managed.env`,
  `managed.hooks`, `prev_env`, and keeps `prev_base_url` as its own field
  so markers written by earlier versions still restore. `mode` is what
  tells the plugin-agnostic undo that proxy residue exists.
- `releaseUnmanagedKeys()` implements mode migration: switching modes
  restores-or-removes keys the new mode no longer manages, so migrating to
  proxy never strands a live `ANTHROPIC_BASE_URL` pointing at the gateway
  (LLP 0232 #mode-migration).
- The session-start hooks, `cwd` attribution and the settlement sidecar
  ride the same `env`-block write and are untouched (LLP 0231).

`hypaware-core/plugins-workspace/claude/src/index.js`:

- The proxy-attach preflight is `readLocalCaInfo()`, and what it decides is
  the *mode*: a CA on disk means `MODE_PROXY`, no CA means the attach falls
  back to base-URL mode. The CA's existence proves the gateway is actually
  serving the mode, and a proxy attach against a dead gateway would break
  all of Claude Code's HTTPS (LLP 0232 #proxy-attach-preflight). Mode is
  read from what the daemon is doing, never from what config asks for.
  Recorded precisely because LLP 0232 states this twice and the two
  statements do not say the same thing: "a missing CA is a refusal
  (`markActionRefused`), not a warning" reads absolutely, while the next
  paragraph settles "proxy mode when a CA exists and base-URL mode
  otherwise". The tree implements the second. The only `markActionRefused`
  on this path is `CA_MISSING` in `settings.js`, which fires when proxy
  mode was already selected and the certificate has since become
  unreadable, i.e. the race between the probe and the write.
- On Darwin the attach then runs the trust and launchd steps: keychain
  probe/install (dialog names all permitted hosts, per LLP 0238), and
  `installLaunchdEnv()`. A refused dialog degrades politely: attach
  completes, prints exactly what will not work (Remote Control inbound),
  and re-running attach retries (LLP 0237 #attach-anyway-on-refusal). On
  other platforms the attach states Remote Control inbound is unsupported
  under proxy mode (LLP 0237 #darwin-only). The final attach line carries
  the corrected terminal caveat: only processes launchd starts after the
  `setenv` see the variable, so a terminal app must be fully quit and
  reopened (LLP 0239 #terminals-predating-attach).

Detach and uninstall run the plugin-agnostic, disk-driven undo
(`src/core/config/client_detach_disk.js`, `detachClientFromDisk()`):
restore every managed env key from `prev_env` (falling back to
`prev_base_url`), strip managed hooks, remove the launchd env and its
LaunchAgent, and delete the marker. The CA and its keychain trust
*survive* detach so re-attach is silent; `hyp daemon uninstall` and
`hyp detach claude --purge` (`purgeProxyTrustResidue()` in
`src/core/commands/clients.js`) remove them (LLP 0238
#ca-survives-detach). The state root for the undo is resolved from the
caller's `homeDir`, never the ambient one, so a sandboxed undo cannot
delete a different install's key material.

## 5. Status surface {#status}

Two surfaces, and they carry different things.

`hyp status` reports the trust half: `src/core/commands/status.js` renders
the `proxy trust:` block from `ProxyTrustReport`
(`src/core/daemon/types.d.ts`), which is exactly three facts: the CA
fingerprint, keychain trust state, and whether `NODE_USE_SYSTEM_CA` is live
in the launchd environment (`launchctl getenv`). Trust and launchd state are
tri-state, because "the probe could not run" is not the claim "not trusted".
"The dialog was cancelled last month" is diagnosable without re-running
attach (LLP 0237).

The aperture half lives in the gateway source's own status details
(section 3): `proxy_mode`, `ca_not_after`, `ca_cert_path`,
`ca_permitted_hosts`, `intercept_hosts` and `proxy_mode_error`, readable
without grepping a boot log (LLP 0233). Note that `hyp status --json` maps
each source to name, plugin and state only and drops the details block, so
those fields are read from the daemon status file
(`hyp daemon status --json`), not from `hyp status`.

## 6. Failure modes {#failure-modes}

- **Dead gateway behind a proxy attach**: the worst mode the feature can
  have. The CA-existence preflight covers the case it was designed for, a
  machine that never ran proxy mode: no CA, so attach writes a base-URL
  attach instead. It does not cover a machine that ran proxy mode and then
  stopped the daemon: the CA outlives the process (LLP 0238), and when a
  `listen` is configured `hyp attach` resolves the endpoint from config
  rather than from a live bind, so `HTTPS_PROXY` can still be written at a
  dead port. Residual, not closed; the acceptance procedure's step 1
  therefore proves the daemon is up before attaching.
- **CA preparation fails at boot**: gateway still starts and still reverse
  proxies; `proxy_mode_error` reported; degraded blind-tunnel CONNECT
  keeps an already-attached client's egress working.
- **Trust dialog refused / non-interactive attach**: capture works, Remote
  Control inbound does not; stated, retryable.
- **Squatter on the fixed port**: revisited and accepted; the CA key is
  0600 in the state root, inside the same-user boundary LLP 0114 already
  conceded. Mutual auth deliberately not added.
- **Shutdown with live tunnels**: hijacked CONNECT sockets are destroyed
  by `stop()` itself; `server.close()` no longer knows about them.
- **Key/cert interleave from concurrent mints**: detected by the explicit
  key-matches-certificate check; regenerated instead of failing every
  handshake for ten years.
- **Upstream Bun behaviour change** (LLP 0236's canary caveat): first
  symptom is inbound Remote Control silently failing; the durable fix is
  upstream (claude-code#75050) and out of this design's control.

## 7. What the tests prove {#tests}

Traditional (root `test/`): `test/core/tls-x509.test.js` (constraint
encoding, including a minted leaf for another host failing the handshake
with `permitted subtree violation`, and structural read-back),
`test/core/tls-ca.test.js` (0600, reuse, key/cert mismatch regeneration,
wait/delete), `test/core/tls-darwin-trust.test.js` (probe-first
idempotence, refusal path), `test/plugins/ai-gateway-connect-front-door.test.js`
(loopback refusal, blind-tunnel fidelity, ALPN and early-byte ordering),
`test/plugins/ai-gateway-proxy-mode.test.js` and
`ai-gateway-proxy-routing.test.js` (the negatives that define the
aperture: a side-channel path is proxied faithfully and starts no
exchange; an Anthropic bearer on an unmatched path cannot reopen it; an
anchor of `/` or empty records nothing; interception keyed on host and
port),
`test/plugins/claude-settings-proxy-attach.test.js` (two-key write, marker
`mode`/`prev_env`, displaced-proxy backup and one-time redacted warning,
mode-migration key release), and `test/core/status-proxy-trust.test.js`
(the LLP 0237/0239 reporting). The `security` / `launchctl` seams refuse
under the test runner and are shimmed in hermetic flows, per the LLP 0181
rule restated in LLP 0244.

Hermetic smokes: `gateway_claude_capture`, `claude_attach_detach`,
`client_attach_idempotent` exercise the wiring in a temp `HYP_HOME`.
The written acceptance procedure in `docs/ACCEPTANCE.md` remains the
manual gate for real-daemon, real-keychain behaviour; hermetic runs must
never touch the host keychain or launchd table.
