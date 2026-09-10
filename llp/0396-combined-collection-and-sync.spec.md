# LLP 0396: Combined collection and sync selection

**Type:** Spec
**Status:** Draft
**Systems:** Onboarding, CLI, Usage-Policy
**Date:** 2026-09-09
**Related:** LLP 0188, LLP 0190, LLP 0201, LLP 0338

## Combined selection {#combined-selection}

On enrolled interactive setup, ask once what to collect and sync. Checked
sources are both collected locally and shared remotely. Confirming the picker
or the express record-and-sync choice schedules existing client opt-outs for
its visible selected sources to be cleared when setup commits. Unselected and
hidden source policies remain intact;
fleet sources remain locked. Local unenrolled setup keeps its collection-only
choice. Scripted setup keeps its existing behavior.

The former sync step becomes an application of this answer, without a prompt
or a progress position. Folder handling follows the combined picker, and Back
returns to that picker. Existing directory policies and first-sync holds still
apply. An unreadable client policy store is preserved and exports fail closed
with a warning, as before, and no screen on that run claims sharing it cannot
enable. The standing privacy CLI remains available.

The policy write is deferred until the config commit succeeds, after the
folder question and overwrite confirmation. Cancel, overwrite refusal, config
write failure, and Back before that point leave standing client opt-outs intact.
Only the final selection is applied. The commit re-reads the policy store to
preserve unrelated changes made while setup was open; an unreadable store or a
failed policy write stops setup without clearing it. The config can already
have landed at that point, so this is ordered saving, not an atomic transaction
across both files. Revocation narration and its commit telemetry are emitted
only after a successful policy write.

This extends LLP 0188#never-silent and LLP 0190#sync-gate by moving sharing
consent into the collection choice, LLP 0201#gate by making express acceptance
apply that same choice, and LLP 0338#counts-anyway by retiring the sync lane
from the itinerary. The work is bounded by the picker and policy entry counts,
with no new runtime dependencies, schema fields, or background work.
