// @ts-check

import { createHash } from 'node:crypto'

import { Attr, getLogger, withSpan } from './observability/index.js'
import { createCapabilityRegistry } from './registry/capabilities.js'
import { matchesSemverRange } from './semver.js'

/**
 * @import { PluginManifest } from '../../hypaware-plugin-kernel-types.js'
 * @import { DepGraphResolution, UnsatisfiedRequirement } from '../../src/core/types.js'
 * @import { CapabilityRegistryHandle } from '../../src/core/registry/types.js'
 */

/**
 * Resolve a topological activation order over a set of loaded plugin
 * manifests, taking `requires.plugins` and `requires.capabilities`
 * into account. Emits a `dep_graph.resolve` span with kernel-boot
 * attributes, a `dep_graph.reject` log per rejected plugin, and a
 * `dep_graph.capability_skipped` warning per dropped malformed
 * `provides.capabilities` pair.
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
            // This detail is the only place `depName` reaches `hyp status`,
            // which parses it back out (`requiredPluginFromMessage` in
            // `daemon/boot_failure.js`) to route the repair to the config
            // layer owning the name. Reword it and that repair silently
            // falls back to naming the local file.
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
          // The manifest validator constrains `provides.capabilities` to a map
          // of strings but not to non-empty ones, so a manifest it accepts can
          // carry a pair `provide` refuses (issue #1559). `bootKernel` does not
          // catch a throw from here, so that refusal would cost the whole boot
          // rather than the plugin that wrote the declaration. A declaration
          // naming no capability provides nothing to arbitrate over, so it is
          // skipped: registering it made two plugins that each declared `''`
          // clash with each other over the empty name.
          if (capName === '' || version === '') {
            // `warn`, not the `dep_graph.reject` the other eliminations emit:
            // nothing is rejected here, the plugin that wrote the declaration
            // still activates. The cost falls on someone else, the consumer
            // that required the capability and is reported with `cap_missing`,
            // so a silent skip leaves the report naming only that innocent
            // plugin (issue #1870).
            reportSkippedCapability(m.name, capName, version)
            continue
          }
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
 * Say that a malformed `provides.capabilities` pair was dropped, on a channel
 * an install with no telemetry configured still has.
 *
 * Through the stderr mirror rather than `dep_graph`'s own logger, because the
 * whole symptom of the skip is an absence: the provider activates, the
 * registry never hears the capability, and all the operator is shown is the
 * consumer eliminated with `cap_missing`. With neither `HYP_DEV_TELEMETRY` nor
 * `OTEL_EXPORTER_OTLP_ENDPOINT` set there is no logger provider, so the record
 * was built and dropped and the name of the plugin that wrote the declaration
 * reached nobody (issue #1889).
 *
 * Not the daemon file log `recordFailedPlugins` writes, the other channel a
 * shipped install keeps: that one reports a plugin that did not come up, and
 * this plugin does come up. It would also reach a daemon boot only, while
 * dependency resolution runs in every process that boots the kernel.
 *
 * Guarded because a diagnostic may cost itself and never the thing it comments
 * on: the mirror's `process.stderr.write` is the one step of the emit that is
 * not already contained, and a throw escaping it would cost the boot.
 *
 * @ref LLP 0362#absence-not-refusal [implements]: the site refuses nothing and its symptom is only the absence, so it takes the mirror.
 * @param {string} plugin the manifest that declared the pair
 * @param {string} capName the declared capability name, possibly empty
 * @param {string} version the declared version, possibly empty
 */
function reportSkippedCapability(plugin, capName, version) {
  try {
    getLogger('dep_graph', { mirrorStderr: true }).warn('dep_graph.capability_skipped', {
      [Attr.PLUGIN]: plugin,
      [Attr.CAPABILITY]: capName,
      hyp_capability_version: version,
      [Attr.ERROR_KIND]: 'cap_malformed',
    })
  } catch { /* the channel that would carry the report is the thing that failed; the skip stands */ }
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
