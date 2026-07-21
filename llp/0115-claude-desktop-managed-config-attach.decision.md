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

Desktop is, however, built to be configured centrally, and it has **two
distinct managed-config channels** that the design must not conflate (this
distinction was verified by reading the app bundle's config schema, v1.x):

1. **Remote org-fetch** - a server-pushed managed settings bundle
   (`desktop_ccd_remote_managed_settings_fetch`, the "synthetic bootstrap",
   keyed by organization id). Delivered over the network at runtime.
2. **Local MDM-deployed file** - a `managed-settings.json` (and
   `managed-settings.d/` drop-in dir) placed on the endpoint by device
   management (the app's `parentManaged` config layer). A local file, admin-
   enforced and non-user-reversible.

The remote channel runs a "Bootstrap intake" sanitizer that enforces a
per-key `remotePolicy`, and **both keys this design needs are gated there**:

- `inferenceCredentialHelper` carries `remotePolicy: remote-disabled`, so a
  remote push drops it outright.
- `inferenceGatewayBaseUrl` carries `remotePolicy: { rejectLoopback: true,
  originPinned: true }`, so a remote push drops our `http://127.0.0.1:18521`
  as a loopback / non-HTTPS URL and pins the value to a trusted origin.

A loopback gateway plus a credential helper is exactly what the remote
channel refuses. Only the **local MDM-deployed file** can carry them.

## Options

1. **Automate the manual dialog** - drive Developer Mode and the 3P dialog
   per machine. Dead end: the toggle is non-persistent, the config
   evaporates on restart, and there is no disk surface to automate against.
2. **Settings-file attach like the CLI and Codex** - impossible; there is no
   user-writable plain settings file (see Context).
3. **Remote org-fetch managed config** - ruled out by the two `remotePolicy`
   gates above: the loopback gateway URL and the helper are both stripped.
4. **Local MDM-deployed managed-settings file** - HypAware renders the
   managed 3P-inference payload; device management writes it to the endpoint
   as `managed-settings.json`. Admin-enforced, non-user-reversible, and not
   subject to the remote channel's `remotePolicy` sanitizer.

## Decision

<a id="managed-config-not-dialog"></a>**Option 4.** The Desktop attach
surface is the **local MDM-deployed `managed-settings.json` file**, not the
manual dialog and not the remote org-fetch channel. The
`@hypaware/claude-desktop` plugin renders the managed payload; distribution
is the org's device management writing that file to the endpoint (the
deferred device-enrollment lane of LLP 0061/0063). The manual dialog remains
a personal-machine debugging aid, never the product path.

<a id="remote-channel-ruled-out"></a>**The remote org-fetch channel is
explicitly out.** Its `remotePolicy` sanitizer strips both a loopback
`inferenceGatewayBaseUrl` and the `remote-disabled` `inferenceCredentialHelper`.
Rendering targets the local file, whose values the remote sanitizer does not
touch. **Pilot gate (the one load-bearing assumption):** that the local
`managed-settings.json` is genuinely exempt from `rejectLoopback` /
`remote-disabled` is the overwhelmingly likely reading (the policies are named
for and applied by the *remote* "Bootstrap intake"), but it has not been
confirmed against a live MDM push. If the local file turns out to be
sanitized too, a loopback gateway is impossible and the design forks to a
non-loopback gateway bind - a much larger change. The first fleet pilot must
verify this before anything else.

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
manual model list (`inferenceModels`) skips the probe entirely, so the
profile always names its models (default: the fleet-served set, overridable
per fleet).

<a id="real-profile-keys"></a>**The rendered keys are the app's own
schema.** Verified against the bundle: `inferenceProvider: "gateway"`,
`inferenceGatewayBaseUrl`, `inferenceGatewayAuthScheme` (`"bearer"` |
`"x-api-key"`, default `"bearer"`), `inferenceModels` (string array),
`inferenceCredentialKind: "helper-script"` (the enum is
`static | helper-script | interactive | vendor-profile | oauth | workforce`;
the org-key path is still `helper-script` here so the profile stays
secret-free, LLP 0116), and `inferenceCredentialHelper` - a single string
that is an **absolute path to an executable run with no arguments** (see
LLP 0116 for why that forces a generated wrapper).

<a id="desktop-rows-are-distinguishable"></a>**Desktop traffic is attributed
to its own client.** Desktop's requests are Anthropic-shaped `/v1/messages`
calls, so the `@hypaware/claude` exchange projector matches them; without
intervention they would land as `client_name: "claude"` and pollute per-
client analytics (the usage reports and activity graph pivot on
`client_name`). Desktop sends a distinct User-Agent, `Claude-Desktop/<version>`
(confirmed in the bundle), so the projector stamps `client_name:
"claude-desktop"` and the matching `client_version` off that UA. Everything
else about the projection is unchanged; Desktop rows carry no session-context
enrichment (no hook writes `cwd`/`git_branch`), which is expected.

## Consequences

- HypAware still lacks the push half: rendering produces an artifact, and
  an MDM (or the LLP 0061/0063 enrollment lane, when built) must deliver
  it. That gap is deliberate scope, not an oversight.
- The credential placed in the profile is decided by LLP 0116 (client-side
  helper presentation; the profile itself carries no secret) and provisioned
  per LLP 0117 (org key vs subscription, a fleet-policy switch).
- Open question: whether writing the local `managed-settings.json` bypasses
  Developer Mode entirely (zero-touch) is strongly implied by the app
  bundle's `parentManaged` enforcement layer but has not been hard-confirmed
  against a real MDM push. Bundled together with the `rejectLoopback`
  exemption above, this is the single pilot gate for the whole design.
- Prerequisite tracked elsewhere: the fleet config template's
  `listen: 127.0.0.1:0` pin must move to the LLP 0114 fixed default so
  pushed profiles have a stable target. That change rides the consistent-
  port work stream, not this change set; the renderer defends itself by
  refusing to render a profile against an ephemeral (`:0`) listen.
