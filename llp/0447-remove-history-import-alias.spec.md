# LLP 0447: Remove the history import alias

**Type:** Spec
**Status:** Accepted
**Systems:** CLI
**Author:** Brendan / Codex
**Date:** 2026-09-28
**Related:** LLP 0248, LLP 0445, LLP 0446

## Request {#request}

The user explicitly requests removing `hyp client history import` as redundant
surface, rather than retaining it as a compatibility alias. This replaces the
import-alias retention in LLP 0445#canonical and LLP 0446#surface and overrides
LLP 0248#aliases's removal deferral for this spelling.

## Surface {#surface}

`hyp backfill [provider...]` is the sole history import spelling. Remove the
long import alias from registration and documentation. Existing unknown
subcommand handling rejects it. Keep `backfill list` and its providers alias;
import behavior, flags, and dry runs remain unchanged.

## Validation {#validation}

Check canonical help, retained provider-list alias resolution, and rejection
of the removed import spelling. No CPU or memory concern: this deletes static
metadata and adds no runtime work.
