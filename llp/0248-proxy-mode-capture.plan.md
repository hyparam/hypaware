# LLP 0248: Proxy-mode capture, implementation plan

**Type:** plan
**Status:** Active
**Related:** LLP 0245, LLP 0231
**Generated-by:** neutral

> Executable plan for the `proxy-mode-capture` change set, refining design
> LLP 0245 (which covers RFC LLP 0231). The plan's headline finding is that
> the design is already realized on `master`; the tasks below close the two
> gaps the design-versus-tree audit actually found, and nothing else.

## Audit: what is already built on `master` {#audit}

LLP 0245 section 0 states the design is realized by `fa701a7e` (#782, the
transport, aperture, CA and attach) and `d0f7c4ad` (#792, status and trust
reporting), and this branch's merge base (`04330abb`, #794, the LLP
0242-0244 rollout) already contains both. The audit for this plan verified
every file, symbol and test the design names against that tree:

- **Core TLS toolkit** (design section 2): `src/core/tls/x509.js`
  (`generateKeyPair`, `mintCertificate`, `derToPem`,
  `readNameConstraints`), `src/core/tls/ca.js` (`INTERCEPT_PROVIDER_HOSTS`
  with exactly the three LLP 0238 hosts, `defaultStateRoot`, `caPaths`,
  `fingerprint`, `ensureLocalCa`, `createLeafStore`, `readLocalCaInfo`,
  `waitForLocalCa`, `deleteLocalCa`), `src/core/tls/darwin_trust.js`
  (`CA_COMMON_NAME`, `loginKeychainPath`, `isCaTrusted`, `installCaTrust`,
  `removeCaTrust`), and `src/core/daemon/launchd_env.js` (all eight
  exports). All present as designed.
- **Gateway front door** (section 3):
  `hypaware-core/plugins-workspace/ai-gateway/src/connect.js`
  (`attachConnectFrontDoor`, `isLoopbackAddress`, `CONNECT_HOST` /
  `CONNECT_PORT` symbols and readers, `openUpstream`, `parseAuthority`),
  `proxy.js` (`startProxy`, `interceptsHost`, `matchUpstreamByHost`,
  `shouldRecordProxyExchange`, `compileUpstreams`, `createChainedAgent`),
  `source.js` (`record_prefix` merge from the preset `path_prefix`, and the
  full status surface: `proxy_mode`, `ca_fingerprint`, `ca_not_after`,
  `ca_cert_path`, `ca_permitted_hosts`, `proxy_mode_error`), and
  `config.js` (`proxy_mode` strictly-true switch, `upstream_proxy`). All
  present.
- **Claude attach** (section 4):
  `hypaware-core/plugins-workspace/claude/src/settings.js` (`MODE_PROXY` /
  `MODE_BASE_URL`, `PROXY_MODE_ENV_KEYS` of exactly `HTTPS_PROXY` and
  `NODE_EXTRA_CA_CERTS`, marker `mode` / `prev_env`, mode-migration key
  release), `index.js` (CA-existence preflight via `readLocalCaInfo`,
  Darwin trust and launchd steps), the disk-driven undo in
  `src/core/config/client_detach_disk.js` (`detachClientFromDisk`), and
  `purgeProxyTrustResidue` in `src/core/commands/clients.js`. All present.
- **Status surface** (section 5): `ProxyTrustReport` in
  `src/core/daemon/types.d.ts`, populated by `src/core/daemon/status.js`
  and rendered by `src/core/commands/status.js`. Present.
- **Tests** (section 7): every named traditional test exists and passes
  (120 tests across `test/core/tls-x509.test.js`, `tls-ca.test.js`,
  `tls-darwin-trust.test.js`, `status-proxy-trust.test.js`,
  `test/plugins/ai-gateway-connect-front-door.test.js`,
  `ai-gateway-proxy-mode.test.js`, `ai-gateway-proxy-routing.test.js`,
  `claude-settings-proxy-attach.test.js`, plus the rollout-era
  `test/core/attach-proxy-migration.test.js` and
  `test/core/gateway-proxy-enable.test.js`).
  The `gateway_claude_capture` hermetic smoke runs green;
  `claude_attach_detach` and `client_attach_idempotent` flows exist.
