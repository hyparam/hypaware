# LLP 0251: Proxy mode by default and the attach migration, technical design

**Type:** design
**Status:** Active
**Systems:** Config, Plugins, Gateway, Daemon
**Generated-by:** neutral
**Depends-on:** proxy-mode-capture
**Related:** LLP 0242, LLP 0243, LLP 0244, LLP 0231, LLP 0232, LLP 0233,
LLP 0031, LLP 0174, LLP 0181, LLP 0183

> Technical design for closing LLP 0242: every config-writing install path
> composes `proxy_mode: true` when a picked client attaches by proxy, and
> `hyp attach claude` becomes the consented migration verb for existing
> base-URL installs. Named files, the compose and write seams, consent and
> back-compat rules, failure modes, and what the tests prove.

Coverage anchor:

`@ref LLP 0242: fresh installs still attached Claude by base URL and old installs had no path to proxy mode; the picker-fold gateway_proxy_mode composition, the hyp init claude literal key, and the attach-time consented migration through enableGatewayProxyMode this document designs are LLP 0242's fix`

## 0. Scope and code status {#scope}

LLP 0242 is the accepted issue; LLP 0243 (composition) and LLP 0244
(migration) are its resolution decisions. This document is the
implementation design binding them to the tree; it builds directly on the
proxy-mode capture stack designed in LLP 0245 (the `proxy-mode-capture`
change set), reusing its `waitForLocalCa` seam and the LLP 0232 attach
preflight semantics.

