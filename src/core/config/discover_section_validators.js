// @ts-check

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Attr, getLogger } from '../observability/index.js'
import { createConfigRegistry } from './schema.js'

/**
 * @import { ConfigRegistry, ConfigSectionRegistration, PluginName } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { LoadedManifest } from '../types.d.ts'
 */

/**
 * Discover the per-plugin `config_sections` validators a set of plugins
 * expose, WITHOUT activating them. A plugin opts in by exporting a
 * `configSection` (`{ section, validate }`) from its manifest entrypoint —
 * the same registration it hands `ctx.configRegistry.registerSection` at
 * activation, surfaced as a side-effect-free export.
 *
 * Why not just run `activate()`? Because activation is unsafe to run
 * ad-hoc: a plugin's `activate()` can mutate module-global singletons that
 * the *live* process shares (e.g. `@hypaware/ai-gateway`'s
 * `setAiGatewayRuntime`), so re-running it outside a real boot would corrupt
 * the running daemon. Importing a module to read an export runs only its
 * top-level code (which boot imports anyway) and never `activate()`.
 *
 * Used by the apply path so a central config that *introduces* a
 * backfill-capable plugin (e.g. `@hypaware/claude`) has its `config.backfill`
 * block validated even though that plugin isn't active yet — closing the gap
 * where the live registry only carries validators for already-active plugins
 * (LLP 0037).
 *
 * Best-effort: an entrypoint that can't be imported, or that exports no
 * `configSection`, contributes nothing and is logged but never throws —
 * discovery must never fail an apply on its own; real activation at the next
 * boot remains the backstop.
 *
 * @param {{ manifests: LoadedManifest[] }} args
 * @returns {Promise<ConfigRegistry>}
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements] — discover the owning plugin's `backfill` validator for not-yet-active plugins, side-effect-free
 */
export async function discoverConfigSectionValidators({ manifests }) {
  const registry = createConfigRegistry()
  const log = getLogger('config')

  for (const entry of manifests) {
    // Only import plugins that declare a config section in their manifest.
    // This keeps discovery from importing entrypoints that can't contribute
    // a validator anyway.
    const declared = entry.manifest.contributes?.config_sections
    if (!Array.isArray(declared) || declared.length === 0) continue

    try {
      const abs = path.resolve(entry.rootDir, entry.manifest.entrypoint)
      const mod = await import(pathToFileURL(abs).href)
      for (const reg of exportedSections(mod)) {
        registry.registerSection({
          plugin: /** @type {PluginName} */ (entry.manifest.name),
          section: reg.section,
          validate: reg.validate,
        })
      }
    } catch (err) {
      log.warn('config.section_discovery_failed', {
        [Attr.COMPONENT]: 'config',
        [Attr.PLUGIN]: entry.manifest.name,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return registry
}

/**
 * Pull the validator registration(s) a plugin entrypoint exports. Accepts a
 * single `configSection` or an array `configSections`; ignores malformed
 * shapes so a typo in a plugin export can never crash discovery.
 *
 * @param {Record<string, unknown>} mod
 * @returns {Array<{ section: string, validate: ConfigSectionRegistration['validate'] }>}
 */
function exportedSections(mod) {
  /** @type {Array<{ section: string, validate: ConfigSectionRegistration['validate'] }>} */
  const out = []
  const candidates = [
    mod.configSection,
    ...(Array.isArray(mod.configSections) ? mod.configSections : []),
  ]
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const reg = /** @type {Record<string, unknown>} */ (c)
    if (typeof reg.section === 'string' && reg.section.length > 0 && typeof reg.validate === 'function') {
      out.push({
        section: reg.section,
        validate: /** @type {ConfigSectionRegistration['validate']} */ (reg.validate),
      })
    }
  }
  return out
}
