# LLP 0380: an installed copy of a bundled name yields to the bundled copy

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, CLI, Daemon
**Author:** Phil / Claude
**Date:** 2026-09-04
**Related:** LLP 0031 (#central-layer-is-sacrosanct: the same posture, a stale local artifact never takes the daemon down), LLP 0041 (#failure-is-surfaced-not-fatal: the status posture this borrows), LLP 0349 (#bounded-reads: why a daemon that restarts into the same error is a memory hazard, since `daemon.log` never rotates), LLP 0360 (the GitHub source is bundled; a pre-bundling install is the motivating shadow), LLP 0219 (#incomplete-activation-prunes-nothing: `unavailablePlugins` is untouched by this, a shadow is not an activation shortfall)

> Boot rejected any installed plugin whose name a bundled first-party plugin
> owns, with an error telling the operator to run `hyp plugin remove`. The
> reject was the hazard: dispatch boots before every command, that one
> included, so nothing the error named could run, and a supervised daemon
> respawned into the same throw every few seconds, appending to a log that
> never rotates. The bundled copy now activates, the installed shadow is
> skipped and reported, and no command or daemon fails because of it.

## Context {#context}

`detectShadowedPlugins` (`src/core/runtime/boot.js`) finds installed
plugins whose manifest name collides with a bundled first-party plugin.
Until this branch it compared against the allowlisted bundled bucket only,
so an installed copy of a V1-excluded bundled plugin (`@hypaware/github`,
bundled in v1.31.0 by LLP 0360, and previously distributed as an installable
plugin) activated silently in place of the bundled code. That is fixed
upstream of this decision: both bundled buckets now count.

What the fix exposed is the policy behind the guard. The guard threw
`installed_shadows_bundled` out of `bootKernel`, with a message naming
`hyp plugin remove <name>` as the repair. Two facts make that unworkable
once the shadow is one real machines have:

- **Dispatch boots before every command.** `hyp status`, `hyp plugin list`
  and `hyp plugin remove` all reach `bootKernel` first and all threw. The
  documented repair could not run; the actual repair was deleting the plugin
  directory and editing `plugin-lock.json` by hand.
- **The daemon is supervised.** `runDaemon` rethrows a boot failure, and the
  LaunchAgent (`KeepAlive`) and systemd unit (`Restart=always`, 5s) respawn
  it. Each attempt discovers every manifest, opens the log, writes and clears
  the pid file, and throws again. A bounded but permanent CPU cost, and a
  `daemon.log` plus supervisor stderr that grow by an error record and a
  stack per attempt, forever, on a file nothing rotates (LLP 0349).

The comment above the guard said the override policy was "intentionally
deferred". This settles it for the one case that matters, an installed copy
of a name the package ships.

Four shapes were considered:

- **Keep the reject, exempt the repair commands and keep the daemon up
  degraded.** Rejected: two more special cases (which commands may boot past
  a rejected boot, and a daemon state that is neither booted nor exited), for
  a policy whose only remaining purpose would be to make the operator act.
- **Refuse the install instead.** Useful, but it does not reach the shadows
  that already exist on disk, which are the ones this is about.
- **Let the installed copy win.** Rejected: that is the original bug. A
  first-party plugin's contract with the kernel (datasets, capabilities,
  client descriptors) evolves with the package, and an older copy running
  under a newer kernel is exactly the release skew bundling exists to end.
- **Let the bundled copy win, warn, and surface the idle copy.** Chosen.

## Decision {#decision}

<a id="bundled-copy-wins"></a>**The bundled copy activates; the installed
shadow is dropped from selection and never runs.** `selectBootPlugins`
removes shadowed manifests from the boot pool and from `installedNames`, so
every profile sees the bundled plugin as bundled (the `all-bundled` and
`all-available` profiles used to drop the name as "installed", and
`all-available` used to select the installed copy). `bootKernel` logs one
`plugin.shadow_collision` warning per name per boot, with the repair command
in the record, and continues. Help, the seam-command activator and the
inactive-plugin suggestion read the same selection, so they advertise and
dispatch the bundled copy's commands.

<a id="surfaced-not-fatal"></a>**The shadow is a repairable warning, never an
outage.** `hyp status` raises `installed_plugin_shadowed` (severity
`warning`) for each shadowed name with `hyp plugin remove <name>` as the
repair, and `hyp plugin list` labels the running copy by the root directory
it runs from (bundled) and marks the idle lock entry as shadowed. The
machine is running the right code, so nothing degrades `overall`, and every
command runs, the repair included.

<a id="no-override"></a>**There is no override.** An operator who wants to
run a modified first-party plugin does so under another name. The kernel
does not arbitrate between two implementations of one first-party contract,
and a flag to prefer the installed copy would reopen the skew that bundling
closed.

## Consequences {#consequences}

- A host with a pre-bundling `@hypaware/github` install upgrades cleanly:
  the bundled source runs, `hyp status` says the installed copy is idle and
  how to remove it, and the daemon never enters the restart loop.
- `installed_shadows_bundled` is no longer thrown anywhere. `hypErrorKind`
  consumers that matched on it match nothing.
- The `hyp plugin list --json` entry for a shadowed name reports the bundled
  `version` and `source` and carries `shadowed: true`; the lock's
  `installed_at` and `update` fields still ride on it.
- `hyp plugin install` still accepts a bundled name. Refusing it at install
  time is a sensible follow-up; it is not part of this decision.