The design is realized on `master` by commit `04330abb` (#794). Paths and
names below are verified against that tree; the tests in section 5 exist
and gate it. This document is the request-level design of record, with the
request (LLP 0242) `@ref`'d above.

## 1. Why nothing turned the key on {#why}

LLP 0233 made `proxy_mode` explicit: only the literal config key enables
interception, never inference, upgrade, or adapter installation. The
gateway mints the CA only when the key is on, and the LLP 0232 attach
preflight picks proxy mode only when that CA exists on disk. Correct at
every link, and no link ever started the chain: neither the picker
composer, the express path, nor the `hyp init claude` preset wrote the
key, so every install landed on base-URL attach. The fix therefore has
exactly two halves: who writes the key for a fresh config (LLP 0243), and
who writes it into a config that already exists (LLP 0244).

## 2. Fresh installs: composition writes the key {#composition}

**Manifest declaration.** A picker row whose client attaches by proxy
declares it in its plugin manifest, beside the upstream it already
contributes: `hypaware-core/plugins-workspace/claude/hypaware.plugin.json`
carries `"gateway_proxy_mode": true` in its picker row's `compose` block.
The Codex row does not declare it, so a Codex-only install mints no CA it
will never use (LLP 0243 #composed-default).

**The fold.** `composePickerConfig` in `src/core/cli/walkthrough.js`
accumulates `gatewayProxyMode` across picked descriptors
(`if (compose.gateway_proxy_mode === true) gatewayProxyMode = true`) the
same way it accumulates `requires_gateway` and upstream contributions.
When set, the composed `@hypaware/ai-gateway` entry carries the explicit
`proxy_mode: true` key in the written file, preserving LLP 0233's
key-is-the-only-switch invariant: composition writes whole configs on the
user's instruction, which is not inference. Every path that rides the fold
(interactive picker, express, `hyp init --yes`) produces a proxy-mode
config by default. No `listen` is written, keeping the LLP 0114
default-only EADDRINUSE fallback.

**The literal preset.** `hyp init claude`
(`hypaware-core/plugins-workspace/claude/src/index.js`) writes its config
literally rather than through the fold, so it writes
`proxy_mode: true` literally on its gateway entry.

**The user's key wins on reconfigure.** The carry-forward merge (LLP 0183)
lets a prior gateway entry own the key entirely on the interactive
reconfigure lane, the only lane that supplies `args.existing`: a
hand-written `proxy_mode: false` survives, and so does the key's
*absence*, because a reconfigure is a picker run, not the migration verb.
Non-interactive re-init (`--yes`, presets, `--from-file`) composes from
scratch by design; it only overwrites behind an explicit `--force`, which
is the whole-file consent, and so re-applies the composed default like a
fresh install (LLP 0243 #user-key-wins).

**Finale ordering.** The walkthrough's attach lane runs against the daemon
it just started, so before attaching a proxy-mode client the finale waits
on `waitForLocalCa` (imported from `src/core/tls/ca.js` into
`walkthrough.js`); otherwise the LLP 0232 preflight would race the
gateway's first CA mint and silently produce a base-URL attach.

## 3. Existing installs: attach is the migration verb {#migration}

**The offer.** `maybeOfferProxyModeMigration({ name, ctx, parsed })` in
`src/core/commands/clients.js` runs before the gateway endpoint is
resolved, so an accepted migration restarts the daemon first and the
endpoint resolution then discovers the fresh one. It offers only when the
client's picker descriptor declares `compose.gateway_proxy_mode: true`
and the effective gateway block lacks `proxy_mode: true`. The offer is
keyed on the *config*, not the CA: a stale CA with the key off means an
earlier install was half-unwound, and the config write is still the
repair. One yes/no question, default no, names the three consequences: the
config write, the daemon restart, and the coming macOS trust dialog.
Consent here covers the config write only; the CA trust grant keeps its
own dialog (LLP 0237) and can be refused independently (LLP 0244
#attach-offers).

**Consent boundaries.** A dry run says nothing. Non-TTY, `--json`, and
`hyp attach all` never prompt and never migrate; each attaches exactly as
today and emits the one stderr line naming the interactive command that
migrates (LLP 0244 #non-interactive). When the gateway block comes from
the central layer, a local write would be dropped as a collision
(LLP 0031 merge), so attach reports that proxy mode is fleet-managed and
where to enable it, in every attach shape (LLP 0244 #central-managed).
The helper never throws into the attach: the caller downgrades any escape
to a warning, because base-URL attach is what the install already does and
remains the working fallback.

**The write.** `enableGatewayProxyMode(args)` in
`src/core/config/gateway_proxy_enable.js` reuses the LLP 0174 enable
machinery with one new write shape: it sets `proxy_mode: true` on the
*existing* local `@hypaware/ai-gateway` entry (guarded local write with
the LLP 0031 backup) rather than appending a plugin, and refuses with
outcome `no_gateway` when no layer provides one, because inventing a
gateway entry is not this verb's job. It then restarts the daemon, waits
for the bind, and waits for the CA file via the injectable `waitForCaFn`
(defaulting to `waitForLocalCa`), because attaching before the gateway
has minted the CA would silently produce another base-URL attach
(LLP 0244 #enable-write). Every step is reported; the seams
(`daemonStatus`, `restartDaemon`, `waitForBind`, `waitForCaFn`, `sleep`,
`now`) are injectable so tests never drive the real service manager
(LLP 0181). When no daemon service is installed, the write still lands
and the output says the daemon start is the remaining step.

**Idempotence.** Once the key is set the offer never appears again; the
attach proceeds straight into the LLP 0245 proxy attach.

## 4. Failure modes {#failure-modes}

- **Migration accepted but the daemon restart or bind fails**: reported
  per step; the attach continues in base-URL mode with a warning naming
  what failed. The config key is written, so the next daemon start and the
  next attach complete the switch.
- **CA never appears within `caTimeoutMs`**: same downgrade; the gateway's
  own status (`proxy_mode_error`) says why interception did not come up.
- **No gateway entry in any layer**: `no_gateway` refusal; a config with
  no gateway anywhere has a bigger problem than proxy mode.
- **Fleet-managed gateway**: no local write ever; report-only, so the
  local CLI never fights the central layer.
- **Declined default**: a hand-written `proxy_mode: false` (or its
  absence, on the interactive reconfigure lane) is permanent until the
  user acts; no path re-adds the key by inference.

## 5. What the tests prove {#tests}

Traditional (root `test/`): `test/core/init-proxy-mode-default.test.js`
(every fold-riding install path and the literal preset write the key; the
Codex-only pick does not; the carry-forward lets a prior entry own the
key), `test/core/attach-proxy-migration.test.js` (the offer appears
exactly for a proxy-capable client on a key-less config; default no;
dry-run silence; non-TTY, `--json` and `attach all` pointer lines;
central-managed report; failure downgraded to warning),
`test/core/gateway-proxy-enable.test.js` (guarded write on the existing
entry, `no_gateway` refusal, restart/bind/CA waits through injected
seams), `test/core/walkthrough-finale-ca-wait.test.js` (the finale waits
for the CA before attaching), and `test/core/walkthrough-attach-lane.test.js`
(attach lane ordering). Per the LLP 0244 consequence, everything above
runs with the `security` / `launchctl` seams refused or shimmed; hermetic
smokes (`walkthrough_picker_to_first_query`, `claude_attach_detach`) boot
gateways that mint a CA only inside the temp `HYP_HOME` and must never
reach the host keychain or launchd table.
