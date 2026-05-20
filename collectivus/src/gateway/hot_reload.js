/**
 * @import { CollectivusConfig, ListenerFactory, StartedListener } from '../types.js'
 * @import { ConfigDiff, ReloadableListener, SectionStatus } from './types.d.ts'
 */

/**
 * Sections compared by `diffConfig`. The first three (`otel`, `proxy`, `sink`)
 * cover the listener footprint a gateway can hot-reload; `upload` covers the
 * scheduler. The poll loop, identity client, control-plane server, and
 * self-update timer are deliberately NOT diffed: restarting them on a
 * config-pull would either thrash the source-of-truth (config poll) or fight
 * with credentials established at boot (identity).
 *
 * @type {readonly ['otel', 'proxy', 'sink', 'upload']}
 */
export const HOT_RELOAD_SECTIONS = Object.freeze(['otel', 'proxy', 'sink', 'upload'])

/**
 * Compare the four hot-reloadable sections of two configs. Deep equality is
 * structural (JSON-shape), which is sufficient for `CollectivusConfig` —
 * configs hold only plain objects, arrays, strings, and numbers.
 *
 * @param {CollectivusConfig} oldCfg
 * @param {CollectivusConfig} newCfg
 * @returns {ConfigDiff}
 */
export function diffConfig(oldCfg, newCfg) {
  return {
    otel: sectionStatus(oldCfg.otel, newCfg.otel),
    proxy: sectionStatus(oldCfg.proxy, newCfg.proxy),
    sink: sectionStatus(oldCfg.sink, newCfg.sink),
    upload: sectionStatus(oldCfg.upload, newCfg.upload),
  }
}

/**
 * @param {unknown} oldVal
 * @param {unknown} newVal
 * @returns {SectionStatus}
 */
function sectionStatus(oldVal, newVal) {
  const had = oldVal !== undefined
  const has = newVal !== undefined
  if (!had && !has) return 'unchanged'
  if (!had && has) return 'added'
  if (had && !has) return 'removed'
  return deepEqual(oldVal, newVal) ? 'unchanged' : 'changed'
}

/**
 * Structural deep-equality for JSON-shaped values. Returns false for any
 * non-JSON value type (functions, symbols, Maps, Dates) — fine for
 * `CollectivusConfig`, which holds none of those.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const aRec = /** @type {Record<string, unknown>} */ (a)
  const bRec = /** @type {Record<string, unknown>} */ (b)
  const aKeys = Object.keys(aRec)
  const bKeys = Object.keys(bRec)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, k)) return false
    if (!deepEqual(aRec[k], bRec[k])) return false
  }
  return true
}

/**
 * Apply a config diff to a running listener registry. Stops affected
 * listeners and starts replacements built from `newCfg`. Mutates `registry`
 * in place.
 *
 * Section semantics:
 *   - `otel`, `proxy`, `upload` restart when their own section differs OR
 *     when the shared `sink` section differs (each owns/uses a `FileSink`
 *     rooted at `sink.dir`).
 *   - `sink` itself has no listener — its diff entry is a trigger only.
 *
 * Failure modes — must NOT crash the gateway:
 *   - New factory throws → log to stderr; if start-before-stop succeeded
 *     for an earlier section, that section keeps running. For
 *     network-section restarts where the listen address differs we try
 *     start-before-stop so a bind failure leaves the previous listener
 *     bound; for same-address restarts we stop-then-start (the old
 *     listener has to release the port first) and the section ends up
 *     empty until the next config-changed event arrives.
 *   - Old `stop()` throws → log; continue (best-effort drain).
 *
 * @param {ConfigDiff} diff
 * @param {CollectivusConfig} oldCfg
 * @param {CollectivusConfig} newCfg
 * @param {Map<string, StartedListener>} registry
 * @param {(cfg: CollectivusConfig) => Map<string, ListenerFactory>} factoryBuilder
 * @param {{ stdout?: { write(s: string): void }, stderr?: { write(s: string): void } }} [opts]
 * @returns {Promise<void>}
 */
export async function applyDiff(diff, oldCfg, newCfg, registry, factoryBuilder, opts = {}) {
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr

  const sectionsToRestart = computeSectionsToRestart(diff, oldCfg, newCfg)
  if (sectionsToRestart.size === 0) return

  /** @type {Map<string, ListenerFactory>} */
  let newFactories
  try {
    newFactories = factoryBuilder(newCfg)
  } catch (err) {
    // factoryBuilder is not expected to throw — if it does, we have no
    // path to a new config and the old listeners stay running. Log loud.
    stderr.write(`hot reload: failed to build new factories: ${formatError(err)}\n`)
    return
  }

  for (const section of sectionsToRestart) {
    await restartSection(section, oldCfg, newCfg, registry, newFactories, stdout, stderr)
  }
}

