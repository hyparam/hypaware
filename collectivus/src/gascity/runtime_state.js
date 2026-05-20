import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * @import { GascityRuntimeState, GascityRuntimeCity, GascityRuntimeSession } from './types.d.ts'
 * @typedef {object} InternalCityEntry
 * @property {string} name
 * @property {string} api_url
 * @property {boolean} lifecycle_connected
 * @property {string} [lifecycle_last_event_at]
 * @property {Map<string, GascityRuntimeSession>} sessions
 * @property {number} frames_total
 */

const SCHEMA_VERSION = 1

/**
 * Swallow a value so a `.catch(noop)` doesn't add a typed handler. We
 * declare it with an explicit `void` return type so `noImplicitAny`
 * doesn't reject the implicit any inferred from `() => undefined`.
 *
 * @returns {void}
 */
function noop() { /* swallow */ }

/**
 * Mutable, in-memory snapshot of the gascity source's live state. The
 * supervisor subscriber + session worker emit small updates as things
 * change; the writer aggregates them and serialises a JSON snapshot to
 * disk via `flush()` so the `ctvs gascity list / status` commands can
 * render an up-to-date view without a control-channel round trip.
 *
 * Writes are atomic (tmp + rename). The file is overwritten in full on
 * every flush — gascity state is small (one entry per city + one entry
 * per active session) so partial-update plumbing isn't worth the
 * complexity.
 */
export class GascityRuntimeStateWriter {
  /**
   * @param {{
   *   path: string,
   *   now?: () => Date,
   *   flushIntervalMs?: number,
   * }} opts
   *   `now` is overridable so tests can drive deterministic timestamps;
   *   `flushIntervalMs` debounces clusters of updates that arrive within
   *   the same tick (e.g. ten lifecycle events in one SSE batch produce
   *   a single disk write rather than ten).
   */
  constructor(opts) {
    /** @type {string} */
    this.path = opts.path
    /** @type {() => Date} */
    this.now = opts.now ?? (() => new Date())
    /** @type {number} */
    this.flushIntervalMs = opts.flushIntervalMs ?? 250
    /** @type {Map<string, InternalCityEntry>} */
    this.cities = new Map()
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined
    /** @type {Promise<void>} */
    this.inFlight = Promise.resolve()
    /** @type {boolean} */
    this.dirty = false
    /** @type {boolean} */
    this.stopped = false
  }

  /**
   * Register or replace the static fields for a city. Called once on
   * supervisor boot; preserves any per-session entries already recorded
   * (a hot reload that only changes filters shouldn't drop the running
   * session list).
   *
   * @param {{ name: string, api_url: string }} city
   * @returns {void}
   */
  upsertCity(city) {
    const existing = this.cities.get(city.name)
    if (existing) {
      existing.api_url = city.api_url
    } else {
      this.cities.set(city.name, {
        name: city.name,
        api_url: city.api_url,
        lifecycle_connected: false,
        sessions: new Map(),
        frames_total: 0,
      })
    }
    this.markDirty()
  }

  /**
   * Drop a city from the snapshot. Used when a `ctvs gascity detach`
   * removes the city from config — once the subscriber and writer have
   * retired its sessions we want it gone from `ctvs gascity list` too.
   *
   * @param {string} name
   * @returns {void}
   */
  removeCity(name) {
    if (this.cities.delete(name)) this.markDirty()
  }

  /**
   * Mark a city's lifecycle SSE as connected or disconnected. Reflected
   * in the `status` output so operators can tell at a glance whether the
   * subscriber has a live socket vs. is in the reconnect loop.
   *
   * @param {string} city
   * @param {boolean} connected
   * @returns {void}
   */
  setLifecycleConnected(city, connected) {
    const entry = this.cities.get(city)
    if (!entry) return
    entry.lifecycle_connected = connected
    if (connected) entry.lifecycle_last_event_at = this.now().toISOString()
    this.markDirty()
  }

  /**
   * Record a session as active. Called from `SupervisorSubscriber.spawnWorker`.
   * Idempotent — repeated calls update template/rig/alias but don't reset
   * the frame counter.
   *
   * @param {string} city
   * @param {{
   *   sessionId: string,
   *   template?: string | undefined,
   *   rig?: string | undefined,
   *   alias?: string | undefined,
   * }} info
   * @returns {void}
   */
  upsertSession(city, info) {
    const entry = this.cities.get(city)
    if (!entry) return
    const existing = entry.sessions.get(info.sessionId)
    if (existing) {
      if (info.template !== undefined) existing.template = info.template
      if (info.rig !== undefined) existing.rig = info.rig
      if (info.alias !== undefined) existing.alias = info.alias
      this.markDirty()
      return
    }
    /** @type {GascityRuntimeSession} */
    const session = {
      sessionId: info.sessionId,
      state: 'active',
      frames: 0,
      started_at: this.now().toISOString(),
    }
    if (info.template !== undefined) session.template = info.template
    if (info.rig !== undefined) session.rig = info.rig
    if (info.alias !== undefined) session.alias = info.alias
    entry.sessions.set(info.sessionId, session)
    this.markDirty()
  }