- **Annotations**: sixteen source files already carry `@ref LLP 0232`
  through `@ref LLP 0239` annotations at the seams the design describes.

**No task below rewrites any of that.** A worker who believes a section 2-5
mechanism is missing should re-read this audit and the tree before writing
code; the correct output for already-built scope is no diff.

## Gaps the audit found {#gaps}

Two, both documentation:

1. **The manual acceptance gate the design cites does not exist.** Design
   section 7 says "the written acceptance procedure in `docs/ACCEPTANCE.md`
   remains the manual gate for real-daemon, real-keychain behaviour", but
   `docs/ACCEPTANCE.md` contains only `codex_desktop_capture` and
   `openclaw_capture`. Nothing written covers proxy-mode attach on a real
   Mac: the keychain trust dialog, the launchd environment, Remote Control
   surviving attach (the whole point of RFC 0231), or purge. Hermetic
   smokes shim the `security` / `launchctl` seams (LLP 0181 rule restated
   in LLP 0244), so only a written manual procedure can gate that
   behaviour.
2. **The request has no forward-ref to its design of record.** LLP 0231's
   header carries `Related:` and `Spawns:` but nothing pointing at LLP
   0245, so the coverage edge is discoverable only from the design side.
   The corpus convention is to append a forward-ref to the covered doc;
   forward-refs are among the trivial editorial edits an Accepted doc
   still admits.

## Out of scope {#out-of-scope}

Who turns proxy mode on (fresh-install composition, existing-install
migration) is LLP 0242's problem, was designed in LLP 0251 per the design's
section 0, and in fact already landed on `master` as #794; it belongs to
its own change set either way. Codex stays base-URL (RFC 0231). The
`upstream_proxy` field-testing question and claude-code#75050 are recorded
open items, not tasks.

## Tasks

- id: T1  branch: task/proxy-mode-capture/T1  deps: []  complexity: 3  -- Write the missing manual acceptance procedure `claude_proxy_capture` in docs/ACCEPTANCE.md, in the same shape as the existing `codex_desktop_capture` and `openclaw_capture` entries (what it proves, what it does not prove, prerequisites, exact commands, pass condition, an "If it fails" section). Opt-in/manual, needs a real Mac. It must cover, from LLP 0245 sections 1, 4 and 6: real `hyp daemon install`/start, `hyp attach claude` in proxy mode writing only HTTPS_PROXY and NODE_EXTRA_CA_CERTS into ~/.claude/settings.json, the macOS keychain trust dialog naming all INTERCEPT_PROVIDER_HOSTS, NODE_USE_SYSTEM_CA visible via `launchctl getenv` with the fully-quit-and-reopen-terminal caveat (LLP 0239), a Claude Code session producing rows in ai_gateway_messages attributable via entrypoint while Remote Control inbound still works (the RFC's whole point), `hyp status` reporting the ProxyTrustReport fields, detach restoring env keys while the CA and keychain trust survive (LLP 0238), and `hyp detach claude --purge` plus `hyp daemon uninstall` removing CA, trust and launchd residue. Also add `claude_proxy_capture` to the written-procedures list in CLAUDE.md's Smoke Test Model section (currently lists only codex_desktop_capture). Do NOT touch any code: the mechanisms are all built and green on master (see #audit). Verification is `npm test` still green and the two docs reading consistently; no new automated tests. Prose rules apply: no em dashes anywhere.
- id: T2  branch: task/proxy-mode-capture/T2  deps: []  complexity: 1  -- Append the design-of-record forward-ref to the request: in llp/0231-proxy-mode-capture.rfc.md's metadata header add a line `**Design:** LLP 0245` directly after the `**Spawns:**` line. This is a trivial editorial forward-ref, explicitly permitted on an Accepted doc; change nothing else in the file (no body edits, no status change). Check llp/0232 through llp/0239 headers and confirm they need no equivalent edit (0232, 0233 and 0235 already carry Extended-by/Superseded-by lines; the design cites all of them from its own side, and per-decision back-refs from code already exist). Verification: `npm test` untouched and green, and a grep shows exactly one new line added under llp/.
