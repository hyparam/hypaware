// @ts-check

/**
 * The client actions report: what the managed config asked each client to
 * do, and how much of it the client asset ledger covers.
 *
 * @import { HypAwareV2Config, PluginConfigInstance } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ClientActionStatus } from '../../../../src/core/config/types.js'
 * @import { ClientActionReport, ClientActionsReport } from '../../../../src/core/daemon/types.js'
 * @import { ClientDescriptor } from '../../../../src/core/types.js'
 * @import { ClientAssetLedgerRecord } from '../../../../src/core/runtime/types.js'
 */

import { readAttachPolicy } from '../../config/attach_policy.js'
import { readBackfillPolicy } from '../../config/backfill_policy.js'
import { isEntryRecording } from '../../config/client_recording.js'
import { compareStrings } from '../../util/compare_strings.js'
import { sanitizeLabel } from '../../util/json_util.js'

/** How many client names the coverage notice spells out before summarizing. */
const ASSET_COVERAGE_MAX_NAMED = 3

/**
 * Per-name cap, so three names plus the sentence stay inside the renderers'
 * 400-character line cap and the remedy is never the part that gets cut.
 */
const ASSET_COVERAGE_MAX_LABEL_CHARS = 64

/**
 * The informational notice for managed skills and agents that update-time
 * installation will not refresh, or null when there are none.
 *
 * A client is covered when it is attached by the same settings-marker probe
 * `skills install --attached` selects with (LLP 0458#attached-only); `attached`
 * is that probe's result, already taken for the clients rows. The ledger only
 * says HypAware once wrote assets for a client. It cannot say whether they are
 * still present, edited, or older than this package, so the notice claims
 * none of that, and it stands even right after a fresh explicit install.
 *
 * @ref LLP 0534#notice [implements]: ledger clients the attached probe does not select, named and bounded, never a diagnostic
 * @param {{ records: ClientAssetLedgerRecord[], attached: string[], labelOf: (name: string) => string }} args
 * @returns {string | null}
 */
export function describeAssetCoverage({ records, attached, labelOf }) {
  const covered = new Set(attached)
  /** @type {Set<string>} */
  const uncovered = new Set()
  for (const record of records) {
    if (!covered.has(record.client)) uncovered.add(record.client)
  }
  if (uncovered.size === 0) return null
  const names = [...uncovered].sort(compareStrings)
  const shown = names.slice(0, ASSET_COVERAGE_MAX_NAMED)
    .map((name) => sanitizeLabel(labelOf(name), ASSET_COVERAGE_MAX_LABEL_CHARS)
      ?? sanitizeLabel(name, ASSET_COVERAGE_MAX_LABEL_CHARS)
      ?? 'an unnamed client')
  const rest = names.length - shown.length
  const who = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
  return `Managed skills/agents for ${who} are outside automatic update coverage; run hyp skills install after package updates`
}

/**
 * Build the client-action reconciler section for `hyp status` from the
 * persisted marker store and the effective config. Pure: it reads markers
 * and config and never runs a reconcile pass (LLP 0041, the status surface
 * "reads the marker file, it never runs a pass"). Returns null when nothing
 * applies so the V1 status surface is unchanged on an ordinary host.
 *
 * Per-provider state:
 * - `done` / `failed` come straight from a persisted marker (any request
 *   key, even one whose plugin has since left the config).
 * - `pending` / `n/a` are derived for *declared* targets the reconciler would
 *   act on but has not yet. Two handlers declare such targets:
 *   - **backfill** (LLP 0037): a plugin entry's `config.backfill` block,
 *     keyed by owning-plugin name.
 *   - **attach** (LLP 0044 / 0045), an enabled client adapter, keyed by
 *     *client* name (the attach handler's request key), opted out by
 *     `config.attach.on_join: false`.
 *   Neither capability is visible to the status collector without activating
 *   plugins (both are runtime registrations, LLP 0041 §per-plugin-capability),
 *   so the catalog's client descriptors are the honest, provider-agnostic
 *   proxy: `on_join: false` or a non-joined host → `n/a` (the reconciler is a
 *   no-op); otherwise desired-but-unrun → `pending`.
 *
 * @param {{ status: ClientActionStatus, config: HypAwareV2Config | null, hasCentral: boolean, clientDescriptors?: Map<string, ClientDescriptor> }} args
 * @returns {ClientActionsReport | null}
 * @ref LLP 0041#idempotency-and-completion-state [implements]: Per-provider done/failed/pending/n-a derived from the per-handler/per-request-key marker store, no reconcile pass
 */
