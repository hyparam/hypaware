// @ts-check

/**
 * Cache maintenance defaults, in a module of their own so config
 * validation can read them without importing the maintenance engine (and
 * with it icebird, hyparquet, and the sidecar builder) into every CLI
 * start. `normalizeMaintenanceConfig` and `parseConfigShape` must agree on
 * what an omitted key means: a cross-field rule that compared only the
 * values a user wrote would pass a config whose EFFECTIVE pairing is the
 * one it exists to reject.
 */

/**
 * @import { MaintenanceConfig } from '../../../src/core/cache/types.js'
 */

export const SNAPSHOT_RETENTION_DEFAULTS = Object.freeze({
  min_snapshots_to_keep: 10,
  max_snapshot_age_hours: 24,
})

/** @type {Readonly<MaintenanceConfig>} */
export const MAINTENANCE_DEFAULTS = Object.freeze({
  enabled: true,
  interval_minutes: 60,
  target_file_bytes: 128 * 1024 * 1024,
  ...SNAPSHOT_RETENTION_DEFAULTS,
  compact_file_count: 32,
  // @ref LLP 0312#avg-below-batch [constrained-by]: an in-place merged file
  // never exceeds `compact_batch_bytes`, so the average-size threshold that
  // decides dueness must stay at or below it. The defaults are equal, which
  // is the boundary; config validation holds the inequality.
  compact_avg_file_bytes: 32 * 1024 * 1024,
  compact_batch_bytes: 32 * 1024 * 1024,
  max_tick_ms: 30_000,
})
