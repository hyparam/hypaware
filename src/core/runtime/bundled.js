// @ts-check

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifests } from '../manifest.js'

/**
 * @import { PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { FailedManifest, LoadedManifest } from '../../../src/core/types.js'
 * @import { DiscoverBundledResult } from '../../../src/core/runtime/types.js'
 */

/**
 * V1 bundled plugin allowlist. A plugin must appear here to be
 * activated by the default boot profiles (`all-bundled`,
 * `all-available`). Excluded plugins (`@hypaware/central`,
 * `@hypaware/gascity`) are still discoverable through the plugin
 * catalog: their manifest contributions (datasets, client
 * descriptors, capability metadata) are visible to config validation
 * and the walkthrough. They are activatable via explicit config or
 * init presets; the allowlist only governs default activation.
 *
 * @type {ReadonlySet<PluginName>}
 */
export const V1_BUNDLED_PLUGIN_ALLOWLIST = new Set(/** @type {PluginName[]} */ ([
  '@hypaware/ai-gateway',
  '@hypaware/otel',
  '@hypaware/claude',
  '@hypaware/codex',
  '@hypaware/hermes',
  '@hypaware/openclaw',
  '@hypaware/local-fs',
  '@hypaware/s3',
  '@hypaware/format-parquet',
  '@hypaware/format-jsonl',
  '@hypaware/format-iceberg',
  '@hypaware/context-graph',
  '@hypaware/ai-gateway-graph',
]))

/**
 * Bundled plugins excluded from default activation. Their manifests
 * are still loaded by `discoverBundledPlugins` (in the `excluded`
 * bucket) so the plugin catalog can derive datasets, client
 * descriptors, and capability metadata for config validation.
 * Activation requires explicit config (`{ name: '@hypaware/gascity' }`)
 * or an init preset: the picker and default boot profiles skip them.
 *
 * The embedder/vector-search pair is excluded because enabling an
 * API-backed embedder is the explicit opt-in that lets captured text
 * leave the machine: it must be a deliberate `plugins[]` decision,
 * never a default. `@hypaware/vector-search` follows it: its manifest
 * requires `hypaware.embedder`, which no default-activated plugin
 * provides.
 *
 * The completion providers follow the same rule: enabling a model
 * backend lets captured content (prompts built from the graph + source)
 * leave the machine, so it is an explicit `plugins[]` choice. And
 * `@hypaware/context-graph-enrich` requires the completion + vector-search
 * capabilities (which no default-activated plugin provides) and spends on
 * model calls, so it too activates only via explicit config.
 *
 * @type {ReadonlySet<PluginName>}
 * @ref LLP 0024#embedding-is-a-separate-capability [constrained-by]: the embedder choice is an explicit plugins[] config decision, so neither plugin default-activates
 */
export const V1_EXCLUDED_FROM_DEFAULT = new Set(/** @type {PluginName[]} */ ([
  '@hypaware/central',
  '@hypaware/gascity',
  '@hypaware/embedder-openai',
  '@hypaware/vector-search',
  '@hypaware/completion-anthropic',
  '@hypaware/completion-openai',
  '@hypaware/context-graph-enrich',
]))

/**
 * Resolve the bundled plugins workspace directory shipped inside this
 * package. Walks up from the source file so the path is stable across
 * `npm pack` installs and dev checkouts.
 *
 * @returns {string}
 */
export function defaultBundledWorkspaceDir() {
  const here = fileURLToPath(import.meta.url)
  // src/core/runtime/bundled.js -> repo root -> hypaware-core/plugins-workspace
  const repoRoot = path.resolve(path.dirname(here), '..', '..', '..')
  return path.join(repoRoot, 'hypaware-core', 'plugins-workspace')
}


/**
 * Walk `workspaceDir` and split discovered plugin manifests into:
 *
 *  - `loaded` - manifests whose `name` is in the V1 allowlist.
 *  - `excluded` - manifests whose `name` is in the V1 exclude set
 *                  (`@hypaware/central`, `@hypaware/gascity`). These
 *                  are excluded from default activation but their
 *                  manifests feed the plugin catalog so datasets,
 *                  client descriptors, and capability metadata remain
 *                  visible to config validation and the walkthrough.
 *  - `unknownDirs` - directories that hold a parseable manifest under
 *                    a name the kernel doesn't recognise as bundled.
 *
 * Missing workspace directories return an empty result rather than
 * throwing so `npx hypaware --help` works from any directory.
 *
 * @param {object} [opts]
 * @param {string} [opts.workspaceDir]   Override the bundled workspace location.
 * @param {ReadonlySet<PluginName>} [opts.allowlist]
 * @param {ReadonlySet<PluginName>} [opts.excludeSet]
 * @returns {Promise<DiscoverBundledResult>}
 */
export async function discoverBundledPlugins(opts = {}) {
  const workspaceDir = opts.workspaceDir ?? defaultBundledWorkspaceDir()
  const allowlist = opts.allowlist ?? V1_BUNDLED_PLUGIN_ALLOWLIST
  const excludeSet = opts.excludeSet ?? V1_EXCLUDED_FROM_DEFAULT

  /** @type {string[]} */
  let dirEntries
  try {
    const { promises: fsp } = await import('node:fs')
    dirEntries = (await fsp.readdir(workspaceDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(workspaceDir, d.name))
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { loaded: [], failed: [], excluded: [], unknownDirs: [] }
    }
    throw err
  }

  const all = await loadManifests(dirEntries)

  /** @type {LoadedManifest[]} */
  const loaded = []
  /** @type {LoadedManifest[]} */
  const excluded = []
  /** @type {string[]} */
  const unknownDirs = []
  for (const entry of all.loaded) {
    const name = /** @type {PluginName} */ (entry.manifest.name)
    if (allowlist.has(name)) {
      loaded.push(entry)
    } else if (excludeSet.has(name)) {
      excluded.push(entry)
    } else {
      unknownDirs.push(entry.rootDir)
    }
  }

  return { loaded, failed: all.failed, excluded, unknownDirs }
}
