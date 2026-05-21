// @ts-check

import fs from 'node:fs/promises'

import {
  Attr,
  getKernelInstruments,
  getLogger,
  SpanStatusCode,
  withSpan,
} from '../observability/index.js'

import { fetchPlugin } from './fetch.js'
import {
  emptyLock,
  getEntry,
  listEntries,
  readLock,
  removeEntry as removeLockEntry,
  upsertEntry,
  writeLock,
} from './lock.js'
import { pluginInstallDir } from './paths.js'
import { resolveSource } from './resolver.js'
import { checkForPluginUpdate } from './update_check.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLockEntry} PluginLockEntry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLockFile} PluginLockFile */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginName} PluginName */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginSourceSpec} PluginSourceSpec */
/** @typedef {import('./fetch.js').FetchResult} FetchResult */

/**
 * @typedef {Object} InstallSuccess
 * @property {true} ok
 * @property {PluginLockEntry} entry
 * @property {PluginLockFile} lock
 */

/**
 * @typedef {Object} InstallFailure
 * @property {false} ok
 * @property {string} errorKind
 * @property {string} message
 */

/** @typedef {InstallSuccess | InstallFailure} InstallResult */

/**
 * Install a plugin end-to-end. Wraps the work in a `plugin.install`
 * span that records:
 *
 *   - `hyp_plugin` once the manifest is known
 *   - `hyp_source_kind` from the resolved source
 *   - `status` (`ok`/`failed`)
 *   - `error_kind` (set on failure) — `resolver_error`,
 *     `local_dir_missing`, `local_dir_invalid`, `manifest_invalid`,
 *     `manifest_name_mismatch`, `fetch_unsupported`, or
 *     `lock_write_error`.
 *
 * After the artifact and lock are committed, the kernel runs a
 * best-effort `plugin.update_check` span (silent on failure) and
 * updates the lock entry's `update` field with the result.
 *
 * @param {object} args
 * @param {string} args.rawSource    — e.g. `./plugins-workspace/dummy-a`
 * @param {string} args.stateDir     — kernel state root
 * @param {string} [args.cwd]        — for resolving relative paths
 * @param {() => Date} [args.now]    — injectable for tests
 * @returns {Promise<InstallResult>}
 */
export async function installPlugin({ rawSource, stateDir, cwd, now }) {
  const instruments = getKernelInstruments()
  const log = getLogger('plugin-install')
  const nowFn = now ?? (() => new Date())

  return withSpan(
    'plugin.install',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.install',
      hyp_source_raw: rawSource,
    },
    async (span) => {
      /** @type {PluginSourceSpec} */
      let source
      try {
        source = resolveSource(rawSource, { cwd })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'resolver_error' })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'resolver_error')
        instruments.pluginInstallsTotal.add(1, { status: 'failed' })
        log.warn('plugin.install.failed', {
          [Attr.COMPONENT]: 'plugin-install',
          error_kind: 'resolver_error',
          message,
        })
        return /** @type {InstallFailure} */ ({
          ok: false,
          errorKind: 'resolver_error',
          message,
        })
      }
      span.setAttribute('hyp_source_kind', source.kind)
      if (source.name) span.setAttribute(Attr.PLUGIN, source.name)

      const fetchResult = await fetchPlugin({ source, stateDir })
      if (!fetchResult.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: fetchResult.errorKind })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', fetchResult.errorKind)
        instruments.pluginInstallsTotal.add(1, { status: 'failed' })
        log.warn('plugin.install.failed', {
          [Attr.COMPONENT]: 'plugin-install',
          error_kind: fetchResult.errorKind,
          message: fetchResult.message,
        })
        return {
          ok: false,
          errorKind: fetchResult.errorKind,
          message: fetchResult.message,
        }
      }

      const installedAt = nowFn().toISOString()
      /** @type {PluginLockEntry} */
      const entry = {
        name: fetchResult.manifest.name,
        version: fetchResult.manifest.version,
        source,
        install_dir: fetchResult.installDir,
        content_hash: fetchResult.contentHash,
        manifest_hash: fetchResult.manifestHash,
        installed_at: installedAt,
      }
      span.setAttribute(Attr.PLUGIN, entry.name)

      const initialLock = await safeReadLock(stateDir)
      let nextLock = upsertEntry(initialLock, entry)
      try {
        await writeLock(stateDir, nextLock)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'lock_write_error' })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'lock_write_error')
        instruments.pluginInstallsTotal.add(1, { status: 'failed' })
        log.error('plugin.install.failed', {
          [Attr.COMPONENT]: 'plugin-install',
          error_kind: 'lock_write_error',
          message,
        })
        return { ok: false, errorKind: 'lock_write_error', message }
      }

      const updateState = await checkForPluginUpdate({ entry, now: nowFn })
      const entryWithUpdate = { ...entry, update: updateState }
      nextLock = upsertEntry(nextLock, entryWithUpdate)
      await writeLock(stateDir, nextLock)

      span.setAttribute('status', 'ok')
      instruments.pluginInstallsTotal.add(1, { status: 'ok' })
      log.info('plugin.installed', {
        [Attr.COMPONENT]: 'plugin-install',
        [Attr.PLUGIN]: entry.name,
        version: entry.version,
        hyp_source_kind: source.kind,
        install_dir: entry.install_dir,
      })

      return { ok: true, entry: entryWithUpdate, lock: nextLock }
    },
    { component: 'plugin-install' }
  )
}

