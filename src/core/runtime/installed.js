// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { loadLock } from '../plugin_install/install.js'
import { listEntries } from '../plugin_install/lock.js'
import { loadManifest } from '../manifest.js'

/**
 * @import { PluginLockEntry, PluginName } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { FailedManifest, LoadedManifest } from '../manifest.js'
 * @import { DiscoverInstalledResult } from './types.d.ts'
 */

/**
 * Walk the kernel state's `plugin-lock.json` and load the manifest from
 * every lock entry's `install_dir`. Mirrors `discoverBundledPlugins`
 * but skips the V1 allowlist — anything that landed in the lock is
 * user-installed and was reviewed at install time.
 *
 * Missing lock file → empty result. Per-entry manifest failures are
 * surfaced via `failed[]` (mirroring `loadManifests`) and additionally
 * logged as `plugin.installed_manifest_invalid` so boot diagnostics
 * carry the install_dir context the bare manifest log does not.
 *
 * @param {object} args
 * @param {string} args.stateDir
 * @returns {Promise<DiscoverInstalledResult>}
 */
export async function discoverInstalledPlugins({ stateDir }) {
  if (!stateDir) throw new Error('discoverInstalledPlugins: stateDir is required')

  const lock = await loadLock(stateDir)
  const entries = listEntries(lock)
  if (entries.length === 0) {
    return { loaded: [], failed: [], lockEntries: [] }
  }

  const log = getLogger('kernel')
  const results = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      result: await loadManifest(entry.install_dir),
    }))
  )

  /** @type {LoadedManifest[]} */
  const loaded = []
  /** @type {FailedManifest[]} */
  const failed = []
  for (const { entry, result } of results) {
    if (result.ok) {
      if (result.manifest.name !== entry.name) {
        // Lock entry name and manifest name disagree — boot cannot
        // trust this entry. Surface it as failed so the caller can
        // decide; we log explicitly because the bare manifest.reject
        // log does not carry the lock-entry context.
        log.error('plugin.installed_manifest_invalid', {
          [Attr.PLUGIN]: entry.name,
          [Attr.ERROR_KIND]: 'installed_manifest_name_mismatch',
          install_dir: entry.install_dir,
          manifest_name: result.manifest.name,
        })
        failed.push({
          ok: false,
          errorKind: 'manifest_invalid',
          message: `installed plugin '${entry.name}' manifest reports name '${result.manifest.name}'`,
          manifestPath: result.manifestPath,
          rootDir: result.rootDir,
        })
      } else {
        loaded.push(result)
      }
    } else {
      log.error('plugin.installed_manifest_invalid', {
        [Attr.PLUGIN]: entry.name,
        [Attr.ERROR_KIND]: result.errorKind,
        install_dir: entry.install_dir,
        manifest_path: result.manifestPath,
        message: result.message,
      })
      failed.push(result)
    }
  }

  return { loaded, failed, lockEntries: entries }
}
