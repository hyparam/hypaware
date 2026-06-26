// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { parseConfigShape } from './schema.js'
import { validateConfig } from './validate.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { installPlugin, loadLock } from '../plugin_install/install.js'
import { getEntry } from '../plugin_install/lock.js'

/**
 * @import { ConfigRegistry, PluginConfigInstance, PluginName, ValidationError } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ConfigApplyDeps, PinnedInstallResult } from './types.d.ts'
 */

/**
 * Build the apply-time dependencies the config apply engine needs:
 * full-document validation against the live plugin catalog, and
 * hash-pinned plugin installation through the LLP 0007 install path.
 * Constructed by the daemon after kernel boot (the catalog needs the
 * bundled manifest set) and attached via
 * `configControl.attachApplyDeps()`.
 *
 * The live `configRegistry` (the kernel registry the active plugins
 * registered their `config_sections` validators into during boot) is
 * threaded through so apply-time validation actually dispatches to those
 * per-plugin validators. Omitting it makes them dead — a served config with
 * a malformed plugin `config` block (e.g. claude/codex `backfill`) would be
 * accepted instead of rejected (LLP 0037).
 *
 * @param {{ stateRoot: string, workspaceDir?: string, configRegistry?: ConfigRegistry }} opts
 * @returns {ConfigApplyDeps}
 */
export function buildConfigApplyDeps(opts) {
  const { stateRoot, workspaceDir, configRegistry } = opts
  const log = getLogger('config-control')

  /**
   * Discover bundled + installed manifests fresh per apply: an apply
   * may have just installed a plugin, and a stale catalog would reject
   * the very config that named it.
   */
  async function discover() {
    const bundled = await discoverBundledPlugins(
      workspaceDir !== undefined ? { workspaceDir } : {}
    )
    const installed = await discoverInstalledPlugins({ stateDir: stateRoot })
    return { bundled, installed }
  }

  /** @param {unknown} document */
  async function validateDocument(document) {
    const shape = parseConfigShape(document)
    if (!shape.ok) {
      return { ok: false, errors: shape.errors }
    }
    const { bundled, installed } = await discover()
    const catalog = buildPluginCatalog(
      [...bundled.loaded, ...bundled.excluded],
      installed.loaded
    )
    const result = await validateConfig(shape.config, {
      knownPlugins: catalog.pluginMetadata,
      knownDatasets: catalog.knownDatasets,
      // Pass the live registry so per-plugin `config_sections` validators run
      // (LLP 0037). Absent (e.g. a non-daemon caller) it degrades to the
      // cross-plugin checks only, exactly as before.
      ...(configRegistry ? { configRegistry } : {}),
    })
    return { ok: result.ok, errors: /** @type {ValidationError[]} */ (result.errors) }
  }

  /**
   * Install every pinned plugin the staged config names. Bundled
   * first-party plugins satisfy the pin by strict version equality and
   * skip the hash check (bundled code is inside the kernel's own trust
   * boundary); everything else goes through the regular fetch path,
   * with the artifact hash verified before the install commits.
   *
   * @param {PluginConfigInstance[]} entries
   * @returns {Promise<PinnedInstallResult>}
   * @ref LLP 0025#install-on-config-hash-pinned [implements] — existing LLP 0007 install path; hash mismatch is an apply failure
   */
  async function installPinnedPlugins(entries) {
    const { bundled, installed } = await discover()
    /** @type {Map<string, string>} */
    const bundledVersions = new Map()
    for (const m of [...bundled.loaded, ...bundled.excluded]) {
      bundledVersions.set(m.manifest.name, m.manifest.version)
    }
    const installedNames = new Set(installed.loaded.map((m) => m.manifest.name))
    const lock = await loadLock(stateRoot)

    for (const entry of entries) {
      if (entry.enabled === false) continue

      const bundledVersion = bundledVersions.get(entry.name)
      if (bundledVersion !== undefined) {
        // @ref LLP 0025#bundled-first-party-plugins [implements] — version checked strictly, artifact hash not checked for bundled plugins
        if (entry.version !== undefined && entry.version !== bundledVersion) {
          return {
            ok: false,
            errorKind: 'bundled_version_mismatch',
            message: `plugin ${entry.name}: config pins version ${entry.version} but the bundled version is ${bundledVersion}`,
          }
        }
        continue
      }

      const locked = getEntry(lock, /** @type {PluginName} */ (entry.name))
      const satisfied = locked
        && installedNames.has(entry.name)
        && (entry.version === undefined || locked.version === entry.version)
        && (entry.artifact_hash === undefined || locked.content_hash === entry.artifact_hash)
      if (satisfied) continue

      const result = await installPlugin({
        rawSource: entry.source ?? entry.name,
        stateDir: stateRoot,
        ...(entry.version !== undefined ? { opts: { ref: `v${entry.version}` } } : {}),
        // The hash pin is verified against the staged artifact before
        // the install commits — nothing may substitute code after the
        // config was authored.
        confirm: async (staged) => {
          if (entry.artifact_hash !== undefined && staged.contentHash !== entry.artifact_hash) {
            log.error('config.pin_hash_mismatch', {
              [Attr.COMPONENT]: 'config-control',
              [Attr.PLUGIN]: entry.name,
              [Attr.ERROR_KIND]: 'artifact_hash_mismatch',
              pinned_hash: entry.artifact_hash,
              fetched_hash: staged.contentHash,
            })
            return { proceed: false, outcome: 'rejected' }
          }
          if (entry.version !== undefined && staged.manifest.version !== entry.version) {
            return { proceed: false, outcome: 'rejected' }
          }
          return { proceed: true, outcome: 'auto_yes' }
        },
      })
      if (!result.ok) {
        const hashRejected = result.errorKind === 'remote_install_rejected'
        return {
          ok: false,
          errorKind: hashRejected ? 'artifact_hash_mismatch' : 'plugin_install_failed',
          message: `plugin ${entry.name}: ${result.message}`,
        }
      }
    }
    return { ok: true }
  }

  return { validateDocument, installPinnedPlugins }
}
