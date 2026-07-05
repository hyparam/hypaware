// @ts-check

/**
 * @import { PluginConfigInstance } from '../../../hypaware-plugin-kernel-types.d.ts'
 */

/**
 * Read a client adapter plugin entry's `attach` policy block (LLP 0044) as a
 * tri-state. The single source of truth for interpreting the block — shared
 * by the reconciler (`action_attach.js`, which decides whether to attach a
 * client on join) and the status surface (`status.js`, which renders the
 * declared-attach `pending`/`n/a` derivation) so the two can never disagree
 * on what a given block means. The `backfill_policy.js` twin.
 *
 * A *missing* block is the default (on_join on → `onJoin: undefined`): the
 * reconcile path must not throw on a config the plugin validator (LLP 0044)
 * already accepted, and an enabled client adapter on a joined host attaches by
 * default ([LLP 0044 §Consent](../../../llp/0044-client-attach-on-join.decision.md)).
 *
 * A block that is *present but malformed* must not fail open, though: a
 * non-boolean `on_join` (e.g. the JSON typo `on_join: "false"`) is treated as
 * an opt-out (`onJoin: false`), never as "default on". The operator clearly
 * intended to set the flag, and silently editing a user-owned client settings
 * file is the wrong thing to do on a malformed opt-out. (With the per-plugin
 * validator live — T8 — such a config is rejected at apply time anyway; this
 * is the belt-and-braces read both consumers share.)
 *
 * Consumers test the off switch as `readAttachPolicy(entry).onJoin !== false`,
 * so both the default (`undefined`) and an explicit `true` mean "attach".
 *
 * @param {PluginConfigInstance | undefined} entry
 * @returns {{ onJoin: boolean | undefined }}
 * @ref LLP 0044#where-attach-is-declared [constrained-by] — attach policy (`on_join`) is owned by the client plugin; the kernel only reads it
 */
export function readAttachPolicy(entry) {
  const config = entry?.config
  const attach =
    config && typeof config === 'object' && !Array.isArray(config)
      ? /** @type {Record<string, unknown>} */ (config).attach
      : undefined
  if (!attach || typeof attach !== 'object' || Array.isArray(attach)) {
    return { onJoin: undefined }
  }
  const raw = /** @type {Record<string, unknown>} */ (attach)
  // Absent → default on (undefined). Present-and-boolean → that value.
  // Present-but-non-boolean → opt-out (false): do not fail open.
  const onJoin =
    raw.on_join === undefined
      ? undefined
      : typeof raw.on_join === 'boolean'
        ? raw.on_join
        : false
  return { onJoin }
}
