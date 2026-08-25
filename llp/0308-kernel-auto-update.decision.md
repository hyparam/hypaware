# LLP 0308: The kernel auto-updates itself through npm, unsticking from the front

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI, Config
**Author:** Kenny / Claude
**Date:** 2026-08-24
**Related:** LLP 0007 (#install-root-and-lock-file: the plugin update-check policy this shares), LLP 0008 (the npm-install invariant this does not violate), LLP 0017 (#staged-restart-for-config-replacement: the restart path an applied update takes; #install-global-package-then-service-manager: the durable global binary this updates in place), LLP 0025 (#last-known-good-rollback: the rollback pattern considered and rejected here; the bundled-pin tension a central version pin would resolve), LLP 0010 (the config model the `auto_update` key joins)

> The HypAware daemon runs unattended on fleet machines; a notify-only update
> model leaves most installs stale. This settles that the daemon updates the
> HypAware npm package itself, automatically by default, by shelling out to the
> same `npm install -g` the durable-bin installer already runs, and that
> recovery from a bad release is "publish a newer one": the check runs before
> the kernel boots, so even a crash-looping version keeps checking.

## Scope: the kernel package only

Auto-update covers the HypAware npm package: the kernel plus the bundled
first-party plugins that ship inside it. Third-party plugins keep their own
machinery (`hyp plugin update`, the silent startup checks of
[LLP 0007](./0007-plugin-install-and-locking.decision.md#install-root-and-lock-file));
nothing here touches it.

<a id="auto-by-default"></a>
## Automatic by default

The daemon applies updates on its own. A notify-only model was rejected:
HypAware's steady state is an unattended daemon on a machine nobody is
operating, so "tell the user" mostly tells no one. The off switch is the
[`auto_update` config key](#config-key); the manual path is
[`hyp update`](#cli-surface).

<a id="mechanism"></a>
## Mechanism: `npm install -g`, then the staged restart

The daemon updates by running `npm install -g <name>@<version>` through the
existing durable-bin helper (`ensureDurableBinForNpx` lineage,
`src/core/cli/global_install.js`), then exits through the staged-restart path
of [LLP 0017](./0017-daemon-runtime.decision.md#staged-restart-for-config-replacement):
the service manager relaunches it onto the new code. No new install mechanism,
no self-managed versioned root.

- This does not violate the "kernel never runs `npm install`" invariant
  ([LLP 0008](./0008-plugin-runtime-dependencies.decision.md)): that invariant
  is about plugin dependency installs. Installing HypAware's own global
  package via npm is exactly how setup already creates the durable binary the
  service unit points at.
- A self-managed install root under `~/.hyp` with a symlink flip was
  rejected: it abandons the global-package doctrine of
  [LLP 0017](./0017-daemon-runtime.decision.md#install-global-package-then-service-manager)
  and leaves the copy on the user's `PATH` stale while the daemon runs newer
  code.
- If `npm install -g` fails (an unwritable prefix, a sudo-owned npm), the
  daemon does not retry in a loop: it records the failure and degrades to a
  notice in `hyp status`. Manual repair is `npm install -g` by hand or
  `hyp update`.

<a id="global-install-only"></a>
## Only the global npm install auto-updates

A daemon running from a dev checkout or an npx cache never auto-updates:
`npm install -g` would create a second, skewed install beside the one
actually running. The guard is on the running package root's provenance,
and a skipped install does not probe the registry either: hermetic smokes
boot the daemon from the repo checkout, and the guard keeping them off the
network is what keeps them deterministic. `hyp update` still probes from
anywhere and explains why it cannot apply. Skipping is logged with its
reason, and provenance is reported under `hyp status --json`.

<a id="version-discovery"></a>
## Version discovery: npm `latest`, central pin deferred

The daemon learns of new versions by polling the npm registry for the
package's `latest` dist-tag, under the same policy as the plugin update
checks (best-effort, cached, silent). On enrolled machines a kernel update
can race the org's strict bundled-plugin pins
([LLP 0025](./0025-remote-config-join-flow.spec.md)); the clean resolution is
a central-config kernel version pin or hold, which is deferred, not designed
here. The [`auto_update` key](#config-key) living in config means the central
layer gets fleet on/off control for free in the meantime.

<a id="cadence"></a>
## Cadence: boot and daily, applied immediately

The check runs at daemon boot and then daily with jitter. On finding a newer
version the daemon installs and restarts immediately through the staged
restart; there is no quiet-hours scheduling. Restarts on config replacement
are already routine, an update restart is not a new class of interruption.

<a id="unstick-from-the-front"></a>
## No rollback: a bad release is fixed by the next release

Last-known-good rollback (the
[LLP 0025](./0025-remote-config-join-flow.spec.md#last-known-good-rollback)
pattern) was considered and rejected as too much machinery. The requirement
is narrower: a machine stuck on a broken version must update to the fix when
one publishes. Placement achieves that:

- The update check runs **first** in daemon startup, before the kernel boots,
  in a minimal module that imports nothing else. A version that crashes
  during kernel boot still reaches the check on every service-manager
  relaunch, and jumps forward the moment a fix is published.
- The check keeps a small state file: last-check time and last-seen version,
  so a crash loop does not hammer the registry. The re-check interval is
  daily normally, and one hour when the previous boot never reached healthy
  (a boot-started marker that a healthy boot clears).
- The residual risk is accepted: a release broken so early that the
  entrypoint itself cannot run defeats this. Keeping the updater import-light
  is the mitigation, not a rollback engine.

<a id="config-key"></a>
## Config: one top-level `auto_update` boolean

One new recognized top-level config key, `auto_update`, boolean, default
`true` when absent. No section and no sub-keys until the central-pin work
needs them. The daemon reads it at boot.

<a id="cli-surface"></a>
## CLI surface

- `hyp update` applies an update immediately (the manual lane; also the
  repair path when auto-update is off, degraded, or skipped by the
  [provenance guard](#global-install-only)).
- `hyp status` surfaces self-update health, and a degraded updater (a
  failed npm install, an unreachable prefix) must say so there, never only
  in logs. The text line derives only from the shared state file (off,
  degraded, update available), because the process rendering status is not
  necessarily the install doing the updating: an npx-run `hyp status` must
  not smear its own provenance over a healthy global daemon. `--json`
  carries the full picture: version, cached flag, provenance, last probe.

## @refs to add when the code lands

- The early-boot check placement and its import-light constraint:
  `@ref LLP 0308#unstick-from-the-front [implements]`.
- The provenance guard in the updater: `@ref LLP 0308#global-install-only`.
- The `auto_update` key in the schema's recognized top-level set:
  `@ref LLP 0308#config-key`.
- The staged-restart exit after a successful install:
  `@ref LLP 0017#staged-restart-for-config-replacement [constrained-by]`.
