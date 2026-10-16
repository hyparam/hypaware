# LLP 0458: Update skills only for attached clients

**Type:** Spec
**Status:** Accepted
**Systems:** CLI, Daemon, Plugins, Onboarding
**Author:** Brendan / Codex
**Date:** 2026-09-30
**Extends:** LLP 0457 #update-installs
**Related:** LLP 0138, LLP 0045

## Request {#request}

PR #2398's unqualified post-update `skills install` writes assets for clients
whose adapters are enabled but which were never attached. It also recreates
assets removed by detach, since detach leaves the adapter enabled. Restrict
package-update installation to clients currently attached. Keep the shared
installer, not the retired per-asset refresh machinery.

## Attached only {#attached-only}

The updater invokes the new package's `skills install --attached`. The installer
uses the existing `probeAttachedClients` settings-marker probe to select its
client list before calling the same materializer as attach. A configured plugin,
an asset ledger record, or an old org action marker is not attachment evidence.
Missing, unreadable, or malformed settings and clients without an attach probe
are excluded. No full status collection, transcript scan, network probe, or
new attachment state is introduced.

With no attached clients, return a no-op before copying or reconciling assets.
When `--client` is also supplied, intersect it with the attached set. Bare
`skills install` and explicit `--client` without `--attached` keep their existing
manual installation behavior. Attached clients still receive replacements for
edited or deleted managed copies, following LLP 0457.

One installer child handles the selected list. This is equivalent to scoped
installation for each client while avoiding repeated CLI boots and a timeout
budget multiplied by client count. The existing updater lock and timeout still
cover the whole operation. Probe and install are not a transaction against a
concurrent detach; detach completed before the probe is respected.

A client in a capture mode that has no settings attach marker is skipped even
if its adapter is enabled. It can still use explicit `skills install`; enabled
capture configuration must not become a fallback that widens unattended writes.

## Validation and cost {#validation}

Test clean homes and stale ledger/action records, attached versus never-attached
clients, malformed settings, explicit client filtering, and real detach followed
by another update-mode install. Verify both manual and automatic updater paths
pass `--attached`. Preserve manual unscoped installation coverage.

CPU and memory review: one settings read per probe-capable client in one bounded
child per successful upgrade. Reuse the descriptor catalog the installer already
loads; no polling, per-record work, transcript reads, or growing background state.