export function buildClientActionsReport({ status, config, hasCentral, clientDescriptors }) {
  /** @type {ClientActionReport[]} */
  const actions = []
  const byKind = status?.byKind ?? {}
  // Client-adapter plugins (claude/codex), derived statically from the catalog
  // descriptors: the set the backfill default-on derivation needs ("this
  // enabled plugin imports on join") and, via the descriptors themselves, the
  // universe of attach targets below. Each maps to whether the reconciler's
  // `desired()` would ever name it: it enumerates the runtime backfill
  // registry, so a client whose manifest declares it registers no provider
  // (`backfill_provider: false`, Claude Desktop) is a target it never emits,
  // and no marker will ever clear a `pending` derived for it. That is the
  // backfill twin of the probe-less attach gate (LLP 0229): status derives
  // by the reconciler's own gate or reports `n/a`.
  // @ref LLP 0379#status-derives-by-the-provider-gate [implements]: a provider-less client adapter is inert for backfill, never pending
  /** @type {Map<string, boolean>} */
  const clientAdapterPlugins = new Map()
  for (const d of clientDescriptors?.values() ?? []) {
    const inert = d.backfillProvider === false
    // A plugin can own several clients; it is inert only if none of them
    // brings a provider.
    clientAdapterPlugins.set(d.plugin, (clientAdapterPlugins.get(d.plugin) ?? true) && inert)
  }

  // Declared backfill targets: enabled plugin entries that drive
  // backfill-on-join (LLP 0037, policy rides the owning plugin). Keyed by
  // owning-plugin name (the backfill handler's request key, LLP 0041). Two cases:
  //   1. An explicit `config.backfill` block (any host).
  //   2. *Default-on*: a known backfill provider with no explicit block. On
  //      a joined host `backfillHandler.desired()` still emits for it, so it
  //      is a real (pending) target. Status mirrors that here; without this
  //      the default-on case was invisible. It is gated on `hasCentral` so a
  //      non-joined host (where the reconciler never runs) keeps its
  //      V1-unchanged surface. A bare `claude`/`codex` install shows nothing.
  /** @type {Map<string, { onJoin: boolean, inert?: boolean }>} */
  const declared = new Map()
  for (const entry of config?.plugins ?? []) {
    if (entry.enabled === false) continue
    const raw = entry.config?.backfill
    const hasBlock = !!raw && typeof raw === 'object' && !Array.isArray(raw)
    // Known only for client adapters. An explicit block on any other plugin
    // keeps its previous answer (declared, so pending until a marker lands).
    const inert = clientAdapterPlugins.get(entry.name) === true
    if (hasBlock) {
      // Use the shared tri-state read so status can never disagree with the
      // reconciler about what a block means: a malformed `on_join` (e.g. the
      // string "false") is an opt-out, not default-on. `onJoin: undefined`
      // (block present, `on_join` absent) is default-on → not suppressed.
      const onJoin = readBackfillPolicy(entry).onJoin !== false
      declared.set(entry.name, { onJoin, inert })
    } else if (hasCentral && clientAdapterPlugins.has(entry.name)) {
      declared.set(entry.name, { onJoin: true, inert })
    }
  }

  // Declared attach targets (LLP 0044 / 0045): symmetric to backfill, but keyed
  // by *client* name, the attach handler's request key is the client name
  // (`descriptor.name`), not the owning plugin, so a `done` attach marker the
  // handler writes merges with the declared target instead of doubling it. Every
  // enabled client adapter on a joined host is a desired attach target by
  // default; an explicit `config.attach` block opts out via `on_join: false`,
  // read through the shared `readAttachPolicy` (the `backfill_policy.js` twin) so
  // status can never disagree with `action_attach.js` about what a block means.
  // The default-on case is gated on `hasCentral` for the same V1-surface reason
  // as backfill: a bare local claude/codex install shows nothing.
  // @ref LLP 0044#status-surface [implements]: per-client done/failed/pending/n-a; `on_join:false` or non-joined → n/a, never degrading
  /** @type {Map<string, PluginConfigInstance>} */
  const enabledByPlugin = new Map()
  for (const entry of config?.plugins ?? []) {
    if (entry.enabled === false) continue
    enabledByPlugin.set(entry.name, entry)
  }
  /** @type {Map<string, { onJoin: boolean, inert?: boolean }>} */
  const declaredAttach = new Map()
  for (const [clientName, descriptor] of clientDescriptors ?? new Map()) {
    const entry = enabledByPlugin.get(descriptor.plugin)
    if (!entry) continue
    // A probe-less descriptor is the third way the reconciler is a no-op, next
    // to `on_join: false` and a non-joined host. `desired()` skips it because
    // attach must be reversible and only the probe can reverse it, so no marker
    // will ever appear and `pending` would be permanent (#544). Same shape as
    // the `readAttachPolicy` sharing above: status must not derive a target the
    // reconciler would never name.
    //
    // Codex does NOT reach this gate, even in transcript mode. The marker
    // `attachWritesNoMarker` speaks about is the client's own settings block;
    // the marker THIS surface reads is the reconciler's action record, and a
    // transcript attach earns one: `desired()` gates only on `attachProbe`
    // (which codex declares), `perform()` removes the managed provider block
    // and returns `status: ok`, so the `done` marker lands. `pending` is
    // transient here, exactly as for every other client. Calling it `n/a`
    // would report "the reconciler is a no-op" over precisely the migration
    // this release performs, recreating - inverted - the status/reconciler
    // disagreement the paragraph above exists to forbid.
    // @ref LLP 0229#status-derives-by-the-same-gate [implements]: a probe-less attach target is n/a, never pending
    const inert = !descriptor.attachProbe
    const raw = entry.config?.attach
    const hasBlock = !!raw && typeof raw === 'object' && !Array.isArray(raw)
    // A detached client is one the reconciler skips (LLP 0466), so its attach
    // action is suppressed, never pending.
    if (!isEntryRecording(entry)) {
      declaredAttach.set(clientName, { onJoin: false, inert })
    } else if (hasBlock) {
      const onJoin = readAttachPolicy(entry).onJoin !== false
      declaredAttach.set(clientName, { onJoin, inert })
    } else if (hasCentral) {
      declaredAttach.set(clientName, { onJoin: true, inert })
    }
  }

  // Kinds to render: every kind the markers record, plus a kind for each
  // handler that declared a target (so a configured-but-unrun target shows even
  // with no marker yet). `backfill` keys by plugin, `attach` by client name.
  /** @type {Record<string, Map<string, { onJoin: boolean, inert?: boolean }>>} */
  const declaredByKind = { backfill: declared, attach: declaredAttach }
  /** @type {Set<string>} */
  const kinds = new Set(Object.keys(byKind))
  for (const [k, m] of Object.entries(declaredByKind)) {
    if (m.size > 0) kinds.add(k)
  }

  for (const kind of [...kinds].sort()) {
    const markers = byKind[kind] ?? {}
    const declaredForKind = declaredByKind[kind]
    /** @type {Set<string>} */
    const keys = new Set(Object.keys(markers))
    if (declaredForKind) for (const name of declaredForKind.keys()) keys.add(name)
    for (const requestKey of [...keys].sort()) {
      const marker = markers[requestKey]
      if (marker && marker.status === 'failed') {
        actions.push({
          kind,
          requestKey,
          state: 'failed',
          ...(typeof marker.reason === 'string' ? { reason: marker.reason } : {}),
          ...(typeof marker.last_attempt === 'string' ? { lastAttempt: marker.last_attempt } : {}),
          ...(typeof marker.attempts === 'number' ? { attempts: marker.attempts } : {}),
        })
      } else if (marker && marker.status === 'refused') {
        // @ref LLP 0186#hyp-status-attention-needed-surface [implements]: terminal refused marker, reason+at, no attempts
        actions.push({
          kind,
          requestKey,
          state: 'refused',
          ...(typeof marker.reason === 'string' ? { reason: marker.reason } : {}),
          ...(typeof marker.at === 'string' ? { at: marker.at } : {}),
        })
      } else if (marker) {
        // `done` (run-once / attached) or `applied` (reversible): the effect
        // is in place. For attach a `done` marker is the "attached" rendering.
        actions.push({
          kind,
          requestKey,
          state: 'done',
          ...(typeof marker.rows === 'number' ? { rows: marker.rows } : {}),
          ...(typeof marker.at === 'string' ? { at: marker.at } : {}),
        })
      } else {
        // No marker: a declared backfill or attach target. Suppressed
        // (on_join:false), inert (host never joined, or the handler's own
        // `desired()` would skip this target) → the reconciler is a no-op →
        // n/a; otherwise desired and simply not run yet → pending.
        const decl = declaredForKind?.get(requestKey)
        const suppressed = decl ? !decl.onJoin || decl.inert === true : false
        const state = suppressed || !hasCentral ? 'n/a' : 'pending'
        actions.push({ kind, requestKey, state })
      }
    }
  }

  return actions.length > 0 ? { actions } : null
}
