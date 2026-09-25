# LLP 0436: Publish Markdown report sources

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports, Plugins
**Date:** 2026-09-24
**Related:** LLP 0155, LLP 0107, LLP 0196

## Decision

### Sources

`hyp report publish` uploads Markdown for the server to render, matching
HypAware Server LLP 0484 and server PR #1135. A single `.md` or `.markdown`
file is sent as `text/markdown`. A folder must contain `report.md` and only
regular Markdown files named `usage.md`, `work.md`, `health.md`, or
`recommendation-<slug>.md`; the legacy `change-<slug>.md` spelling also works.
Slugs use the server grammar `[a-z0-9][a-z0-9-]*`.

Reject HTML, assets, unknown pages, directories, and symlinks before packing
or sending a directory. Enumerate only its immediate entries and pack the
validated filenames explicitly using the existing ustar transport. The
server remains authoritative for content validation, raw HTML and unsafe
links, input and output limits, rendering, and organization permissions.
No Markdown parser or renderer is added to the client upload path.

This extends LLP 0155's entry-document and fail-fast contract. Existing
published HTML remains readable. `hyp report render` remains available as
a standalone local command; its output is no longer a publish input.

### Skill

The bundled `hypaware-report` skill produces Markdown with analyst subagents
through each host's existing delegation facilities. Both adapters register
it as a client skill so the ordinary attach/materialization path installs it.
Generation requires neither a server account nor publishing.

When the user requests publishing, the skill uses `hyp report publish` with
the selected remote and the report's actual coverage period. Existing
credentials and the organization's publisher role govern the write. Publishing
authorization does not authorize raw-log upload or applying recommendations.
An upload failure leaves local sources available and is reported as a failure,
without a fallback to HTML or silent changes to content or destination.

### Validation

CLI tests cover Markdown transport, rejected files and bundle entries before
network access, and server validation errors. Existing adapter manifest and
skill parity checks cover discovery and host-specific delegation differences.

CPU and memory: validation walks one directory without reading page contents
or recursing; it retains only accepted filenames before the existing bounded
tar output buffer. It adds no dependency, rendering work, or long-lived state.
