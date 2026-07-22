# LLP 0133: Solo Desktop setup writes the managed plist via an inline sudo prompt

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Onboarding, Gateway
**Author:** Phil / Claude
**Date:** 2026-07-22
**Related:** LLP 0114, LLP 0115, LLP 0116, LLP 0117, LLP 0128, LLP 0131

> Spawned by [LLP 0128](./0128-install-experience-overhaul.rfc.md) on
> acceptance. Also carries the live-test corrections to
> [LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md),
> which is Accepted and immutable; corrections land here, as new findings
> that ref it, not as edits to it.

## Decision

<a id="one-surface"></a>**One configuration surface for solo and fleet:
the managed-preferences plist.** Solo and fleet Desktop setups differ only
in the placer: an inline sudo prompt writing the file locally, vs an MDM
push. Everything else (credential login per
[LLP 0117](./0117-claude-account-credential-plugin.decision.md), helper
write per [LLP 0116](./0116-desktop-credential-client-presented.decision.md),
Desktop restart, the residue check below) is identical on both paths.

<a id="solo-sudo"></a>**The solo path prompts for sudo inline.** The
standalone `hyp claude-desktop install` (also the wizard's
`configure_command`, [LLP 0131](./0131-configure-phase.decision.md))
prompts for the password at the plist-write step. Rejected: replicating
the config through Desktop's 3P settings dialog (untested Developer Mode
gate, unknown current field names, reopens the `/v1/models` discovery
problem); considered and dropped after the dialog residue findings below.
The no-sudo escape hatch is `--print-commands`; bailing at the prompt and
re-running later converges (LLP 0131 idempotency).

## Corrections to LLP 0115 (live test, 2026-07-21)

<a id="0115-corrections"></a>Three findings from the first live solo
attach revise 0115's context claims; its decision (managed config, not
the dialog) stands, reinforced:

1. <a id="plist-surface"></a>**The effective local surface is
   `/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`.**
   Hand-placed with sudo plus `killall cfprefsd` it works with no MDM and
   no Developer Mode: 0115's two bundled pilot gates (local-layer
   exemption from the remote sanitizer; Developer Mode bypass) are
   **answered yes**. The `managed-settings.json` path 0115 described is
   the embedded Claude Code policy layer, not the Desktop 3P trigger.
2. <a id="dialog-residue"></a>**The manual dialog's config DOES persist**,
   inside the `Claude-3p` profile directory, contradicting 0115's
   "not persisted to disk at all" factory-reset finding, **and it shadows
   the managed plist**. Stale dialog residue (a dead ephemeral port, an
   old helper path) silently overrode a correct plist. Consequence: every
   install path, solo and fleet, must detect a pre-existing `Claude-3p`
   3P config, back it up, and clear it; at fleet scale an unchecked
   residue is a silent no-op per machine. Desktop must also be fully
   restarted to pick up the plist.
3. <a id="attribution"></a>**Attribution rides `entrypoint`, not the
   User-Agent.** Desktop delegates inference to its embedded CLI, so rows
   land `client_name: "claude"` with `entrypoint: "claude-desktop-3p"`;
   0115's `Claude-Desktop/<version>` UA stamping path never fires. Query
   Desktop activity by entrypoint; the UA-stamping projector branch is
   dead code for this route.

## Consequences

- `hyp claude-desktop install` is the single implementation: login chain,
  helper write, residue backup and clear, plist write via sudo, restart
  prompt, and a two-tier verify whose in-app half is a post-wizard hint
  (LLP 0131).
- The fleet path inherits the residue check and restart handling; MDM
  replaces only the plist-write step.
- A fleet config pinning an ephemeral listen (`127.0.0.1:0`) remains
  incompatible ([LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md#stable-endpoint-prerequisite),
  [LLP 0114](./0114-gateway-default-listen-port-fixed.decision.md)); the
  renderer keeps refusing it.
