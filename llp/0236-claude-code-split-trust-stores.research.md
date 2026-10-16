# LLP 0236: Claude Code verifies TLS against two different trust stores

**Type:** Research
**Status:** Active
**Systems:** Gateway, Config
**Author:** Phil / Claude
**Date:** 2026-08-15
**Related:** LLP 0231, LLP 0232, LLP 0235, LLP 0237, LLP 0238, LLP 0239

> One Claude Code process verifies TLS two different ways. The main API client
> honours `NODE_EXTRA_CA_CERTS`; the Remote Control SSE transport uses the
> Bun runtime's default store, which honours only `NODE_USE_SYSTEM_CA=1` read
> from the real environment at process boot. Any interception design must
> satisfy both, and only the macOS keychain can.

## Why this document exists

PR #782's premise was that `NODE_EXTRA_CA_CERTS` makes Claude Code trust the
interception CA. That is true of the main API client and false of the SSE
transport behind Remote Control, which is why the PR was closed: capture
worked while messages sent from the phone silently never arrived. The
findings below were established by live experiment on Claude Code 2.1.233
(a compiled Bun 1.4.0 binary) against the real `api.anthropic.com`, and they
constrain every current and future interception design, so they are recorded
once here rather than re-derived.

## Findings

### Split trust

**F1. Trust is split inside one process.** In a single
attached session, `/v1/messages` traffic verified against the HypAware CA
(capture recorded rows) while `SSETransport` failed
`unable to verify the first certificate` seven times on
`GET /v1/code/sessions/<id>/worker/events/stream` - the same host. The main
API client builds its own CA material from `NODE_EXTRA_CA_CERTS`; the SSE
transport calls a bare `fetch()` with no agent or CA option and therefore
uses the Bun process-default store, which `NODE_EXTRA_CA_CERTS` never
reaches. Outbound Remote Control events are a plain POST through the main
client, which is why the chat renders on the phone while nothing arrives in
the session.

### System CA lever

**F2. `NODE_USE_SYSTEM_CA=1` is the only working
lever.** Bun merges the macOS keychain into its default store only when this
variable is set. With the CA trusted in the keychain and the variable set at
launch, the SSE stream connects, phone messages arrive, and capture keeps
recording in the same window (verified twice: system-keychain trust, then
login-keychain trust).

### User-domain suffices

**F3. User-domain trust suffices; no
privilege is needed.** Trust installed with
`security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db`
(user domain, login keychain, no `sudo`) satisfies the bundled Bun's keychain
merge. macOS itself raises a native password dialog for the trust-settings
write. Admin rights and the System keychain are not required.

### Boot-time env

**F4. The variable must be in the real environment
at process boot.** Delivered via the `env` block of `~/.claude/settings.json`
it does not work: the same block's `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`
were demonstrably honoured and capture recorded rows, yet SSE failed
identically, because Claude Code applies settings env after startup while the
Bun runtime fixes its default trust store from the process environment before
any JavaScript runs. Node and Bun have no per-user config file that can set
it either; `bunfig.toml` is not read by compiled binaries.

### Cert-store setting

**F5. `CLAUDE_CODE_CERT_STORE=system` does not
govern the SSE path.** Tested first-hand on a rig with verified keychain
trust: the setting is read (the client logs `CA certs: stores=system` instead
of `stores=bundled,system`) and works when delivered via settings env, but it
reconfigures only the main client's CA material; SSE failed identically. This
confirms the report in claude-code#63470 rather than trusting it.

### No-proxy cannot help

**F6. No exemption can route around it.**
The SSE endpoint is on `api.anthropic.com`, the one host proxy mode must
decrypt to capture anything, so `NO_PROXY` either breaks capture or does not
cover the failing request. Path-based exemption is impossible: the TLS
handshake fails before any request path exists, and CONNECT names only a
host. Both were proven by experiment, not inference.

## Consequences

- A proxy-mode attach that writes only `HTTPS_PROXY` +
  `NODE_EXTRA_CA_CERTS` (LLP 0232) silently breaks every Bun-native-fetch
  transport in Claude Code. Remote Control is the first found; others may
  exist or be added upstream at any time.
- The macOS keychain is the only store both clients read, so keychain trust
  is a requirement of interception, not an optional hardening. LLP 0237
  settles how attach installs it.
- `NODE_USE_SYSTEM_CA=1` must reach the real launch environment. LLP 0239
  settles the delivery mechanism.
- The dependency is on unreleased Bun behaviour (Claude Code bundles a Bun
  canary). An upstream change can silently remove the lever; the first
  symptom would be inbound Remote Control messages vanishing while everything
  else works. The durable fix is upstream (claude-code#75050): the SSE
  transport honouring the same CA configuration as the main client.

## Provenance

Live runs on this machine, 2026-08-14/15, recorded in
`/tmp/hyp-proxytest/RUNBOOK-keychain.md` and `/tmp/rc-debug-{A..F}.txt`:
A/B the failure and `NO_PROXY` refutation; C the system-keychain fix; D the
login-keychain no-sudo fix; E the settings-env delivery refutation; F the
`CLAUDE_CODE_CERT_STORE` refutation. Upstream: claude-code#75050 (open, the
underlying bug), #63470, #76642, #86109 (same symptom under other
TLS-inspecting middleboxes).
