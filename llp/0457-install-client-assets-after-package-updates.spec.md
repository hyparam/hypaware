# LLP 0457: Install client assets after package updates

**Type:** Spec
**Status:** Accepted
**Systems:** CLI, Daemon, Plugins, Onboarding
**Author:** Brendan / Codex
**Date:** 2026-09-30
**Extends:** LLP 0138, LLP 0309
**Supersedes:** LLP 0397, LLP 0400; LLP 0402 #migration-is-the-boot-heal only

## Request {#request}

Use the same skill and subagent installer as attach after a successful
`hyp update` or automatic package update. Remove the separate boot-time
refresh, edited-copy detection, stale-record healing, and staging machinery.
Ordinary daemon restarts and update checks that install nothing do no asset
work. Explicit `hyp skills install` and attach retain their existing behavior.

## Update installs {#update-installs}

After npm installs a new package and its entrypoint passes preflight, the
shared `applySelfUpdate` function invokes that package's `skills install`
command in a fresh process using the same Node executable. This covers manual,
pre-boot, and periodic automatic updates without loading old registries or
new modules into an old process. Preserve the environment and the updater's
selected config path. Keep the child inside the existing apply lock and bound
its duration by the existing npm command timeout.

The command uses LLP 0138's shared materializer, including its client selection
and retired-asset pruning rules. Contributed skills and agents are managed
copies: the installer replaces edits, restores deleted copies, and installs
new contributions. The ownership ledger and conservative pruning rules remain;
only the separate refresh implementation is removed.

Log installation success, warnings, and failure separately from package-update
success. The installer can warn on partial failure while exiting zero, so
retain stderr warnings too. A helper failure does not roll back a runnable
package or prevent its restart. There is no automatic retry loop; attach,
`hyp skills install`, or the next successful package upgrade can retry.
A restart-only handover or direct npm upgrade does not install helpers.

## Transition {#transition}

An older updater can install the first release of this change without running
its new helper-install step. Accept the resulting one-upgrade skill lag; the
next successful upgrade through the new updater installs the skills. No
migration flag, new state field, or temporary startup hook is required.
Direct npm installs require attach or explicit `hyp skills install` to update
helpers. Old refresh staging leftovers are not swept by ordinary startup.

## Validation and cost {#validation}

Test successful updates through manual and automatic modes, child command and
config propagation, warning and failure reporting without blocking restart,
and no helper execution for unchanged or failed package updates. Boot a daemon
with stale skills and verify it leaves those files and the ledger alone.
Exercise the shared installer against edited and deleted copies.

CPU and memory: remove per-boot asset hashing and scanning. Add one bounded
child invocation per successful upgrade, with work proportional to contributed
assets, no polling or new retained state. Retain bounded child output so verbose
plugin diagnostics cannot grow the updater's memory without limit.
