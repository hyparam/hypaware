# LLP 0128: Install-experience overhaul, a guided wizard with join-team and local pathways

**Type:** RFC
**Status:** Accepted
**Systems:** Onboarding, CLI, Config, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-21
**Related:** LLP 0011, LLP 0025, LLP 0031, LLP 0037, LLP 0044, LLP 0058, LLP 0061, LLP 0062, LLP 0063, LLP 0100, LLP 0101, LLP 0102, LLP 0107, LLP 0114, LLP 0115, LLP 0116, LLP 0117, LLP 0129, LLP 0130, LLP 0131, LLP 0132, LLP 0133, LLP 0134

> Proposal: rework the `hyp init` first-run walkthrough into a guided wizard
> with a top-level fork ("Join a team" vs "Local install and configuration"),
> plugin-contributed picker entries, and a distinct configure phase for
> sources that need interactive setup (Claude Desktop being the forcing
> case). Feel target: a guided, narrated install in the vein of hermes or
> openclaw. This RFC proposes; on acceptance it spawns the individual
> decisions and any spec updates. It does not itself change LLP 0011.

## Summary

The first-run experience becomes:

1. **Fork.** "Join a team" or "Local install and configuration".
2. **Join (team path only).** Enroll via the login lane
   ([LLP 0063](./0063-login-auto-provision-forward-sink.decision.md)) against
   the built-in default remote
   ([LLP 0062](./0062-builtin-default-remote.decision.md)); a custom server
   URL is a later refinement. Join runs **before** the picker so central
   config exists when the local layer is composed.
