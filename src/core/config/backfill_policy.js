// @ts-check

/**
 * @import { PluginConfigInstance } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Read a plugin entry's `backfill` policy block (LLP 0037) as a
 * tri-state. The single source of truth for interpreting the block:
 * shared by the reconciler (`action_backfill.js`, which decides whether to
 * run an import) and the status surface (`status.js`, which renders
 * `pending`/`n/a`) so the two can never disagree on what a given block
 * means.
 *
 * A *missing* block is the default (on_join on → `onJoin: undefined`, no
 * window): the reconcile path must not throw on a config the plugin
 * validator (LLP 0037) already accepted.
 *
 * A block that is *present but malformed* must not fail open, though: a
 * non-boolean `on_join` (e.g. the JSON typo `on_join: "false"`) is treated
 * as an opt-out (`onJoin: false`), never as "default on". The operator
 * clearly intended to set the flag, and a potentially months-deep import is
 * the wrong thing to run on a malformed opt-out. (With the per-plugin
 * validator now live (see apply/boot wiring), such a config is rejected at
 * apply time anyway; this is the belt-and-braces read both consumers share.)
 *
 * @param {PluginConfigInstance | undefined} entry
 * @returns {{ onJoin: boolean | undefined, windowDays: number | undefined }}
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [constrained-by]: backfill policy ({ on_join, window_days }) is owned by the plugin; the kernel only reads it
 */
export function readBackfillPolicy(entry) {
  const config = entry?.config
  const backfill =
    config && typeof config === 'object' && !Array.isArray(config)
      ? /** @type {Record<string, unknown>} */ (config).backfill
      : undefined
  if (!backfill || typeof backfill !== 'object' || Array.isArray(backfill)) {
    return { onJoin: undefined, windowDays: undefined }
  }
  const raw = /** @type {Record<string, unknown>} */ (backfill)
  // Absent → default on (undefined). Present-and-boolean → that value.
  // Present-but-non-boolean → opt-out (false): do not fail open.
  const onJoin =
    raw.on_join === undefined
      ? undefined
      : typeof raw.on_join === 'boolean'
        ? raw.on_join
        : false
  const windowDays =
    typeof raw.window_days === 'number' && Number.isInteger(raw.window_days) && raw.window_days > 0
      ? raw.window_days
      : undefined
  return { onJoin, windowDays }
}
