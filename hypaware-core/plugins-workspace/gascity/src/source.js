// @ts-check

import { gascityTablePath, GASCITY_SCHEMA_COLUMNS } from './dataset.js'
import { getActiveTransport } from './transport.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryStorageService} QueryStorageService */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').SourceStatus} SourceStatus */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').StartedSource} StartedSource */
/** @typedef {import('./transport.js').GascityCitySubscription} GascityCitySubscription */
/** @typedef {import('./transport.js').GascityFrame} GascityFrame */

/**
 * @typedef {Object} CityConfig
 * @property {string} name
 * @property {string} [api_url]
 */

/**
 * `startGascitySource(ctx)` is the `SourceContribution.start` callback
 * registered against the kernel `SourceRegistry`. It returns a
 * `StartedSource` whose `reload(ctx)` mirrors the donor's local SIGHUP
 * behavior: diff the configured city set against the running set, open
 * subscriptions for added cities, close subscriptions for removed
 * cities. The kernel emits `source.start` / `source.reload` spans
 * around each call.
 *
 * @param {PluginActivationContext} ctx
 * @returns {Promise<StartedSource>}
 */
export async function startGascitySource(ctx) {
  /** @type {Map<string, GascityCitySubscription>} */
  const subscriptions = new Map()
  const abortControllers = new Map()
  /** @type {{ rowsWritten: number, lastError: string | undefined }} */
  const state = { rowsWritten: 0, lastError: undefined }

  await applyCities(ctx, subscriptions, abortControllers, state)

  return {
    async status() {
      /** @type {SourceStatus} */
      const status = {
        state: 'ready',
        rowsWritten: state.rowsWritten,
        details: { cities: Array.from(subscriptions.keys()).sort() },
      }
      if (state.lastError) status.lastError = state.lastError
      return status
    },

    async reload(nextCtx) {
      await applyCities(nextCtx, subscriptions, abortControllers, state)
    },

    async stop() {
      const closes = []
      for (const [city, controller] of abortControllers) {
        try { controller.abort() } catch { /* defensive */ }
        const sub = subscriptions.get(city)
        if (sub) closes.push(Promise.resolve(sub.close()).catch(() => undefined))
      }
      subscriptions.clear()
      abortControllers.clear()
      await Promise.all(closes)
    },
  }
}

/**
 * @param {PluginActivationContext} ctx
 * @param {Map<string, GascityCitySubscription>} subscriptions
 * @param {Map<string, AbortController>} abortControllers
 * @param {{ rowsWritten: number, lastError: string | undefined }} state
 */
async function applyCities(ctx, subscriptions, abortControllers, state) {
  const desired = readConfiguredCities(ctx)
  const desiredByName = new Map(desired.map((c) => [c.name, c]))
  const log = ctx.log

  // Remove cities no longer configured.
  for (const name of Array.from(subscriptions.keys())) {
    if (desiredByName.has(name)) continue
    const controller = abortControllers.get(name)
    if (controller) {
      try { controller.abort() } catch { /* defensive */ }
    }
    const sub = subscriptions.get(name)
    subscriptions.delete(name)
    abortControllers.delete(name)
    if (sub) {
      try { await sub.close() } catch (err) {
        log.warn('gascity.city_close_failed', {
          city: name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // Open subscriptions for newly attached cities.
  const transport = getActiveTransport()
  for (const city of desired) {
    if (subscriptions.has(city.name)) continue
    const controller = new AbortController()
    abortControllers.set(city.name, controller)
    try {
      const subscription = await transport.subscribe({
        city: city.name,
        apiUrl: city.api_url,
        signal: controller.signal,
        onFrame: (frame) => writeFrame(ctx, frame, state, log),
      })
      subscriptions.set(city.name, subscription)
      log.info('gascity.city_attached', { city: city.name })
    } catch (err) {
      abortControllers.delete(city.name)
      const message = err instanceof Error ? err.message : String(err)
      state.lastError = message
      log.error('gascity.city_attach_failed', { city: city.name, error: message })
    }
  }
}

/**
 * @param {PluginActivationContext} ctx
 * @returns {CityConfig[]}
 */
function readConfiguredCities(ctx) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const raw = config.cities
  if (!Array.isArray(raw)) return []
  /** @type {CityConfig[]} */
  const out = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const name = /** @type {Record<string, unknown>} */ (entry).name
    if (typeof name !== 'string' || name.length === 0) continue
    const apiUrl = /** @type {Record<string, unknown>} */ (entry).api_url
    /** @type {CityConfig} */
    const city = { name }
    if (typeof apiUrl === 'string' && apiUrl.length > 0) city.api_url = apiUrl
    out.push(city)
  }
  return out
}

/**
 * Coerce one supervisor frame into a `gascity_messages` row and
 * persist it through `ctx.storage.appendRows`. The schema is the
 * subset surfaced by `dataset.js`; missing optional fields land as
 * `null` (the writer fills the column nullable-default for us).
 *
 * @param {PluginActivationContext} ctx
 * @param {GascityFrame} frame
 * @param {{ rowsWritten: number, lastError: string | undefined }} state
 * @param {PluginLogger} log
 */
async function writeFrame(ctx, frame, state, log) {
  try {
    const tablePath = gascityTablePath(ctx.storage)
    const row = {
      city: frame.city,
      provider_session_id: frame.provider_session_id,
      event_time: frame.event_time,
      event_kind: frame.event_kind,
      template: frame.template,
      content_text: frame.content_text,
      metadata: frame.metadata,
    }
    await ctx.storage.appendRows(tablePath, [...GASCITY_SCHEMA_COLUMNS], [row])
    state.rowsWritten += 1
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    state.lastError = message
    log.error('gascity.frame_write_failed', { city: frame.city, error: message })
  }
}
