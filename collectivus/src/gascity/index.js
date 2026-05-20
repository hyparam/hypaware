import { backfillCity } from './backfill.js'
import { NormalizerDispatcher } from './normalizer_dispatcher.js'
import { registerProductionNormalizers } from './normalizers/index.js'
import { ParquetWriter } from './parquet_writer.js'
import { defaultGascityRoot } from './paths.js'
import { GascityRuntimeStateWriter } from './runtime_state.js'
import { defaultGascityStatePath } from '../runtime/paths.js'
import { SupervisorSubscriber } from './supervisor_subscriber.js'

/**
 * @import { GascityCityConfig } from './types.d.ts'
 * @import { StartedListener } from '../types.js'
 */

/**
 * Extension of `StartedListener` returned by `startGascitySource`. The base
 * `description` / `stop()` shape satisfies the listener registry; the extra
 * `applyCityDiff` method lets the SIGHUP-driven hot-reload path mutate the
 * set of attached cities without taking the whole source down (which would
 * unnecessarily retire every city's sessions when only one city changed).
 *
 * Tests can also reach into `subscribers` to assert on per-city state.
 *
 * @typedef {StartedListener & {
 *   applyCityDiff: (newCities: GascityCityConfig[]) => Promise<void>,
 *   subscribers: () => Map<string, SupervisorSubscriber>,
 *   stateWriter: GascityRuntimeStateWriter,
 * }} GascityListener
 */

/**
 * Stand the gascity source up. Returns a `GascityListener` that fits straight
 * into `runLifecycle`'s registry — `description` for the boot log, `stop` for
 * graceful shutdown that drains every active session worker and flushes the
 * writer.
 *
 * The factory takes the array of configured cities so the daemon can run
 * multiple supervisors concurrently. Each city gets its own
 * `SupervisorSubscriber`; they share the dispatcher and writer (provider
 * normalizers are a process-wide registry and the writer keeps per-session
 * buffers internally).
 *
 * On startup the factory triggers a one-shot backfill per configured city
 * for every non-retired cursor it finds on disk. Backfill failures are
 * logged but never thrown — they must not stop the live SSE tail from
 * coming up.
 *
 * Empty `cities` is a documented no-op: the listener starts cleanly so a
 * config that only enables the gascity section without attaching cities yet
 * still satisfies `factories.size > 0` if the operator has otherwise wired
 * other listeners.
 *
 * @param {{
 *   cities: GascityCityConfig[],
 *   sinkRoot?: string,
 *   stderr?: { write: (s: string) => void },
 *   debug?: boolean,
 *   fetchFn?: typeof fetch,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   flushRows?: number,
 *   flushIntervalMs?: number,
 *   dedupLimit?: number,
 *   skipBackfill?: boolean,
 *   statePath?: string,
 *   stateWriter?: GascityRuntimeStateWriter,
 * }} opts
 * @returns {Promise<GascityListener>}
 */
