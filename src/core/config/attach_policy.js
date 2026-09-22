// @ts-check

/**
 * @import { PluginConfigInstance } from '../../../hypaware-plugin-kernel-types.d.ts'
 */

/**
 * Read a client adapter plugin entry's `attach` policy block (LLP 0044) as a
 * tri-state. The single source of truth for interpreting the block: shared
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
 * validator live, T8, such a config is rejected at apply time anyway; this
 * is the belt-and-braces read both consumers share.)
 *
 * Consumers test the off switch as `readAttachPolicy(entry).onJoin !== false`,
 * so both the default (`undefined`) and an explicit `true` mean "attach".
 *
 * @param {PluginConfigInstance | undefined} entry
 * @returns {{ onJoin: boolean | undefined }}
 * @ref LLP 0044#where-attach-is-declared [constrained-by]: attach policy (`on_join`) is owned by the client plugin; the kernel only reads it
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

/** The one client whose attach contract depends on how it captures. */
export const CODEX_PLUGIN_NAME = '@hypaware/codex'

/**
 * Codex's capture mode, the third thing that decides whether an attach has
 * anything to write. `gateway` writes the managed `[model_providers.hypaware]`
 * block its `attach_probe` reads back; `transcript` (the default) *removes*
 * that block and writes no marker at all, so the probe can never find one.
 *
 * Shared for the same reason as `readAttachPolicy` above: the reconciler
 * (`action_attach.js`, deciding whether a marker is stale) and the status
 * surface (`status.js`, deciding whether attach state is even a state for
 * this client) must not disagree. They did: with the probe still declared and
 * no marker ever written, status reported `client_attach_missing` forever and
 * its repair (`hyp client attach codex`) was a no-op that could never clear
 * it. That is precisely the wrong-negative LLP 0229 exists to stop, so a
 * transcript-mode codex is *unattachable*, not *unattached*.
 *
 * @param {PluginConfigInstance[] | undefined} plugins  The config's plugin list
 * @returns {'gateway' | 'transcript'}
 * @ref LLP 0429#default [implements]: absent or `transcript` is file capture; only `gateway` selects the provider writer
 * @ref LLP 0229#status-derives-by-the-same-gate [constrained-by]: a client with no marker to write is n/a, not "not attached"
 */
export function readCodexCaptureMode(plugins) {
  const config = plugins?.find((entry) => entry.name === CODEX_PLUGIN_NAME)?.config
  const mode =
    config && typeof config === 'object' && !Array.isArray(config)
      ? /** @type {Record<string, unknown>} */ (config).capture_mode
      : undefined
  return mode === 'gateway' ? 'gateway' : 'transcript'
}
