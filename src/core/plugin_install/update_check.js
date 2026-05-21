// @ts-check

import { Attr, getKernelInstruments, SpanStatusCode, withSpan } from '../observability/index.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLockEntry} PluginLockEntry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginUpdateState} PluginUpdateState */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/**
 * Run an update check for one installed plugin. The check is best-
 * effort: it never throws, and a failure is recorded on the returned
 * `PluginUpdateState.error` field with `available=false`. The kernel
 * is rate-limited to one network probe per 24h per plugin per the
 * design's "share policy with the existing npm update check" note.
 *
 * For `local-dir` sources there is no upstream to query, so the
 * check is intrinsically `available=false` and the span emits in a
 * single tick without any side effect.
 *
 * @param {object} args
 * @param {PluginLockEntry} args.entry
 * @param {() => Date}     [args.now]
 * @returns {Promise<PluginUpdateState>}
 */
export async function checkForPluginUpdate({ entry, now }) {
  const nowDate = (now ?? (() => new Date()))()
  const instruments = getKernelInstruments()

  if (isRateLimited(entry, nowDate)) {
    const previous = entry.update
    if (previous) {
      instruments.pluginUpdatesAvailable.record(previous.available ? 1 : 0, {
        [Attr.PLUGIN]: entry.name,
      })
      return previous
    }
  }

  const span = await withSpan(
    'plugin.update_check',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.update_check',
      [Attr.PLUGIN]: entry.name,
      hyp_source_kind: entry.source.kind,
    },
    async (s) => {
      const state = await runProbe(entry, nowDate)
      if (state.error) {
        s.setStatus({ code: SpanStatusCode.ERROR, message: 'update_probe_failed' })
        s.setAttribute('status', 'failed')
        s.setAttribute('error_kind', 'update_probe_failed')
      } else {
        s.setAttribute('status', 'ok')
      }
      s.setAttribute('available', !!state.available)
      if (state.latest_version) s.setAttribute('latest_version', state.latest_version)
      if (state.latest_ref) s.setAttribute('latest_ref', state.latest_ref)
      return state
    },
    { component: 'plugin-install' }
  )

  instruments.pluginUpdatesAvailable.record(span.available ? 1 : 0, {
    [Attr.PLUGIN]: entry.name,
  })
  return span
}

/**
 * Decide whether the entry's existing `update.checked_at` is recent
 * enough to skip the probe. Defensive against malformed timestamps
 * (missing or non-ISO strings count as "stale enough").
 *
 * @param {PluginLockEntry} entry
 * @param {Date}             now
 */
function isRateLimited(entry, now) {
  const previous = entry.update
  if (!previous || !previous.checked_at) return false
  const parsed = Date.parse(previous.checked_at)
  if (Number.isNaN(parsed)) return false
  return now.getTime() - parsed < TWENTY_FOUR_HOURS_MS
}

/**
 * Probe the upstream for a newer version. The Phase 7 implementation
 * intentionally only handles `local-dir` (no upstream). The other
 * kinds get a benign "no upstream wired yet" response with
 * `available=false` — when Phase 8 brings real fetch online, this
 * function gets the actual git/npm probe without changing the span
 * contract.
 *
 * @param {PluginLockEntry} entry
 * @param {Date} now
 * @returns {Promise<PluginUpdateState>}
 */
async function runProbe(entry, now) {
  const checkedAt = now.toISOString()
  if (entry.source.kind === 'local-dir') {
    return { checked_at: checkedAt, available: false }
  }
  return {
    checked_at: checkedAt,
    available: false,
  }
}
