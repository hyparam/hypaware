# LLP 0516: List only explicit recommendation statuses

**Type:** Spec
**Status:** Accepted
**Systems:** CLI, Reports
**Date:** 2026-10-16
**Extends:** LLP 0461 #states-are-the-servers and #status-is-visible (listing fallback only)

## Listing status {#listing-status}

`hyp report list`, including `--recommendations` and `--status`, displays a
status label only when the server supplies a nonempty string in `status.state`.
Missing, null, empty, or malformed states produce no label or status cell.
An explicit `open` still displays `[open]`; other server states retain their
existing escaping and display behavior.

This supersedes LLP 0461's listing fallback from absent status to `open`.
A report endpoint that omitted its status join made applied recommendations
look open. Absence cannot distinguish that response from an unmarked record.
The client must not infer a state from missing data.

JSON responses, server-side filtering, and the `report get` brief are unchanged.
Both listing formats are covered by regression tests for absent states and
explicit server states. Rendering remains constant work and space per row,
without additional requests or retained data.
