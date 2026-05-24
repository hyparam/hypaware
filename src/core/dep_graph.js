// @ts-check

import { createHash } from 'node:crypto'

import { Attr, getLogger, withSpan } from './observability/index.js'
import { createCapabilityRegistry } from './registry/capabilities.js'
import { matchesSemverRange } from './semver.js'

/**
 * @import { PluginManifest, PluginName } from '../../collectivus-plugin-kernel-types'
 * @import { DepGraphResolution, UnsatisfiedRequirement } from './dep_graph.d.ts'
 * @import { CapabilityRegistryHandle } from './registry/capabilities.d.ts'
 */

/**
 * Resolve a topological activation order over a set of loaded plugin
 * manifests, taking `requires.plugins` and `requires.capabilities`
 * into account. Emits a `dep_graph.resolve` span with kernel-boot
 * attributes and a `dep_graph.reject` log per rejected plugin.
 *
 * Cycle detection runs before capability resolution: a plugin in a
 * cycle never gets a chance to provide or require capabilities.
 * Capability requires drain through `registry.require()` which emits
 * the `cap.require_satisfied` / `cap.require_missing` events that
 * downstream queries assert against.
 *
 * @param {PluginManifest[]} manifests
 * @param {{ registry?: CapabilityRegistryHandle }} [opts]
 * @returns {Promise<DepGraphResolution>}
 */
export async function resolveDependencies(manifests, opts = {}) {
  const registry = opts.registry ?? createCapabilityRegistry()
  const log = getLogger('dep_graph')

  return withSpan(
    'dep_graph.resolve',
    { [Attr.OPERATION]: 'dep_graph.resolve' },
    async (span) => {
      const byName = new Map(manifests.map((m) => [m.name, m]))
      /** @type {UnsatisfiedRequirement[]} */
      const unsatisfied = []
      /** @type {Set<string>} */
      const eliminated = new Set()

      for (const m of manifests) {
        const reqPlugins = m.requires?.plugins ?? {}
        for (const [depName, range] of Object.entries(reqPlugins)) {
          if (!byName.has(depName)) {
            recordReject(eliminated, unsatisfied, m.name, 'plugin_missing', `requires plugin ${depName}@${range}`)
            log.error('dep_graph.reject', {
              [Attr.PLUGIN]: m.name,
              [Attr.ERROR_KIND]: 'plugin_missing',
              hyp_required_plugin: depName,
              hyp_required_range: range,
            })
          }
        }
      }

      for (const name of detectCycles(manifests)) {
        if (eliminated.has(name)) continue
        recordReject(eliminated, unsatisfied, name, 'cycle', 'participates in a dependency cycle')
        log.error('dep_graph.reject', {
          [Attr.PLUGIN]: name,
          [Attr.ERROR_KIND]: 'cycle',
        })
      }

      for (const m of manifests) {
        if (eliminated.has(m.name)) continue
        const provides = m.provides?.capabilities ?? {}
        for (const [capName, version] of Object.entries(provides)) {
          registry.provide(m.name, capName, version, null)
        }
      }

      const providersByCap = new Map()
      for (const reg of registry.list()) {
        let set = providersByCap.get(reg.name)
        if (!set) { set = new Set(); providersByCap.set(reg.name, set) }
        set.add(reg.provider)
      }
      for (const [capName, providers] of providersByCap.entries()) {
        if (providers.size > 1) {
          const detail = `providers=${Array.from(providers).sort().join(',')}`
          for (const p of providers) {
            unsatisfied.push({ plugin: p, errorKind: 'cap_version_clash', detail: `capability=${capName} ${detail}` })
          }
          log.error('dep_graph.reject', {
            [Attr.CAPABILITY]: capName,
            [Attr.ERROR_KIND]: 'cap_version_clash',
            hyp_providers: Array.from(providers).sort().join(','),
          })
        }
      }

      const topo = toposort(manifests, eliminated)

      for (const name of topo) {
        const m = byName.get(name)
        if (!m) continue
        const reqCaps = m.requires?.capabilities ?? {}
        const reqPlugins = m.requires?.plugins ?? {}
        let pluginRangeOk = true
        for (const [depName, range] of Object.entries(reqPlugins)) {
          const dep = byName.get(depName)
          if (dep && !matchesSemverRange(dep.version, range)) {
            pluginRangeOk = false
            recordReject(eliminated, unsatisfied, m.name, 'plugin_missing', `${depName}@${dep.version} does not satisfy ${range}`)
            log.error('dep_graph.reject', {
              [Attr.PLUGIN]: m.name,
              [Attr.ERROR_KIND]: 'plugin_missing',
              hyp_required_plugin: depName,
              hyp_required_range: range,
              hyp_resolved_version: dep.version,
            })
            break
          }
        }
        if (!pluginRangeOk) continue
        for (const [capName, range] of Object.entries(reqCaps)) {
          try {
            registry.require(m.name, capName, range)
          } catch (err) {
            recordReject(eliminated, unsatisfied, m.name, 'cap_missing', `capability ${capName}@${range}`)
          }
        }
      }

      const finalOrder = topo.filter((n) => !eliminated.has(n))
      const resolveOrderHash = createHash('sha256').update(finalOrder.join('\n')).digest('hex').slice(0, 16)
      const capabilityCount = registry.list().length

      span.setAttribute('hyp_plugin_count', manifests.length)
      span.setAttribute('hyp_capability_count', capabilityCount)
      span.setAttribute('hyp_resolve_order_hash', resolveOrderHash)
      span.setAttribute('status', 'ok')

      return {
        order: finalOrder,
        unsatisfied,
        resolveOrderHash,
        pluginCount: manifests.length,
        capabilityCount,
        registry,
      }
    },
    { component: 'dep_graph' }
  )
}

