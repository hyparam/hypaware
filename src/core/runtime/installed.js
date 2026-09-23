// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { loadLock } from '../plugin_install/install.js'
import { pluginLockPath } from '../plugin_install/paths.js'
import { loadManifest } from '../manifest.js'
import { isUsableEntry } from '../plugin_install/lock.js'

/**
 * @import { PluginLockEntry, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { FailedManifest, LoadedManifest } from '../../../src/core/types.js'
 * @import { DiscoverInstalledResult } from '../../../src/core/runtime/types.js'
 */

/**
 * Walk the kernel state's `plugin-lock.json` and load the manifest from
 * every lock entry's `install_dir`. Mirrors `discoverBundledPlugins`
 * but skips the V1 allowlist (anything that landed in the lock is
 * user-installed and was reviewed at install time).
 *
 * Missing lock file → empty result. Per-entry manifest failures are
 * surfaced via `failed[]` (mirroring `loadManifests`) and additionally
 * logged as `plugin.installed_manifest_invalid` so boot diagnostics
 * carry the install_dir context the bare manifest log does not.
 *
 * An entry that carries no directory at all cannot be a `FailedManifest`
 * (that shape is a `rootDir` plus a reason), so it degrades through
 * `malformed[]` instead, named by its lock key.
 *
 * @param {object} args
 * @param {string} args.stateDir
 * @returns {Promise<DiscoverInstalledResult>}
 */
export async function discoverInstalledPlugins({ stateDir }) {
  if (!stateDir) throw new Error('discoverInstalledPlugins: stateDir is required')

  const lock = await loadLock(stateDir)
  // Keys, not `listEntries`: the lock key is the name every other install
  // surface indexes by (`getEntry`, `hyp plugin remove <name>`), and it is the
  // only identity a malformed entry still has, since an entry that is not an
  // object carries no `name` field to read.
  const names = Object.keys(lock.plugins).sort()
  if (names.length === 0) {
    return { loaded: [], failed: [], lockEntries: [], malformed: [] }
  }

  // `readLock` validates the lock container and nothing inside it, and the file
  // is hand-editable. An entry with no usable `install_dir` reaches `path.join`
  // inside `loadManifest` and takes down every kernel-booting command, `hyp
  // status` included, on a TypeError naming neither the file nor the entry, so
  // it degrades to a named per-entry fault on the terms this module already
  // promises for a manifest that will not load (issue #1958). `install_dir` is
  // the only field this walk dereferences into anything that can throw: `name`
  // is compared and logged, and an entry whose name disagrees with its manifest
  // already lands in `failed[]` below.
  /** @type {PluginLockEntry[]} */
  const entries = []
  /** @type {PluginName[]} */
  const malformed = []
  for (const name of names) {
    const entry = lock.plugins[name]
    if (isUsableEntry(entry)) {
      entries.push(entry)
    } else {
      malformed.push(name)
    }
  }

  const log = getLogger('kernel')
  for (const name of malformed) {
    log.error('plugin.installed_lock_entry_invalid', {
      [Attr.PLUGIN]: name,
      [Attr.ERROR_KIND]: 'lock_entry_invalid',
      lock_path: pluginLockPath(stateDir),
      message: `plugin-lock.json entry '${name}' has no usable install_dir`,
    })
  }

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
        // Lock entry name and manifest name disagree. Boot cannot
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

  return { loaded, failed, lockEntries: entries, malformed }
}