3. **Pick.** A picker of capture sources, entries contributed by plugins
   rather than hardcoded. Detection pre-selects what is present
   ([LLP 0011 autodetect doctrine](./0011-setup-and-onboarding.decision.md#autodetect-vs-default)
   unchanged). Entries that need extra configuration (Claude Desktop) are
   marked as such.
4. **Configure.** A distinct phase after picking: each picked needs-setup
   entry runs its interactive configuration steps (browser OAuth, an inline
   sudo prompt, an app restart), narrated one at a time. Failure or cancel
   drops that source with a "finish later" command hint; the wizard
   continues.
5. **Privacy (team path only).** The first-sync hold and review-window
   messaging of [LLP 0100](./0100-enrollment-privacy-review.spec.md) /
   [LLP 0101](./0101-first-sync-review-window.decision.md) surface in the
   wizard's narration; the mechanism is unchanged.
6. **Finale.** The existing tail: daemon install, attach, skills and agents,
   backfill consent and run, daemon restart.

## Motivation

Three pressures, none served by the current walkthrough
(`runPickerWalkthrough`, `src/core/cli/walkthrough.js`):

- **New capture surfaces need setup steps the picker cannot express.**
  Claude Desktop attach is a managed-preferences plist plus a credential
  login plus an app restart ([LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md),
  [LLP 0116](./0116-desktop-credential-client-presented.decision.md),
  [LLP 0117](./0117-claude-account-credential-plugin.decision.md)); hermes
  capture ([LLP 0118](./0118-hermes-log-forwarding.spec.md)) has its own
  detection. Today's picker is a checkbox list over five hardcoded
  `PICKER_SOURCES` with no notion of "picking this implies steps".
- **Joining a team is invisible at first run.** Enrollment exists only as
  standalone commands (`hyp remote login`, `hyp join`); the walkthrough
  never offers it. The product story ("log in, logs flow", LLP 0063) should
  be reachable from the very first `npx hypaware`.
- **The picker set is hardcoded in core.** `PICKER_SOURCES` and
  `composePickerConfig` restate knowledge the plugin catalog already has;
  `src/core/cli/detect.js` already anticipates iterating
  `catalog.clientDescriptors[*].attach_probe` instead. Plugin-contributed
  picks were the stated design of
  [LLP 0011](./0011-setup-and-onboarding.decision.md#interactive-walkthrough)
  all along; this RFC finishes it.

## Constraints (settled elsewhere; the wizard must respect them)

- **Join before pick.** The central layer is authoritative and the local
  layer additive-only ([LLP 0031](./0031-layered-config.decision.md)). If
  the picker ran first, its composition could collide with central-pinned
  values (gateway listen port, centrally named plugins) and be dropped at
  merge. Team join seeds the central layer; the picker then composes only
  the local additive layer.
- **The team path is the login lane, not the token join.** `hyp join`
  remains the unattended MDM entry ([LLP 0025](./0025-remote-config-join-flow.spec.md#seed-config-mode));
  the wizard's "Join a team" wraps `hyp remote login`, which already
  provisions the central sink, seeds the login-minted gateway credential,
  installs the daemon, and inherits the attach cascade
  ([LLP 0063](./0063-login-auto-provision-forward-sink.decision.md), with
  [LLP 0061](./0061-login-minted-gateway-client.decision.md) and server-side
  org default config). The wizard adds narration and sequencing, not a new
  enrollment mechanism.
- **Privacy flow rides unchanged.** The first-sync hold, deadline message,
  and `hypaware-privacy` skill review
  ([LLP 0100](./0100-enrollment-privacy-review.spec.md),
  [LLP 0101](./0101-first-sync-review-window.decision.md),
  [LLP 0102](./0102-skill-replaces-enrollment-picker.decision.md)) are not a
  wizard step; the wizard surfaces the deadline and the skill hint in its
  narration. No synchronous privacy picker returns
  (LLP 0102 retired that shape permanently).
- **Desktop configuration has one surface for solo and fleet.** The
  attach surface is the local managed-settings file
  ([LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md#managed-config-not-dialog));
  solo and fleet differ only in the placer (an inline sudo prompt writing
  the managed-preferences plist locally vs an MDM push). MDM eliminates
  placement only: login, helper write, Desktop restart, and the residue
  check remain on both paths.
- **Picker doctrine survives, with one amendment.** Autodetect only
  pre-checks, never forces or hides; no architectural names; the
  returning-install gate in front of the walkthrough stays, default
  Quit-on-enter ([LLP 0011](./0011-setup-and-onboarding.decision.md)).
  Amended (grilled 2026-07-22): 0011's "managed install drops Reconfigure"
  rule predates meaningful local additions. On a managed machine the gate
  offers a scoped "adjust what this machine collects" entry: the picker
  with org rows locked and additions editable, plus configure for newly
  picked needs-setup items; no fork (the enrollment exit is `hyp leave`,
  never a wizard toggle). On a solo machine, Reconfigure re-enters the
  full wizard including the fork: "my org adopted HypAware, join now" is
  the likeliest reason a working solo install re-runs `hyp init`.
- **Local-layer write safety.** The wizard writes only the local layer,
  under the existing overwrite guard and backup
  ([LLP 0031](./0031-layered-config.decision.md#local-layer-writers)).
- **The wizard is the attended lane; unattended is MDM's** (grilled
  2026-07-22). Scripted installs stay presets / `--from-file` / `hyp join`
  ([LLP 0011](./0011-setup-and-onboarding.decision.md#non-interactive-entry),
  [LLP 0025](./0025-remote-config-join-flow.spec.md#seed-config-mode))
  and never run configure commands: needs-setup surfaces on unattended
  fleets are handled by MDM placement
  ([LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md))
  plus the per-user standalone command when a human is present;
  `--print-commands` serves the operator authoring that MDM push. The
  wizard gains no robot mode.

## Design sketch

### Top-level fork

The first question. "Join a team" leads to enrollment then the picker;
"Local install and configuration" goes straight to the picker. The fork is
presentation: both paths converge on pick, configure, finale. A machine
already enrolled skips the fork (the returning-install gate already reports
"managed by your fleet").

Default remote first: pathway 1 adds the `hypaware.hyperparam.app` built-in
target ([LLP 0062](./0062-builtin-default-remote.decision.md)) and triggers
`hyp remote login`; a choice of default vs custom URL is a follow-up, not
v1 of the wizard (grilled 2026-07-22: the follow-up's shape is a "my team
runs its own server, enter its address" prompt; the login machinery is
already server-agnostic). Self-hosted teams use `hyp remote login <name>`
by hand until then. **The token join is never a wizard step**: `hyp join
<url> <token>` stays script/MDM territory permanently; the wizard never
asks anyone to paste a token.

**The team path waits for org settings before the picker** (grilled
2026-07-22). The enrollment seed names only `@hypaware/central`; the org's
real config (pinned values, centrally named clients) arrives only after the
daemon's first pull. So the wizard narrates a bounded wait ("applying your
org's configuration...") reusing the reconcile wait `runRemoteLogin`
already performs, and only then shows the picker, which renders
central-named entries as checked and locked ("managed by your fleet",
the [LLP 0031](./0031-layered-config.decision.md#status-provenance)
provenance vocabulary). On timeout or the 404 no-org-config steady state,
the wizard says so and proceeds with an unlocked picker; nothing is pinned,
so free composition is correct, not a race.

**Local additions on a managed machine are local-only, always** (grilled
2026-07-22). On the team path, anything the user picks beyond the
central-named set is collected but never forwarded: the org sees exactly
what the org configured, and the user's additions are theirs. There is no
per-item sync toggle (rejected: it reopens the BYOD volunteer-data leak
class [LLP 0100](./0100-enrollment-privacy-review.spec.md) exists to
prevent, and it makes "what does my org see" need a table to answer); the
path to org visibility is the admin adding the source to the fleet config.
This requires new machinery: today's never-forward controls are
directory-scoped ([LLP 0069](./0069-local-only-dir-selection.spec.md) /
[LLP 0070](./0070-local-only-export-seam.decision.md)), so the export seam
must learn source/client-scoped withholding (a spawned decision). The
picker annotates additions ("stays on this machine") and `hyp status` must
show the split ("syncing: claude - local-only: codex") so it is never a
silent state.

**A failed or abandoned join returns to the fork** (grilled 2026-07-22).
Abandoning the browser flow is the decline
([LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md#d3));
nothing is provisioned at that point, so the machine is clean. The wizard
prints the failure with its explained meaning
(`no_membership` / `org_not_permitted` per LLP 0058 D7, vs a transient
network error) and re-presents the fork: the user decides whether to retry
the join, switch to the local path, or quit. The wizard never switches
pathway on the user's behalf.

### Plugin-contributed picker entries

Each source or client plugin contributes a **declarative** picker
descriptor in its manifest (grilled 2026-07-22; the manifest already
carries declarative client contributions, `contributes.client` with its
data-only `attach_probe`, so this extends
[LLP 0005](./0005-plugin-manifest.spec.md)'s model rather than adding a
code contract):

```json
"picker": {
  "label": "Claude Desktop",
  "summary": "The Claude Mac app",
  "detect": { "app_bundle": "/Applications/Claude.app" },
  "needs_setup": true,
  "configure_command": "claude-desktop install"
}
```

- `detect` is probe **data** (settings-file probes reuse `attach_probe`;
  app-bundle and path probes are new data kinds), evaluated by core to
  seed the initial checkbox state (autodetect doctrine).
- `needs_setup` marks entries whose selection implies a configure phase
  (Desktop: plist + login + restart; raw proxies: nothing).
- `configure_command` names the plugin's ordinary CLI verb; the wizard's
  configure phase runs that command in-process. The wizard and the
  standalone command are the same code, so they cannot drift; progress
  narration and resume-on-re-run belong to the command itself (rejected: a
  code contract with declared step lists, which would load plugin code
  just to render a checkbox list and duplicate what idempotent re-run
  already provides).

Core keeps composition (merging picks into a valid local-layer config) but
stops owning the list. The hardcoded `PICKER_SOURCES` become descriptors on
the plugins they describe. Claude Desktop and hermes get detection and
descriptors for the first time (Desktop: app bundle or
`~/Library/Application Support/Claude`; hermes: per LLP 0118).

### Configure phase

Runs after the picker, before the finale, only for picked `needsSetup`
entries. Steps are narrated one at a time (the hermes/openclaw feel).
Interactive requirements an entry may declare: a browser OAuth, an inline
sudo prompt, an application restart.

- **Failure or cancel is not fatal.** The entry is dropped from this run
  with a printed escape hatch ("finish later with
  `hyp claude-desktop install`"); the wizard continues with the rest.
- **Idempotent and re-runnable.** Re-running a configure step skips
  already-done work, so bailing at the sudo prompt and re-running later
  converges. A `--print-commands` mode prints the privileged commands for
  the user to run themselves (the no-sudo escape hatch).
- **Verification that needs the user acting inside the app** (Desktop:
  send a message to prove the route) is a post-wizard hint, never a
  blocking step.
- Each needs-setup surface is also a standalone command (e.g.
  `hyp claude-desktop install`); the wizard's `configure()` reuses it
  rather than owning a second implementation.

### Finale

Unchanged in substance: daemon install, attach, skills and agents install,
backfill consent (default yes) and run, daemon restart. On the team path
parts of this already happened inside the login lane (daemon install,
attach cascade); the finale detects and skips what enrollment already did
rather than redoing it. The backfill consent question is solo-path only:
an enrolled machine backfills under
[LLP 0037](./0037-backfill-on-join.decision.md) doctrine (default-on, no
local opt-out), and the privacy review window
([LLP 0100](./0100-enrollment-privacy-review.spec.md)) is the refinement
surface there, not a wizard prompt.

## Decisions spawned at acceptance (2026-07-22)

Per house rules the RFC stays an rfc; each settled choice became its own
small decision doc at acceptance:

1. [LLP 0129](./0129-init-wizard-fork.decision.md) - top-level fork,
   join-before-picker ordering, failed-join-returns-to-fork, and the
   returning-gate amendment (amends LLP 0011).
2. [LLP 0130](./0130-declarative-picker-descriptors.decision.md) - picker
   descriptors are declarative manifest contributions (the `picker` block
   + `configure_command`; extends LLP 0005).
3. [LLP 0131](./0131-configure-phase.decision.md) - configure phase
   semantics (drop-on-failure, idempotent re-run, `--print-commands`,
   post-wizard verify hints, attended-only wizard).
4. [LLP 0133](./0133-desktop-solo-sudo-plist.decision.md) - solo Desktop
   placement via inline sudo, one plist surface for solo and fleet, and
   the live-test corrections to LLP 0115 (Accepted and immutable, so the
   corrections live there as refs, not edits).
5. [LLP 0134](./0134-wizard-wraps-remote-login.decision.md) - the team
   path wraps `hyp remote login`; the token join never surfaces in the
   wizard; custom URL deferred.
6. [LLP 0132](./0132-managed-local-additions-local-only.decision.md) -
   local additions on a managed machine are local-only always, via
   source-scoped withholding at the export seam (extends LLP 0070).

## Sequencing (candidate work items)

1. **Loopback-login PR** (uncommitted in the working tree,
   `claude-account` oauth): independent of this RFC, everything Desktop
   depends on it; peel off first.
2. **Standalone `hyp claude-desktop install`** (login chain, helper write,
   residue backup and clear, plist via sudo, restart prompt, two-tier
   verify). Built once, referenced as Desktop's `configure_command`.
3. **Top-level fork and team-join flow** in the wizard.
4. **Plugin-contributed picker descriptor refactor.**
5. **Detection for Claude Desktop and hermes.**
6. **Privacy narration on the team path** (existing LLP 0100-0102 flow
   surfaced in wizard output).

## Open questions

None remaining. The draft's five original open questions were resolved in
the 2026-07-22 grilling session and folded into the design above (marked
"grilled 2026-07-22"); the spawn list is the acceptance-time work.
