# LLP 0455: Compact status puts client sharing and attention first

**Type:** Spec
**Status:** Draft
**Systems:** CLI
**Author:** Brendan / Codex
**Date:** 2026-09-29
**Related:** LLP 0009, LLP 0188, LLP 0200, LLP 0257, LLP 0330, LLP 0385

<!-- @ref LLP 0009#central-help-interception [extends]: add the verbose option to status registration and parsing -->
<!-- @ref LLP 0188#never-silent [extends]: present the sharing split per client in the compact view -->
<!-- @ref LLP 0330#capture-health-line [extends]: bounded flush evidence moves under Attention in compact text -->
<!-- @ref LLP 0385#sources-state-is-a-verdict [constrained-by]: preserve collector and JSON verdicts -->

## Compact view {#compact-view}

The default `hyp status` text answers whether the daemon is running, how much
storage it uses, which clients are configured, their sharing policies, and what
needs attention. `--verbose` retains the detailed inventory and setup history.
`--json` retains its existing report and takes precedence over `--verbose`.
Both text views share the Attention summary and primary next steps. Verbose
places it before the detailed inventory, which retains source health and full
diagnostic repair details for inspection.

The presentation heading says `Needs attention` when there are warnings,
errors, source health problems, unfinished client actions, or a stopped daemon.
It is an attention cue, not a change to the collector's `overall` verdict
(LLP 0385). Configured or attached does not mean capture has been verified.

Each configured client or picker source carries `Sync` or `Local only` from
the existing sharing split (LLP 0188). An enrolled host without a readable
policy shows `Unknown`; it must not infer permission from configuration
provenance. Sync is policy, not delivery confirmation. Unconfigured clients
are omitted unless attached or carrying a probe error. Sources without attach
probes, including Hermes and raw gateway sources, remain visible in the split.

First-sync holds, directory withholding, and the new-folder policy remain
visible in both views. Product telemetry remains visible when enabled.

A telemetry gap is labeled `Telemetry may be interrupted`, with last telemetry
and transcript activity ages and a primary next step. This does not claim an
exact set of missing records. The compact view prints each gap once under
Attention rather than repeating its diagnostic message. Other diagnostics
retain a message and their first repair; all repairs remain in `--verbose`.

Cache flush failures retain their attempt tense, bounded table evidence, exact
overflow count, and JSON pointer (LLP 0330). Routine maintenance keeps its
diagnostic and inspection command but moves the partition inventory to verbose.
Paths, plugin inventory, proxy trust details, configuration etags, recent
entrypoint inventory, and completed setup actions also move to verbose.

## Cost and validation {#validation}

Both views use one existing status collection. Rendering adds no filesystem,
network, process, or cache probes. Client and health maps bound lookup work to
the number of report entries; flush evidence keeps its eight-table text cap.

Tests cover mixed sharing, unknown policy, probe-less clients, quiet unused
clients, warning headlines, gap timestamps, privacy notices, bounded flush
failure evidence, and verbose/JSON CLI dispatch. Existing detailed renderer
tests continue to cover the verbose report.
