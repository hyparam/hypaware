# LLP 0115: Claude Desktop attaches via org-managed 3P-inference config

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Gateway, Onboarding
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0016, LLP 0044, LLP 0045, LLP 0061, LLP 0086, LLP 0114, LLP 0116, LLP 0117

> Claude Desktop (macOS) has a hidden third-party-inference surface that can
> point the app at a local gateway: Help -> "Enable Developer Mode" unlocks a
> "Configure Third-Party Inference..." dialog with a gateway URL, credential
> kind (static key / interactive sign-in / helper script), auth scheme, and a
> manual model list. Routing Desktop -> HypAware gateway -> Anthropic was
> proven working end to end. This decision records which of Desktop's two
> configuration channels HypAware builds on: the org-managed (MDM) managed
> config, not the manual dialog.

## Context

The LLP 0044/0045 attach model edits a client's plain settings file
(`.claude/settings.json`, `.codex/config.toml`) with a self-describing marker
for reversal. Desktop has no such file to edit:

1. The 3P-inference config set through the dialog is safeStorage-encrypted
   and, as confirmed by a factory-reset test (2026-07-20), **not persisted to
   disk at all**: after an app restart no `inference*` key exists anywhere in
   the app's state. There is nothing for `hyp attach` to write or reverse.
2. Developer Mode itself is a warning-gated runtime toggle that does not
   survive restart. Any flow that depends on it is unreliable by
   construction.
3. Pre-LLP 0114, the gateway's endpoint moved on every daemon restart and
   only the LLP 0086 machinery kept settings-file clients current. Desktop's
   config cannot be rewritten on restart, so it silently breaks the moment
   the port moves. A Desktop attach needs a stable endpoint.

Desktop is, however, built to be configured centrally: the app bundle carries
an org-scoped managed-settings channel
(`desktop_ccd_remote_managed_settings_fetch`, keyed by organization id) and a
managed-config (MDM) enforcement layer that serves the 3P-inference keys
"admin-enforced and non-user-reversible". That channel needs no Developer
Mode, no dialog, and no per-machine hand configuration.

## Options

1. **Automate the manual dialog** - drive Developer Mode and the 3P dialog
   per machine. Dead end: the toggle is non-persistent, the config
   evaporates on restart, and there is no disk surface to automate against.
2. **Settings-file attach like the CLI and Codex** - impossible; there is no
   plain settings file (see Context).
3. **Org-managed (MDM) managed config** - HypAware renders the managed
   3P-inference payload and an org pushes it through device management. The
   config is admin-enforced, non-user-reversible, and zero-touch for the
   user.

## Decision

<a id="managed-config-not-dialog"></a>**Option 3.** The Desktop attach
surface is the org-managed 3P-inference config. The `@hypaware/claude-desktop`
plugin renders the managed payload; distribution is the org's MDM (the
deferred device-enrollment lane of LLP 0061/0063). The manual dialog remains
a personal-machine debugging aid, never the product path.

<a id="no-attach-on-join"></a>**Desktop is not an attach-on-join client.**
The plugin registers no `contributes.client` with an `attach_probe`: the
LLP 0044 loop requires a reversible settings-file write that Desktop cannot
offer. Instead the plugin exposes explicit commands to render and inspect the
managed profile.

<a id="stable-endpoint-prerequisite"></a>**The profile points at the fixed
default endpoint.** The rendered payload sets `inferenceProvider=gateway` and
the gateway URL to the effective listen address, which on a default install
is the LLP 0114 fixed `127.0.0.1:18521`. Fleets that configure an explicit
`listen` render that address instead. A fleet config that still pins
`127.0.0.1:0` is incompatible with a Desktop profile and must move to the
fixed default first (plain HTTP is acceptable: Desktop allows non-TLS
loopback URLs).

<a id="manual-model-list"></a>**The profile carries a manual model list.**
Desktop probes `GET /v1/models` to discover models; a subscription OAuth
token is not scoped for that listing and the probe 401s, wedging setup. A
manual model list skips the probe entirely, so the profile always names its
models (default: the fleet-served set, overridable per fleet).

## Consequences

- HypAware still lacks the push half: rendering produces an artifact, and
  an MDM (or the LLP 0061/0063 enrollment lane, when built) must deliver
  it. That gap is deliberate scope, not an oversight.
- The credential placed in the profile is decided by LLP 0116 (client-side
  helper presentation; the profile itself carries no secret) and provisioned
  per LLP 0117 (org key vs subscription, a fleet-policy switch).
- Open question: whether an MDM-pushed managed config bypasses Developer
  Mode entirely (zero-touch) is strongly implied by the app bundle's
  enforcement layer but has not been hard-confirmed against a real MDM
  push. The first fleet pilot should verify it.
- Prerequisite tracked elsewhere: the fleet config template's
  `listen: 127.0.0.1:0` pin must move to the LLP 0114 fixed default so
  pushed profiles have a stable target. That change rides the consistent-
  port work stream, not this change set; the renderer defends itself by
  refusing to render a profile against an ephemeral (`:0`) listen.