export async function startGascitySource(opts) {
  const stderr = opts.stderr ?? process.stderr
  const sinkRoot = opts.sinkRoot ?? defaultGascityRoot()
  const debug = opts.debug ?? isDebugEnabled()

  /** @type {ConstructorParameters<typeof ParquetWriter>[0]} */
  const writerOpts = { sinkRoot, stderr }
  if (opts.flushRows !== undefined) writerOpts.flushRows = opts.flushRows
  if (opts.flushIntervalMs !== undefined) writerOpts.flushIntervalMs = opts.flushIntervalMs
  if (opts.dedupLimit !== undefined) writerOpts.dedupLimit = opts.dedupLimit
  const writer = new ParquetWriter(writerOpts)

  const dispatcher = new NormalizerDispatcher({ stderr, writer })
  registerProductionNormalizers(dispatcher)

  const stateWriter = opts.stateWriter ?? new GascityRuntimeStateWriter({
    path: opts.statePath ?? defaultGascityStatePath(),
  })

  /** @type {Map<string, SupervisorSubscriber>} */
  const subscribers = new Map()
  for (const city of opts.cities) {
    const subscriber = buildSubscriber(city, {
      sinkRoot,
      dispatcher,
      writer,
      stateWriter,
      stderr,
      debug,
      fetchFn: opts.fetchFn,
      sleep: opts.sleep,
    })
    subscriber.start()
    subscribers.set(city.name, subscriber)
  }
  // Snapshot the initial city list immediately so a `ctvs gascity list`
  // run between attach and the first lifecycle event can still see the
  // newly attached city.
  await stateWriter.flush()

  if (!opts.skipBackfill) {
    for (const city of opts.cities) {
      runBackfill(city)
    }
  }

  /** @type {GascityListener} */
  const listener = {
    description: opts.cities.length === 0
      ? 'Gascity source: no cities attached'
      : `Gascity source attached to ${opts.cities.length} ${opts.cities.length === 1 ? 'city' : 'cities'} (${opts.cities.map((c) => c.name).join(', ')}); sink ${sinkRoot}`,
    stop: async () => {
      await Promise.all(Array.from(subscribers.values()).map((s) => s.stop()))
      subscribers.clear()
      await dispatcher.drain()
      await writer.stop()
      await stateWriter.stop()
    },
    applyCityDiff: async (newCities) => {
      const seen = new Set()
      /** @type {Promise<void>[]} */
      const additions = []
      for (const city of newCities) {
        seen.add(city.name)
        const existing = subscribers.get(city.name)
        if (existing && cityConfigEqual(existing.city, city)) continue
        if (existing) {
          // City reconfigured (api_url or filters changed) — retire and replace
          // so the new connection picks up the new URL / template filters.
          await existing.stop({ removeFromState: false })
        }
        const replacement = buildSubscriber(city, {
          sinkRoot,
          dispatcher,
          writer,
          stateWriter,
          stderr,
          debug,
          fetchFn: opts.fetchFn,
          sleep: opts.sleep,
        })
        replacement.start()
        subscribers.set(city.name, replacement)
        additions.push(Promise.resolve())
      }
      // Stop subscribers for cities no longer in the config and clear them
      // from the runtime-state snapshot so `ctvs gascity list` immediately
      // reflects the detach.
      /** @type {Promise<void>[]} */
      const removals = []
      for (const [name, subscriber] of subscribers) {
        if (seen.has(name)) continue
        removals.push((async () => {
          await subscriber.stop({ removeFromState: true })
          subscribers.delete(name)
        })())
      }
      await Promise.all([...additions, ...removals])
      await stateWriter.flush()
      // Run backfill for newly added cities — but only those, otherwise we
      // re-poll already-live sessions for unchanged cities and waste a
      // round trip per non-retired cursor.
      if (!opts.skipBackfill) {
        for (const city of newCities) {
          if (subscribers.has(city.name)) {
            // The replacement (or fresh) subscriber owns this city now;
            // backfill is safe regardless because the writer's dedup set
            // collapses any overlap with the live SSE tail.
            runBackfill(city)
          }
        }
      }
    },
    subscribers: () => subscribers,
    stateWriter,
  }
  return listener

  /**
   * Run a one-shot backfill for `city` against its supervisor. Closure-bound
   * over the shared infra so callers don't have to re-thread `dispatcher` /
   * `sinkRoot` / `stderr` on every call. The backfill rejects only via
   * stderr — the listener factory must not fail because a transient
   * supervisor outage at startup blocked a backfill request.
   *
   * @param {GascityCityConfig} city
   * @returns {void}
   */
  function runBackfill(city) {
    /** @type {Parameters<typeof backfillCity>[0]} */
    const backfillOpts = {
      city,
      sinkRoot,
      dispatcher,
      stderr,
      debug,
    }
    if (opts.fetchFn) backfillOpts.fetchFn = opts.fetchFn
    backfillCity(backfillOpts).catch((err) => {
      stderr.write(`[gascity] backfill_unhandled city=${city.name} err=${formatError(err)}\n`)
    })
  }
}

/**
 * Build a `SupervisorSubscriber` with the shared infra wired in. Factored
 * out so both initial spin-up and `applyCityDiff` go through the same
 * argument shape — adding a new dependency only needs one edit.
 *
 * @param {GascityCityConfig} city
 * @param {{
 *   sinkRoot: string,
 *   dispatcher: NormalizerDispatcher,
 *   writer: ParquetWriter,
 *   stateWriter: GascityRuntimeStateWriter,
 *   stderr: { write: (s: string) => void },
 *   debug: boolean,
 *   fetchFn?: typeof fetch,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 * }} infra
 * @returns {SupervisorSubscriber}
 */
function buildSubscriber(city, infra) {
  /** @type {ConstructorParameters<typeof SupervisorSubscriber>[0]} */
  const subOpts = {
    city,
    sinkRoot: infra.sinkRoot,
    dispatcher: infra.dispatcher,
    writer: infra.writer,
    stateWriter: infra.stateWriter,
    stderr: infra.stderr,
    debug: infra.debug,
  }
  if (infra.fetchFn) subOpts.fetchFn = infra.fetchFn
  if (infra.sleep) subOpts.sleep = infra.sleep
  return new SupervisorSubscriber(subOpts)
}

/**
 * Whether two `GascityCityConfig`s differ in a field the subscriber cares
 * about. Includes filter arrays so a config rewrite that changes
 * include/exclude tabs doesn't silently keep the old filters running.
 *
 * @param {GascityCityConfig} a
 * @param {GascityCityConfig} b
 * @returns {boolean}
 */
function cityConfigEqual(a, b) {
  if (a.name !== b.name) return false
  if (a.api_url !== b.api_url) return false
  if (!stringListEqual(a.include_templates, b.include_templates)) return false
  if (!stringListEqual(a.exclude_templates, b.exclude_templates)) return false
  return true
}

/**
 * @param {string[] | undefined} a
 * @param {string[] | undefined} b
 * @returns {boolean}
 */
function stringListEqual(a, b) {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Whether `[gascity]` debug log lines should land on stderr. Off by default
 * to keep the daemon's log volume in line with the proxy/OTLP sources;
 * operators flip `COLLECTIVUS_DEBUG_GASCITY=1` when iterating on integration
 * with a new supervisor.
 *
 * @returns {boolean}
 */
function isDebugEnabled() {
  const value = process.env.COLLECTIVUS_DEBUG_GASCITY
  return typeof value === 'string' && value.length > 0 && value !== '0'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