  /**
   * Bump the per-session frame counter. Called from
   * `SessionWorker.handleFrame` so `ctvs gascity list` can show capture
   * progress in real time.
   *
   * @param {string} city
   * @param {string} sessionId
   * @param {number} delta
   * @returns {void}
   */
  recordFrame(city, sessionId, delta = 1) {
    const entry = this.cities.get(city)
    if (!entry) return
    const session = entry.sessions.get(sessionId)
    if (!session) return
    session.frames += delta
    session.last_frame_at = this.now().toISOString()
    entry.frames_total += delta
    this.markDirty()
  }

  /**
   * Move a session into the `retired` state and stamp `retired_at`. Kept
   * in the snapshot briefly so a `list` immediately after `detach` can
   * show the worker winding down rather than just disappearing.
   *
   * @param {string} city
   * @param {string} sessionId
   * @returns {void}
   */
  retireSession(city, sessionId) {
    const entry = this.cities.get(city)
    if (!entry) return
    const session = entry.sessions.get(sessionId)
    if (!session) return
    session.state = 'retired'
    session.retired_at = this.now().toISOString()
    this.markDirty()
  }

  /**
   * Remove a retired session entirely. Called from a periodic sweep so
   * the snapshot doesn't grow unbounded across long-running daemons.
   *
   * @param {string} city
   * @param {string} sessionId
   * @returns {void}
   */
  forgetSession(city, sessionId) {
    const entry = this.cities.get(city)
    if (!entry) return
    if (entry.sessions.delete(sessionId)) this.markDirty()
  }

  /**
   * Force a write of the current snapshot to disk and resolve when the
   * tmp+rename completes. Bypasses the debounce timer and serialises
   * against any in-flight write so callers (e.g. supervisor stop) can
   * `await` a guaranteed-fresh snapshot.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.inFlight = this.inFlight
      .catch(noop)
      .then(() => this.writeSnapshot())
    await this.inFlight
  }

  /**
   * Stop accepting new updates and flush a final snapshot. After `stop`
   * resolves the file on disk reflects the writer's last in-memory state
   * and subsequent calls to mutators are silently ignored.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.flush()
  }

  /**
   * Build the on-disk snapshot from the in-memory state. Exposed for
   * tests; callers should normally use `flush()`.
   *
   * @returns {GascityRuntimeState}
   */
  snapshot() {
    /** @type {GascityRuntimeState} */
    const out = {
      schema_version: SCHEMA_VERSION,
      updated_at: this.now().toISOString(),
      cities: [],
    }
    for (const city of this.cities.values()) {
      /** @type {GascityRuntimeCity} */
      const cityOut = {
        name: city.name,
        api_url: city.api_url,
        lifecycle_connected: city.lifecycle_connected,
        sessions: [],
        frames_total: city.frames_total,
      }
      if (city.lifecycle_last_event_at !== undefined) cityOut.lifecycle_last_event_at = city.lifecycle_last_event_at
      for (const session of city.sessions.values()) {
        cityOut.sessions.push({ ...session })
      }
      // Stable order so consumers (CLI tables, JSON snapshots) don't
      // shuffle on every poll.
      cityOut.sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      out.cities.push(cityOut)
    }
    out.cities.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /**
   * @returns {void}
   * @private
   */
  markDirty() {
    if (this.stopped) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(/** @type {() => void} */ (() => {
      this.timer = undefined
      this.inFlight = this.inFlight
        .catch(noop)
        .then(() => this.writeSnapshot())
      // Errors are swallowed in writeSnapshot; the next mutation will retry.
    }), this.flushIntervalMs)
    // Don't keep the daemon alive solely on a pending state-file write.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async writeSnapshot() {
    if (!this.dirty) return
    this.dirty = false
    const snap = this.snapshot()
    const body = `${JSON.stringify(snap)}\n`
    const dir = path.dirname(this.path)
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${this.path}.tmp.${process.pid}`
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(body)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, this.path)
  }
}

/**
 * Read the gascity runtime state snapshot from disk. Returns `undefined`
 * when the file is missing (no daemon is running, or the source has not
 * yet flushed its first snapshot). Parse failures and other I/O errors
 * are surfaced to the caller so the CLI can render a clear "snapshot
 * unreadable" error rather than silently empty results.
 *
 * @param {string} statePath
 * @returns {Promise<GascityRuntimeState | undefined>}
 */
export async function readRuntimeState(statePath) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(statePath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return undefined
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`gascity state file ${statePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`gascity state file ${statePath} must be a JSON object`)
  }
  return /** @type {GascityRuntimeState} */ (parsed)
}

export const GASCITY_STATE_SCHEMA_VERSION = SCHEMA_VERSION