/**
 * @param {ConfigDiff} diff
 * @param {CollectivusConfig} oldCfg
 * @param {CollectivusConfig} newCfg
 * @returns {Set<ReloadableListener>}
 */
function computeSectionsToRestart(diff, oldCfg, newCfg) {
  /** @type {Set<ReloadableListener>} */
  const out = new Set()
  if (diff.otel !== 'unchanged') out.add('otel')
  if (diff.proxy !== 'unchanged') out.add('proxy')
  if (diff.upload !== 'unchanged') out.add('upload')
  if (diff.sink !== 'unchanged') {
    if (oldCfg.otel || newCfg.otel) out.add('otel')
    if (oldCfg.proxy || newCfg.proxy) out.add('proxy')
    if (oldCfg.upload || newCfg.upload) out.add('upload')
  }
  return out
}

/**
 * Restart a single section. For the network sections (otel/proxy) we try
 * start-before-stop when the listen address differs so a bind failure on
 * the new listener doesn't take the section down. For same-address
 * restarts the old listener has to release the port first, so we
 * stop-then-start; if the new bind also fails we log loud and the section
 * stays empty until the next config-changed event.
 *
 * @param {ReloadableListener} section
 * @param {CollectivusConfig} oldCfg
 * @param {CollectivusConfig} newCfg
 * @param {Map<string, StartedListener>} registry
 * @param {Map<string, ListenerFactory>} newFactories
 * @param {{ write(s: string): void }} stdout
 * @param {{ write(s: string): void }} stderr
 * @returns {Promise<void>}
 */
async function restartSection(section, oldCfg, newCfg, registry, newFactories, stdout, stderr) {
  const oldListener = registry.get(section)
  const newFactory = newFactories.get(section)

  if (!newFactory) {
    if (oldListener) {
      await safeStop(section, oldListener, stderr)
      registry.delete(section)
      stdout.write(`hot reload: ${section} stopped\n`)
    }
    return
  }

  if (!oldListener) {
    try {
      const newListener = await newFactory()
      registry.set(section, newListener)
      stdout.write(`hot reload: ${section} started — ${newListener.description}\n`)
    } catch (err) {
      stderr.write(`hot reload: failed to start new ${section}: ${formatError(err)}\n`)
    }
    return
  }

  if (canSwap(section, oldCfg, newCfg)) {
    /** @type {StartedListener} */
    let newListener
    try {
      newListener = await newFactory()
    } catch (err) {
      stderr.write(`hot reload: failed to start new ${section}, keeping old: ${formatError(err)}\n`)
      return
    }
    await safeStop(section, oldListener, stderr)
    registry.set(section, newListener)
    stdout.write(`hot reload: ${section} restarted — ${newListener.description}\n`)
    return
  }

  // Same listen address — must release the port before binding the new
  // listener. Brief unavailability window between stop and start.
  await safeStop(section, oldListener, stderr)
  registry.delete(section)
  try {
    const newListener = await newFactory()
    registry.set(section, newListener)
    stdout.write(`hot reload: ${section} restarted — ${newListener.description}\n`)
  } catch (err) {
    stderr.write(`hot reload: failed to start new ${section} after stopping old: ${formatError(err)}\n`)
  }
}

/**
 * @param {ReloadableListener} section
 * @param {CollectivusConfig} oldCfg
 * @param {CollectivusConfig} newCfg
 * @returns {boolean}
 */
function canSwap(section, oldCfg, newCfg) {
  if (section === 'otel') return oldCfg.otel?.listen !== newCfg.otel?.listen
  if (section === 'proxy') return oldCfg.proxy?.listen !== newCfg.proxy?.listen
  return true
}

/**
 * @param {string} section
 * @param {StartedListener} listener
 * @param {{ write(s: string): void }} stderr
 * @returns {Promise<void>}
 */
async function safeStop(section, listener, stderr) {
  try {
    await listener.stop()
  } catch (err) {
    stderr.write(`hot reload: error stopping ${section}: ${formatError(err)}\n`)
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return `${err.code}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