/**
 * Remove an installed plugin. Wipes the install directory and the
 * lock entry, and emits a `plugin.remove` span. The CLI calls this
 * directly so `hyp plugin remove` produces the trace expected by
 * the §Phase 7 instrumentation contract.
 *
 * @param {object} args
 * @param {PluginName} args.name
 * @param {string} args.stateDir
 * @returns {Promise<{ ok: true, lock: PluginLockFile } | { ok: false, errorKind: string, message: string }>}
 */
export async function removePlugin({ name, stateDir }) {
  const instruments = getKernelInstruments()
  const log = getLogger('plugin-install')
  return withSpan(
    'plugin.remove',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.remove',
      [Attr.PLUGIN]: name,
    },
    async (span) => {
      const lock = await safeReadLock(stateDir)
      const entry = getEntry(lock, name)
      if (!entry) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'plugin_not_installed' })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'plugin_not_installed')
        return {
          ok: false,
          errorKind: 'plugin_not_installed',
          message: `plugin not installed: ${name}`,
        }
      }
      const installDir = entry.install_dir ?? pluginInstallDir(stateDir, name)
      await fs.rm(installDir, { recursive: true, force: true })
      const nextLock = removeLockEntry(lock, name)
      await writeLock(stateDir, nextLock)
      // Zero the gauge so a downstream consumer doesn't show a
      // dangling "1 update available" for a plugin we no longer track.
      instruments.pluginUpdatesAvailable.record(0, { [Attr.PLUGIN]: name })
      span.setAttribute('status', 'ok')
      log.info('plugin.removed', {
        [Attr.COMPONENT]: 'plugin-install',
        [Attr.PLUGIN]: name,
      })
      return { ok: true, lock: nextLock }
    },
    { component: 'plugin-install' }
  )
}

/**
 * Surface read access for the CLI list/info/outdated commands.
 * @param {string} stateDir
 */
export async function loadLock(stateDir) {
  return safeReadLock(stateDir)
}

/**
 * List installed plugins in stable name order.
 * @param {string} stateDir
 * @returns {Promise<PluginLockEntry[]>}
 */
export async function listInstalledPlugins(stateDir) {
  const lock = await safeReadLock(stateDir)
  return listEntries(lock)
}

/** @param {string} stateDir */
async function safeReadLock(stateDir) {
  try {
    return await readLock(stateDir)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    getLogger('plugin-install').warn('plugin.lock_unreadable', {
      [Attr.COMPONENT]: 'plugin-install',
      error_kind: 'lock_unreadable',
      message,
    })
    return emptyLock()
  }
}
