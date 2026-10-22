# LLP 0555: HypAware manages its Node runtime

**Type:** Decision
**Status:** Draft
**Systems:** Daemon, CLI
**Author:** Phil / Codex
**Date:** 2026-10-22
**Related:** LLP 0004, LLP 0017, LLP 0125, LLP 0309, LLP 0365, LLP 0404
**Extends:** LLP 0125, LLP 0309, LLP 0365

## Private runtime

A HypAware update may need a patched Node release before capture can run.
Requiring customers to update a version manager and reinstall a service makes
an unattended security update depend on a human. HypAware instead installs a
private runtime beneath its existing state root when its current Node is too
old. It never replaces system Node, edits shell startup files, or migrates
other globally installed tools.

The bootstrap remains compatible with Node 22.12. The application requires
the October 2026 security release for its Node line: 22.23.4, 24.22.1, or
26.12.1. An obsolete intervening major uses the patched Node 24 LTS release.
Supported download targets are macOS and glibc Linux, on x64 and arm64.
Other platforms retain an actionable manual-runtime error.

## Verified installation

Each HypAware release pins the official Node archive version and SHA-256 for
each target. Pins are taken from the release's signed checksum manifest and
verified against Node's published release signing keys before landing.
Customers need no GPG installation. The bootstrap downloads only the fixed
HTTPS nodejs.org artifact, refuses redirects, streams to disk with a byte and
time limit, verifies the pinned digest before extraction, and proves the
executable's version and patched Brotli decoder before publishing it.

A cross-process lock serializes installation. Staging is private and the
verified version is published atomically. A stable `runtime/node` symlink
selects the active runtime. Keep the active and preceding distributions for
recovery; obsolete distributions and abandoned staging are reclaimed under
the same lock. Downloads and verification do no per-record work.

## Older updaters

Existing updaters give `--version` only 30 seconds and hold a release that
fails that preflight. `--version` and `-V` therefore remain local metadata
operations on the bootstrap Node, with no runtime download. Other commands
switch to the verified runtime before loading the updater or dispatcher.
This extends LLP 0365's preflight: it proves the bootstrap can run; execution
of the application additionally proves the managed runtime.

The package engines continue to describe the bootstrap floor. npm's engine
check must allow existing customers to receive the migration. An automatic
daemon bootstrap honors the existing effective `auto_update: false` setting;
it requires explicit operator action instead of downloading a runtime.
There is no new runtime-update configuration key.

## Daemon handover

The first migration replaces only the interpreter in the existing service
definition, preserving the CLI path, config, environment, logs, and local
customizations. A detached worker performs the service-manager stop/load/start.
On Linux it first enters a separate `systemd-run --user --scope`, because
detaching a process group does not escape systemd's service control group.
The scope inherits the daemon's environment. On macOS an independent process
group suffices. This keeps stopping the old job from killing its replacement
worker ([systemd-run documentation](https://www.freedesktop.org/software/systemd/man/255/systemd-run.html)). Service-manager
calls share a 30-second budget, with a fresh budget for restoration, and the
health check allows 20 seconds. A two-minute lock ceiling covers both. It verifies a
fresh daemon heartbeat before reporting success. A failed handover restores
the original definition and attempts to start it again, recording the failure.
An attempt marker prevents that restored job from immediately spawning another
handover worker. While a handover is deferred, a bootstrap parent runs the
application as a child of the verified Node, forwarding signals and exit
status. The old interpreter handles no application or capture traffic. This
costs one temporary parent process and keeps a service-file permission failure
from forcing customers back onto the vulnerable runtime. A later service
restart can retry the handover after the two-minute cooldown.
Future installed services use the stable managed interpreter path, allowing
an atomic runtime selection followed by the existing supervised restart.

The global HypAware package stays in its original npm prefix. A managed Node
process supplies that prefix to its npm children so package self-updates do
not move into the runtime distribution or leave the live CLI stale.

No unverified executable runs and no service is stopped before runtime
verification. A failed download leaves the service definition unchanged and
reports the broken step. A machine already restarting onto the new package
may be unable to capture until its runtime download succeeds; do not claim
availability on an unpatched runtime. Persistent network, permission, or
platform failures remain visible operator actions.
