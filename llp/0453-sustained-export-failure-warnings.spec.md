# LLP 0453: Warn about sustained export failures, retain recovered history

**Type:** Spec
**Status:** Draft
**Systems:** Daemon, CLI
**Author:** Brendan / Codex
**Date:** 2026-09-29

<!-- @ref LLP 0349#decision [extends]: historical export errors are not evidence that delivery still needs attention -->

## Warning rule {#warning-rule}

For each configured sink destination, warn only when at least three failed
export attempts in the existing 24-hour window occurred after its last recorded
successful export, with at least ten minutes between the first and last failure.
A later success clears that destination's warning. Short retry bursts cannot
become sustained failures merely by aging. Success at another destination does
not clear the warning. Removed destinations retain history but do not warn.

Use the existing outbox filename timestamps and the already-loaded daemon
snapshot's `lastSuccessAt`. Config-derived sink rows omit that runtime stamp.
Historical success remains valid after daemon exit; it does not prove liveness.
Missing or invalid success stamps provide no recovery evidence. Ignore future
timestamps when deciding warnings. The message states the age of the last
failure and that no later success was recorded, rather than claiming a fresh
probe failed. Suggest inspecting connectivity and failure records, not restarting
the daemon for a remote error.

The JSON `recent_error_count` retains its existing historical meaning and
counting rules. Verbose text labels it as history including recovered failures.
Other daemon and dev telemetry errors keep their existing warning behavior.
Dev telemetry's duplicate `sink.export_batch.failed` entries remain in history
but cannot bypass the export warning filter.

Frequent failures interrupted by successful exports are outside this change:
an accurate failure rate requires success history the current snapshot lacks.

## Cost and validation {#validation}

Reuse the existing directory listings and bounded log tails. Aggregate counts
and timestamp extrema in one pass without sorting or opening outbox files.
Additional memory is proportional to destination count, not failure count.
No new persisted state, network probes, dependencies, or background timers.

Tests cover the count and duration thresholds, recovery, independent
destinations, invalid stamps, retained historical counts, and duplicate dev
telemetry. Existing tests retain coverage of bounded reads and unrelated errors.
