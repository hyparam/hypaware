---
name: llp-list
description: List the LLP documents in this repository, grouped by status or filtered by type, system, or status. Useful for answering "what's still in draft?", "which RFCs are active?", or "what documents cover the auth system?"
---

# llp-list

Use this skill when the user wants to see what LLPs exist in the repo, or filter them by type, status, or system tag.

Invoke as:

- `/llp-list` — show all LLPs grouped by status
- `/llp-list <status>` — show only LLPs with that status (e.g., `/llp-list draft`, `/llp-list active`)
- `/llp-list type=<type>` — show only LLPs of a given type (e.g., `/llp-list type=rfc`)
- `/llp-list system=<system>` — show only LLPs tagged with a given system
- `/llp-list author=<name>` — show LLPs by a specific author

Filters can combine: `/llp-list draft type=rfc system=auth`.

## Ground rules

- LLPs live in `llp/` by default. Scan recursively, including `llp/tombstones/`.
- Other repositories may have additional LLP trees; check the project's root LLP, `CLAUDE.md`, or `AGENTS.md` for documented locations.
- LLP filenames follow `NNNN-slug.type.md`. The number and type come from the filename; title, status, systems, and author come from the metadata header at the top of the file.
- Standard statuses: `Draft`, `Review`, `Accepted`, `Active`, `Superseded`, `Tombstoned`.
- Standard types: `rfc`, `spec`, `decision`, `plan`, `explainer`, `principle`, `guide`, `issue`, `research`.

## Workflow

### 1. Scan and parse

Walk the `llp/` directory. For each file matching `NNNN-*.md`:

- Extract the number from the filename prefix.
- Extract the type from the filename extension (the segment before `.md`).
- Read the file header and extract:
  - Title from the first `# LLP NNNN: <Title>` heading line
  - Status from `**Status:** <value>`
  - Systems from `**Systems:** <comma-separated list>`
  - Author from `**Author:** <value>`
  - Date from `**Date:** <value>`

Normalize values:

- Strip leading/trailing whitespace
- Strip `vN` suffixes on statuses (e.g., `Draft v2` → `Draft`)
- Strip trailing parenthetical notes (e.g., `Accepted (pending implementation)` → `Accepted`)
- Compare case-insensitively

### 2. Apply filters

If the user specified filters, remove LLPs that don't match. Supported filters:

- Status — case-insensitive exact match after normalization
- Type — case-insensitive exact match
- System — case-insensitive substring match against the Systems list
- Author — case-insensitive substring match against the Author field

If no filter is provided, show everything.

### 3. Group and sort

Group by status (in the canonical lifecycle order: Draft → Review → Accepted → Active → Superseded → Tombstoned → any other / unknown statuses at the end).

Within each group, sort by LLP number ascending.

If a single-status filter was provided, skip grouping and just show the sorted list.

### 4. Render

Format each LLP as:

```
NNNN  <title>  [<type>]  <systems>
```

With fixed-width number column and visually separated fields. Example:

```
DRAFT
  0041  Network error handling        [rfc]       Network
  0045  Offline queue design           [rfc]       Sync, Offline
  0047  Intent-level authoring         [research]  SDK

ACTIVE
  0001  Greenfield setup               [guide]     Core
  0004  Design principles              [principle] Core

TOMBSTONED
  0009  Legacy sync design             [decision]  Sync
```

If a filter was provided, include the filter in the header:

```
Draft LLPs tagged "auth":
  0042  Token rotation                 [rfc]       Auth, Security
  0044  Session management             [rfc]       Auth
```

### 5. Summary line at the end

Show a count:

```
42 LLPs: 8 draft, 2 review, 4 accepted, 26 active, 2 superseded
```

Or for filtered results:

```
3 matching LLPs (2 draft, 1 review)
```

## Output formats

By default, render as plain text. Support format flags:

- `/llp-list --format=json` — emit a JSON array of LLP metadata for programmatic use
- `/llp-list --format=markdown` — emit a markdown-formatted list, suitable for pasting into another document
- `/llp-list --format=table` — emit a markdown table with Number / Title / Type / Status / Systems columns

## Edge cases

- **Files without a parseable header.** If the metadata is missing or malformed, include the file in the output but mark its fields as `(unknown)`. Report a count of problem files at the end.
- **Duplicate numbers.** Should never happen but may if someone made a mistake. List all files with duplicate numbers in a warning section at the end.
- **Tombstones directory.** Files in `llp/tombstones/` should be included in the listing but their default status is `Tombstoned` even if the file header says otherwise (the location is authoritative for tombstoned status). Filter `tombstoned` to show only these; by default they appear in the tombstoned group.

## Scope limits

- Do not create, modify, or delete LLPs. This skill is read-only.
- Do not interpret LLP content — just metadata. For content analysis, use `/llp-search` or `/llp-review`.
- Do not follow cross-references (`Related:` fields). For cross-reference traversal, use `/llp-related`.
