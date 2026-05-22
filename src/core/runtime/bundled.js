// @ts-check

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifests } from '../manifest.js'

/** @typedef {import('../manifest.js').LoadedManifest} LoadedManifest */
/** @typedef {import('../manifest.js').FailedManifest} FailedManifest */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginName} PluginName */

/**
 * V1 bundled plugin allowlist (finish-v1.md §Phase 2). A plugin must
 * appear here to be discoverable through the default boot path. The
 * allowlist exists so the V1 default install does not pull
 * `@hypaware/central` or `@hypaware/gascity` into the picker, the
 * default config, or the V1 smokes — both remain on disk for
 * developers but are excluded from V1 acceptance gates.
 *
 * @type {ReadonlySet<PluginName>}
 */
export const V1_BUNDLED_PLUGIN_ALLOWLIST = new Set(/** @type {PluginName[]} */ ([
  '@hypaware/ai-gateway',
  '@hypaware/otel',
  '@hypaware/claude',
  '@hypaware/codex',
  '@hypaware/local-fs',
  '@hypaware/s3',
  '@hypaware/format-parquet',
  '@hypaware/format-jsonl',
  '@hypaware/format-iceberg',
]))

/**
 * Bundled plugins present in the repo workspace but excluded from the
 * V1 default surface. They remain loadable for developers (via
 * explicit manifest discovery) but never appear in the V1 picker,
 * default configs, V1 docs, or V1 smokes.
 *
 * @type {ReadonlySet<PluginName>}
 */
export const V1_EXCLUDED_FROM_DEFAULT = new Set(/** @type {PluginName[]} */ ([
  '@hypaware/central',
  '@hypaware/gascity',
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
 * @typedef {Object} DiscoverBundledResult
 * @property {LoadedManifest[]} loaded         Manifests inside the V1 allowlist.
 * @property {FailedManifest[]} failed         Manifests that failed to parse.
 * @property {LoadedManifest[]} excluded       Loadable but excluded from V1 default surface.
 * @property {string[]} unknownDirs            Directories with manifests not in the allowlist or excluded set.
 */

/**
 * Walk `workspaceDir` and split discovered plugin manifests into:
 *
 *  - `loaded`    — manifests whose `name` is in the V1 allowlist.
 *  - `excluded`  — manifests whose `name` is in the V1 exclude set
 *                  (`@hypaware/central`, `@hypaware/gascity`). These
 *                  remain available for developers but are not surfaced
 *                  by the default boot path.
 *  - `unknownDirs` — directories that hold a parseable manifest under
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