/**
 * @param {Set<string>} eliminated
 * @param {UnsatisfiedRequirement[]} unsatisfied
 * @param {string} plugin
 * @param {UnsatisfiedRequirement['errorKind']} errorKind
 * @param {string} [detail]
 */
function recordReject(eliminated, unsatisfied, plugin, errorKind, detail) {
  eliminated.add(plugin)
  unsatisfied.push({ plugin, errorKind, detail })
}

/**
 * Iterative DFS cycle detection over `requires.plugins`. A back edge
 * onto a node currently on the stack flags every node between (and
 * including) the target and the current node as cyclic.
 *
 * @param {PluginManifest[]} manifests
 * @returns {Set<string>}
 */
function detectCycles(manifests) {
  /** @type {Set<string>} */
  const cyclic = new Set()
  const names = new Set(manifests.map((m) => m.name))
  /** @type {Map<string, string[]>} */
  const adj = new Map()
  for (const m of manifests) {
    const deps = Object.keys(m.requires?.plugins ?? {}).filter((d) => names.has(d))
    adj.set(m.name, deps)
  }
  const WHITE = 0, GRAY = 1, BLACK = 2
  /** @type {Map<string, number>} */
  const color = new Map()
  for (const n of adj.keys()) color.set(n, WHITE)

  /** @param {string} start */
  function dfs(start) {
    /** @type {{ node: string, idx: number }[]} */
    const stack = [{ node: start, idx: 0 }]
    color.set(start, GRAY)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const neighbors = adj.get(top.node) ?? []
      if (top.idx < neighbors.length) {
        const next = neighbors[top.idx++]
        const c = color.get(next)
        if (c === GRAY) {
          const path = stack.map((f) => f.node)
          const idx = path.indexOf(next)
          for (let i = idx; i < path.length; i++) cyclic.add(path[i])
        } else if (c === WHITE) {
          color.set(next, GRAY)
          stack.push({ node: next, idx: 0 })
        }
      } else {
        color.set(top.node, BLACK)
        stack.pop()
      }
    }
  }

  for (const n of adj.keys()) {
    if (color.get(n) === WHITE) dfs(n)
  }
  return cyclic
}

/**
 * Kahn's algorithm with deterministic tie-breaking by plugin name so a
 * second boot over the same manifests produces the same order hash.
 *
 * @param {PluginManifest[]} manifests
 * @param {Set<string>} eliminated
 */
function toposort(manifests, eliminated) {
  /** @type {Map<string, string[]>} */
  const adj = new Map()
  /** @type {Map<string, number>} */
  const indeg = new Map()
  /** @type {Set<string>} */
  const include = new Set()
  for (const m of manifests) if (!eliminated.has(m.name)) include.add(m.name)
  for (const n of include) indeg.set(n, 0)
  for (const m of manifests) {
    if (!include.has(m.name)) continue
    for (const dep of Object.keys(m.requires?.plugins ?? {})) {
      if (!include.has(dep)) continue
      let neighbors = adj.get(dep)
      if (!neighbors) { neighbors = []; adj.set(dep, neighbors) }
      neighbors.push(m.name)
      indeg.set(m.name, (indeg.get(m.name) ?? 0) + 1)
    }
  }
  /** @type {string[]} */
  const ready = []
  for (const [n, d] of indeg.entries()) if (d === 0) ready.push(n)
  ready.sort()
  /** @type {string[]} */
  const order = []
  while (ready.length) {
    const n = /** @type {string} */ (ready.shift())
    order.push(n)
    for (const next of adj.get(n) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) {
        ready.push(next)
        ready.sort()
      }
    }
  }
  return order
}
