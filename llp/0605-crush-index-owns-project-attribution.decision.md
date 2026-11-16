# LLP 0605: Crush's index owns project attribution

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins
**Date:** 2026-11-16
**Related:** LLP 0573

## Evidence {#evidence}

Crush records both `path` and `data_dir` in `projects.json`. Its
`CRUSH_DATA_DIR`, `--data-dir` and `data_directory` overrides can put the
database outside the project. Deriving the project from the storage directory
then applies `.hypignore` to the wrong directory and writes the wrong cwd.
The discovery regression reproduces both wrong attribution and admission of
one database indexed for different projects.

## Ownership {#ownership}

Extend LLP 0573's discovery rule: an indexed database takes its project from
the real path of the index entry's absolute `path`, never from `data_dir`.
Missing, relative or unreadable project paths withhold that database. Multiple
index spellings of one real database must agree on the real project path;
otherwise withhold it because the database's session rows do not identify
which project owns each session. A configured `data_dirs` entry cannot bypass
that refusal. An unindexed conventional `.crush` directory retains its parent
as the project; an unindexed custom directory has no attributable project.

Withheld databases degrade source health with `project_path_unresolved`.
Capture and backfill share discovery, and partial discovery must not prune
watermarks for the withheld databases. No migration or repair of historical
Crush rows is required: Phil confirmed there are no current Crush users.

## Bounds and validation {#validation}

Keep the index signature cache, real database deduplication, database cap and
existing poll/backfill budgets. Discovery retains project-path evidence with
the cached index and resolves it before opening a database. It adds no
per-message work or persistent state. Tests cover custom storage, project-path
aliases, conflicting ownership, invalid paths, source and backfill privacy,
cwd attribution, and unchanged-index behavior. The capture smoke uses external
storage for its included, ignored and local-only projects and checks telemetry.
