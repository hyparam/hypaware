# LLP 0450: Launch report generation in the current directory

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports, Plugins
**Author:** Brendan / Codex
**Date:** 2026-09-29
**Extends:** LLP 0436, LLP 0393
**Related:** LLP 0414, LLP 0448 (unmerged proposal replaced by this narrower scope)
**Extended-by:** LLP 0451 (retire the local report render command; keep the shared renderer)
**Extended-by:** LLP 0465 (finished reports move into `$HYP_HOME/reports` through `hyp report save`; `list` gains a saved section)

## Launch the skill {#launch}

`hyp report generate [instructions]` starts an attached, launchable AI client
with its installed `hypaware-report` skill. Reuse the existing discovery and
launch machinery, terminal client picker, and normal client permissions.
Optional quoted instructions are passed verbatim. Without them the skill's
previous-calendar-month default applies. No server credential is needed.

Start in the caller's `cwd` and preserve the environment, including relative
`HYP_HOME`. The CLI creates no workspace and changes no recording policy.
Direct skill invocation and CLI generation both write a dated report folder
under the current directory, unless the user requests another destination.
The skill adds numbered suffixes rather than overwriting earlier reports.

This replaces the proposed centrally managed workspace in PR #2263. It avoids
silently relocating a session from the user's chosen directory into an
unmarked `$HYP_HOME/reports` directory. It does not introduce session isolation:
the generating conversation remains subject to the current directory's normal
recording and sync policy, including any excerpts it reads from local history.
Because that consequence is surprising, the command's own help and
`docs/PRIVACY.md` state it where a person reads them, not only here.

Listing, publishing, rendering, and recording policies remain unchanged.
Publication is still an explicitly requested action. The command reports launch
success, not proof that the agent completed the report.

## Validation and cost {#validation}

Tests cover exact instruction transport, cwd and environment preservation,
client eligibility and selection, cancellation, invalid arguments, and launch
failure. The operational span records client, candidate count, status, and
failure category, never instructions. Add only `report generate` to LLP 0393's
finite command vocabulary; no new telemetry field is introduced.

CPU and memory review: one skill existence probe per available client and a
prompt proportional to the instructions. No transcript scanning, directory
inventory, polling, or retained background state is added by the launcher.
