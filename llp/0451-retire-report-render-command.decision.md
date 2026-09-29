# LLP 0451: Retire the local report render command

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports
**Author:** Brendan / Codex
**Date:** 2026-09-29
**Extends:** LLP 0436, LLP 0450, LLP 0196, LLP 0393

## Server rendering {#server-rendering}

Remove `hyp report render` from the CLI, its argument schema, help, and command
telemetry vocabulary. Publishing already sends Markdown for the server to render.
This supersedes the standalone preview exception in LLP 0436 and LLP 0450's
decision to leave rendering commands unchanged.

Keep the shared `hypaware/core/reports` export, renderer, types, assets, and
renderer tests. HypAware Server imports `renderReports` from that export in
`src/reports/render-tree.js`. Its library contract is unchanged.

Older clients emitting `report render` product telemetry are classified as
`unknown` by receivers using the current finite command vocabulary. This follows
the existing command-retirement behavior; no receive-only vocabulary is added.

## Validation {#validation}

Verify the retired command is absent from the registry and dispatch rejects it,
while the shared package export remains callable. Run CLI consistency tests and
the renderer suite. CPU and memory review: removing the wrapper adds no work or
retained state; the shared rendering path is untouched.
