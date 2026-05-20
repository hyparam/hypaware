# Changelog

All notable changes to Collectivus are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.0] — 2026-05-19

### Added

- Claude Code proxy message rows can now be enriched from local transcripts
  with provider UUIDs, parent UUIDs, request IDs, entrypoints, client versions,
  user types, compact metadata, and raw frame details when matching transcript
  rows are available.
- `ctvs query sql` now caps table-shaped result sets at 100 rows and handles
  `ORDER BY RANDOM() LIMIT n` with reservoir sampling for bounded random
  samples.
- `ctvs init server` opens the Central server configuration walkthrough
  directly.

### Changed

- The default `npx collectivus` walkthrough now focuses on Standalone capture
  sources, installs the background daemon automatically on supported platforms,
  and attaches Claude Code when Claude Code capture is selected.
- `ctvs`, `ctvs attach`, and `ctvs install` now fall back to
  `~/.hyp/collectivus.json` when no config path is supplied and the default
  config exists.

## [3.0.0] — 2026-05-15

### Added

- `ctvs gascity` can capture gascity supervisor transcripts into the
  `gascity_messages` dataset, with Claude and Codex normalizers, Parquet
  output, per-session cursors, attach/detach/list/status/backfill commands,
  and `ctvs query` catalog/schema/SQL support.
- Standalone initialization now lets operators choose Proxy, gascity, OTLP, or
  all capture sources, discovers gascity supervisors from a workspace, and can
  backfill recoverable gascity history during setup.
- `ctvs query refresh <file.jsonl>...` materializes selected source files, and
  missing/stale-cache guidance now suggests file-targeted refresh commands when
  the affected source files are known.
- Dynamic collection tables can be queried by their normalized SQL table name
  or by their original quoted collection name.
- `ctvs ignore add|remove|list`, `.ctvsignore`, and session-scoped ignore
  endpoints let users opt folders or active sessions out of Collectivus
  recording before rows are written. `ctvs attach --client claude` now installs
  the bundled query and ignore skills.

### Changed (breaking)

- Local `ctvs query` cache storage now uses local Iceberg tables under
  `.collectivus-query/cache` instead of Parquet sidecars under
  `.collectivus-query/parquet`. Config is now `query.cache.enabled` /
  `query.cache.dir`, and the CLI override is `--cache-dir`.
- Refreshes keep per-source JSONL cursors and append from the last processed
  byte where possible. Source truncation/rewrite or collection schema drift
  starts a new source epoch instead of recreating every cache partition.
- Glob-backed collection sources that disappear remain queryable as cache-only
  partitions instead of being pruned on refresh.

### Changed

- Query cache refresh writes now stream incrementally instead of buffering whole
  partitions, and proxy-message refresh can append new rows while preserving
  previously written message IDs and tool-call names.

### Fixed

- `ctvs gascity` backfill handles active sessions and recoverable supervisor
  backfill setup more reliably.

## [2.2.0] — 2026-05-14

### Added

- `ctvs collect --glob '<pattern>'` backs one logical table with many JSONL
  files. Each matched file becomes its own cache partition under
  `collections/<table>/source=<sha256>/data.parquet`; only files whose
  mtime/size changed re-materialize on refresh, and files that drop out of the
  glob are pruned on the next refresh. `_ctvs_source_path` identifies the
  origin file per row.
- `ctvs init` is now a real subcommand. With no arg it runs the existing
  interactive walkthrough; with a preset name it scaffolds a workspace. First
  preset `gascity` registers `.gc/events.jsonl` (single-file) and
  `.gc/runtime/session-reconciler-trace/segments/**/*.jsonl` (glob), and
  writes `.claude/skills/ctvs-gascity/SKILL.md`. Re-runs are idempotent;
  divergent existing skills are preserved and the new version is written to
  `SKILL.md.new`.
- Catalog and schema read meta from any partition, so glob-backed collections
  show correct column counts.

### Changed

- Collection manifest bumped to v2; v1 manifests continue to load.

## [2.1.0] — 2026-05-13

### Added

- `ctvs collect <file.jsonl> --name <name>` registers external JSONL files as
  dynamic query tables with inferred top-level fields and an explicit Parquet
  cache.
- S3 uploads can include proxy traffic with `upload.signals: ["proxy"]`,
  materializing the `proxy_messages` dataset alongside OTLP signals.
- Claude Code proxy message rows now include `cwd`, `git_branch`, and
  `attributes.client.claude_version` when context is available from Collectivus
  hooks or local transcripts.

## [2.0.0] — 2026-05-13

### Changed (breaking)

- **Proxy Parquet schema replaced.** The `proxy_exchanges` and
  `proxy_stream_events` Parquet datasets are removed. A new `proxy_messages`
  dataset takes their place with one row per content part, globally
  deduplicated by content-derived `message_id`. JSONL capture is unchanged —
  on-disk `kind: "exchange"` and `kind: "stream_event"` rows are still
  recorded as before; only the derived Parquet projection was reshaped.
- `ctvs export` now writes a single `<out>/proxy/messages.parquet` (was
  `<out>/proxy/exchanges.parquet` + `<out>/proxy/stream_events.parquet`).
- `ctvs query proxy get` now takes a `<conversation-id>` (previously
  `<exchange-id>`) and returns the conversation's part rows in
  `(message_index, part_index)` order.
- `ctvs query proxy events` is removed; query `proxy_messages` directly for
  the reconstructed assistant content.
- The query cache schema version is bumped (1 → 2), so existing Parquet
  caches are invalidated. The first query after upgrade triggers a full
  rebuild from JSONL.

### Migration

Old queries against `proxy_exchanges` / `proxy_stream_events` must be
rewritten against `proxy_messages`. See
[skills/collectivus-query/SKILL.md](skills/collectivus-query/SKILL.md) for the
new schema reference, working SQL patterns, and dataset semantics.

## [1.7.0] — 2026-05-13

### Changed (breaking)

- **`ctvs query` allows stale query cache by default.** Stale partitions
  (Parquet exists but may be outdated) now query successfully and emit a
  `warning: querying stale data; …` line to stderr instead of exiting non-zero.
  Stdout output (table, json, jsonl, markdown) is unchanged.
- `missing` partitions (no Parquet at all) still exit with the exact
  `ctvs query refresh …` command to run — that behavior is unchanged.

### Added

- `--strict-freshness` flag on `ctvs query` restores the pre-1.7 behavior
  where stale partitions are a hard error. Use this in scheduled jobs or
  CI checks that must never read outdated data.

### Migration

Scripts that relied on a non-zero exit code from stale partitions must add
`--strict-freshness` to keep the old behavior. Everything else — including
`--refresh always`, the warning text format, and stdout schemas — is
unchanged.
