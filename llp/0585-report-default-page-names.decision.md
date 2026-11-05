# LLP 0585: Report save and publish accept the default analysis pages

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports
**Author:** HypForge / Claude
**Date:** 2026-11-05
**Extends:** LLP 0436 (#sources: three more page names), LLP 0465 (#save: the store takes the same names through the shared allow-list)
**Related:** PR #2901 (the report contract's five default pages), HypAware Server's upload validator and section-page list, which accept the same names in a separate server change

## Pages {#pages}

The hypaware-report contract now makes five pages the default: `report.md`,
`comparison.md`, `work.md`, `automation.md`, and `repeated-work.md`, plus
`recommendation-<slug>.md` per proposal. The LLP 0436 allow-list named only
`usage.md`, `work.md`, and `health.md` beside the entry page, so `hyp report
save` and `hyp report publish` refused every default folder at its first
unknown entry.

The folder allow-list also admits `comparison.md`, `automation.md`, and
`repeated-work.md` as regular files. `usage.md` and `health.md` stay accepted,
so a report drafted under the earlier contract still saves and publishes.
Everything else LLP 0436#sources settled is unchanged: the entry page, the
slug grammar, the legacy `change-<slug>.md` spelling, the refusals, and the
server's authority over content.

The client has no renderer (LLP 0495#ownership), so these names need no
client rendering change. The hosted renderer and upload validator are the
server's half and land before a client release that sends these pages.

## Validation {#validation}

`test/core/report-commands.test.js` publishes and saves a folder holding the
five default pages and checks every page reaches the bundle or the store.
