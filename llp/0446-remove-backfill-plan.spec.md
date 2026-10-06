# LLP 0446: Remove backfill planning

**Type:** Spec
**Status:** Accepted
**Extended-by:** LLP 0447 (remove the client history import alias)
**Systems:** CLI, Plugins, Backfill
**Author:** Brendan / Codex
**Date:** 2026-09-28
**Related:** LLP 0140, LLP 0161, LLP 0248, LLP 0445

## Request {#request}

Remove `hyp backfill plan` and its `hyp client history plan` alias. Most
providers supply no plan, so successful output can contain only metadata.
Use `hyp backfill <provider> --dry-run` for a scan without importing rows.

This supersedes the planning surface in LLP 0445#canonical and LLP 0248#tree,
the planning context requirement in LLP 0140's consequences, and the optional
OpenClaw planning hook in LLP 0161#backfill-provider. Other import and ownership
requirements remain in force. The removal of the alias is explicitly requested.

## Surface {#surface}

Keep `hyp backfill [provider...]` and `hyp backfill list`, including their
long import/providers aliases. Remove the planning command, parser, renderer,
telemetry name, provider hook, and planning-only types. Put shared run context
fields directly on `BackfillRunContext`. OpenClaw's only planning caller was
the removed command, so remove its hook too. Documentation teaches `--dry-run`.

The existing unknown-provider and unknown-subcommand errors handle removed
spellings; no compatibility handler silently turns a former plan into an import.

## Validation {#validation}

Verify help and the registry expose no plan, import aliases still resolve, and
existing dry-run tests prove scans write no rows. Run traditional tests and
type checking. Removal adds no per-record work or retained allocations.
