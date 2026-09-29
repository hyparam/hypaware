# LLP 0448: Generate reports locally and render on the server

**Type:** RFC
**Status:** Draft
**Systems:** CLI, Reports, Plugins
**Author:** Brendan / Codex
**Date:** 2026-09-28
**Extends:** LLP 0436, LLP 0393, LLP 0155
**Related:** LLP 0198, LLP 0398, LLP 0414

## Request {#launch}

Expose the local report skill restored by
[LLP 0436](./0436-publish-markdown-report-sources.decision.md#skill) as
`hyp report generate [instructions]`. The optional quoted text is passed
verbatim to the agent as user instructions, so dates and analytical focus
remain the skill's responsibility rather than a second CLI reporting schema.

Reuse the attached-client discovery and terminal-inheriting launch used by
`hyp ask` and `hyp report fix`. Offer only launchable clients with an installed
`hypaware-report/SKILL.md`, naming that file in the prompt. Multiple eligible
clients produce a terminal picker; without interactive input use the first.
Cancellation starts nothing. Missing clients, directory creation failures,
and spawn failures identify the failed step. The client retains its normal
permissions; command success means it launched, not that a report completed.

Like the recommendation ask in LLP 0398, report generation belongs to no
repository. Start in `$HYP_HOME/reports`, defaulting to `~/.hyp/reports`, and
let the skill write `hypaware-report-<from>-to-<to>/` with numbered suffixes
for existing directories. The CLI creates only the reports parent. It does
not resolve remote credentials, query recordings, render, or publish.

## Retire local rendering {#server-rendering}

Remove `hyp report render` from the CLI, including its argument schema,
handler, help, and product-telemetry command vocabulary. This replaces
LLP 0436's decision to retain that standalone preview command: publishing
Markdown already renders it on the server.

Keep the `hypaware/core/reports` package export, `src/core/reports/` renderer,
types, assets, and tests. HypAware Server's `src/reports/render-tree.js`
imports `renderReports` from that export and calls it to build published
reports. Removing the CLI entry point does not change that library contract
or the server's rendering behavior.

## List local and published reports together {#local-list}

`hyp report list` shows separate published and local sections. Discover immediate
non-hidden directories under `$HYP_HOME/reports` containing a regular `report.md`;
do not follow symlinks or read report contents. Keep the newest 100 by the brief's
mtime and disclose truncation. Remote filters retain their existing meaning.
`--local` lists without a remote read and cannot combine with remote
selection or filters. A failed implicit remote read still lists available local
reports with a stderr warning; explicit remote selection or filters retain the
remote failure exit code. With no local rows, remote failures behave as before.

After a successful publish of a managed folder (or its `report.md`), atomically
save a small receipt outside the uploaded directory, in `reports/.publications/`.
The filename hashes the canonical local folder, reports endpoint, and org. The
receipt contains the endpoint and the server's existing org/kind/period/id fields.
One slot holds the most recent publication for that source and destination.
It contains neither credentials nor report contents. Receipt failure is a
warning after publication, never a failed upload or an invitation to retry it.

Join a local folder to a remote row only when that receipt's full identity appears
in the current remote result page. Print its path beneath that row, omitting the
separate local row. A deleted, filtered-out, inaccessible, or older publication
does not hide the local folder. A local copy may have been edited since publishing;
the link denotes provenance, not content equality. Different reports with the same
title or dates are never inferred to match. Publications made before receipts
exist remain separate until republished. Moving a folder loses its association.

JSON stays an array: remote records retain their fields, with `localPaths` for
linked folders; unmatched local rows have `source: local`, `path`, and `modifiedAt`.
The path list is derived locally, not trusted from the remote response.

Local discovery streams directory entries and retains at most 100 rows. Receipt
reads are capped at 16 KiB and only probe the orgs in the returned remote page.
No Markdown hashing, repacking, recursive walk, or additional remote request is
needed for listing. CPU is linear in directory count with a fixed-size newest
set; matching costs at most 100 times the number of returned orgs.

## Local report actions {#local-actions}

On a terminal, list offers a picker for its separately listed local reports.
Selecting a report opens an action screen showing the remote, organization
selector if any, kind, and period. Publish invokes the existing publish handler
only after the user chooses that action. Edit details uses the existing TUI text
and select prompts. Back returns to the report list; cancellation uploads nothing.
The reporting period defaults from the generated directory's encoded date range,
never the current date. An unrecognized folder name needs an explicit period.
A cross-org `*` listing needs one organization chosen before publishing.

The `--local` flag skips the remote listing, not a subsequent explicit Publish
action. JSON, piped streams, and `HYP_NO_TUI=1` stay noninteractive. A publication
failure returns its normal exit code and is never automatically retried. The
picker uses the existing bounded local inventory; no extra filesystem scan,
background loop, or network request occurs until Publish is chosen.

## Validation and cost {#validation}

Tests cover the local launch, exact instruction transport, default and
overridden report roots, client eligibility and selection, cancellation,
argument errors, directory failure, and spawn failure without starting a real
agent. A `report.generate` span records the client, eligible-client count,
status, and failure category, never the prompt or instructions.
Add `report generate` to LLP 0393's finite product-telemetry command vocabulary;
no instruction text or other field is added to that channel.
Verify that the retired command is absent while the renderer package export
remains callable. Removing the CLI wrapper adds no CPU or memory work to the
shared rendering path.

CPU and memory work scale with the small client descriptor list and instruction
length. One skill existence probe per launchable client and one parent-directory
creation add no transcript reads, recursive scans, polling, or retained state.
