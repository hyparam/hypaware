# LLP 0453: Warn about unresolved export failures, retain recovered history

**Type:** Spec
**Status:** Draft
**Systems:** Daemon, CLI
**Author:** Brendan / Codex
**Date:** 2026-09-29
**Extended-by:** LLP 0471 (preserves the warning rule with completion-based recovery and finite diagnostic history)

<!-- @ref LLP 0349#decision [extends]: historical export errors are not evidence that delivery still needs attention -->

## Warning rule {#warning-rule}

For each configured sink destination, warn while it holds a failed export
attempt that no later successful export has answered. One unresolved failure
is sufficient. A success clears only failures recorded strictly before it, and
only for its own destination: success elsewhere clears nothing.

Recovery is the only thing that clears a warning. Waiting is not recovery, so
the 24-hour window does not bound this decision: an unresolved failure older
than the window still warns. The window keeps every other job it had, the
`recent_error_count` history among them.

A destination with no records at all does not warn. A destination outside the
operator's configured sink set does not warn either, however the removal was
spelled: deleting the whole `sinks` key, emptying it, or replacing the set
without that entry. Its files are still history, but this install no longer
has that destination to repair, even when `sinks[]` still lists it, recovered
only from the prior daemon's status file for shape. A config layer the host
could not read, local or central, is not a removal: the destination stays
configured and still warns. Neither is a `sinks` entry the central layer's
merge dropped, when that drop is why no configured sink set is left and the
destination's row survives only in the prior daemon's status file. Since
nothing clears a warning but a success, a destination that stays configured
and is never exercised again would warn until it is removed or succeeds;
that is the accepted cost of the rule and no escape hatch is added for it.

Use the existing outbox filename timestamps and the already-loaded daemon
snapshot's `lastSuccessAt`. Config-derived sink rows omit that runtime stamp.
Historical success remains valid after daemon exit; it does not prove
liveness. The daemon carries the stamp across its own restarts by reading the
sink rows of the `status.json` its boot is about to overwrite, and carries
`lastSuccessAt` only: `lastTickAt` is what says this daemon has ticked. A boot
that cannot read that file starts with no stamps rather than failing.

Missing or invalid success stamps provide no recovery evidence. Stamps in the
future are evidence about nothing and are ignored for this decision on both
sides, the failure as well as the success, so a clock that ran ahead cannot
invent a warning and a clock that was set back cannot clear one. Equal stamps
are a tie, and a tie warns: at the same millisecond nothing in the record says
which came first, and the conservative reading is the one that keeps looking.

The message states how many attempts are unanswered, the age of the last
failure, and that no later success was recorded, rather than claiming a fresh
probe failed. Suggest inspecting connectivity and failure records, not
restarting the daemon for a remote error.

The JSON `recent_error_count` retains its existing historical meaning and
counting rules, window included. Verbose text labels it as history including
recovered failures. Other daemon and dev telemetry errors keep their existing
warning behavior. Dev telemetry's duplicate `sink.export_batch.failed` entries
remain in history but cannot bypass the export warning filter.

Frequent failures interrupted by successful exports are outside this change:
an accurate failure rate requires success history the current snapshot lacks.

## Cost and validation {#validation}

Reuse the existing directory listings and bounded log tails. Accumulate the
history count and the unresolved-failure count in one pass over each listing,
without sorting and without opening an outbox file. Additional memory is
proportional to destination count, not failure count.

No new persisted state, no new config key, no network probes, no dependencies
and no background timers. The recovered stamp extends the sink rows
`status.json` already carries.

Tests cover an unresolved failure with no success at all, one that has aged
past the window, recovery by a strictly later success, failures recorded after
a success, equal and future and unparseable stamps, a configured destination
with no records, an unconfigured destination with records, independent
destinations, retained historical counts, and duplicate dev telemetry.
Separate tests cover what a boot recovers from the status file, what it
declines to recover, and that an unreadable file costs stamps rather than the
boot. Existing tests retain coverage of bounded reads and unrelated errors.
