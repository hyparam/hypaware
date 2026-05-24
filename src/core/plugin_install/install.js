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
import { provenanceFromUrl, redactRawSource } from './git_source.js'
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

/**
 * @import { PluginLockEntry, PluginLockFile, PluginName, PluginSourceSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { FetchResult } from './fetch.js'
 */

/**
 * @import {
 *   ConfirmInstall,
 *   ConfirmOutcome,
 *   InstallSuccess,
 *   InstallFailure,
 *   InstallResult,
 * } from './types.d.ts'
 */

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
 * @param {{ ref?: string, subdir?: string }} [args.opts] — CLI flag overrides
 * @param {ConfirmInstall} [args.confirm] — optional trust gate. Called
 *   after fetch+manifest validation and immediately before the artifact
 *   swap. Returning `proceed=false` aborts the install with the
 *   appropriate `remote_install_*` error kind and the outcome is
 *   stamped onto the `plugin.install` span.
 * @param {PluginLockEntry} [args.previous] — prior lock entry (only set
 *   on update flows). Forwarded to `confirm` so the prompt can render a
 *   diff against the installed version/commit.
 * @returns {Promise<InstallResult & { confirmation?: ConfirmOutcome }>}
 */
export async function installPlugin({ rawSource, stateDir, cwd, now, opts, confirm, previous }) {
  const instruments = getKernelInstruments()
  const log = getLogger('plugin-install')
  const nowFn = now ?? (() => new Date())

  return withSpan(
    'plugin.install',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.install',
      hyp_source_raw: redactRawSource(rawSource),
    },
    async (span) => {
      /** @type {PluginSourceSpec} */
      let source
      try {
        source = resolveSource(rawSource, { cwd, ref: opts?.ref, subdir: opts?.subdir })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const errorKind =
          /** @type {Error & { hypErrorKind?: string }} */ (err)?.hypErrorKind || 'resolver_error'
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorKind })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', errorKind)
        instruments.pluginInstallsTotal.add(1, { status: 'failed' })
        log.warn('plugin.install.failed', {
          [Attr.COMPONENT]: 'plugin-install',
          error_kind: errorKind,
          message,
        })
        return /** @type {InstallFailure} */ ({
          ok: false,
          errorKind,
          message,
        })
      }
      span.setAttribute('hyp_source_kind', source.kind)
      if (source.name) span.setAttribute(Attr.PLUGIN, source.name)
      if (source.kind === 'git') {
        const prov = provenanceFromUrl(source.gitUrl ?? '')
        if (prov.host) span.setAttribute('git_url_host', prov.host)
        if (prov.owner) span.setAttribute('git_owner', prov.owner)
        if (prov.repo) span.setAttribute('git_repo', prov.repo)
        if (source.ref) span.setAttribute('git_ref', source.ref)
        if (/** @type {PluginSourceSpec & { subdir?: string }} */ (source).subdir) {
          span.setAttribute(
            'artifact_subdir',
            /** @type {PluginSourceSpec & { subdir?: string }} */ (source).subdir ?? ''
          )
        }
      }

      /** @type {ConfirmOutcome | undefined} */
      let confirmation
      const fetchResult = await fetchPlugin({
        source,
        stateDir,
        ...(confirm ? { beforeCommit: async (staged) => {
          const decision = await confirm({
            manifest: staged.manifest,
            source,
            resolvedRef: staged.resolvedRef,
            contentHash: staged.contentHash,
            manifestHash: staged.manifestHash,
            ...(previous ? { previous } : {}),
          })
          confirmation = decision.outcome
          if (decision.proceed) return { proceed: true }
          const errorKind = decision.outcome === 'rejected'
            ? 'remote_install_rejected'
            : 'remote_install_confirmation_required'
          return {
            proceed: false,
            errorKind,
            message: errorKind === 'remote_install_rejected'
              ? `plugin install: confirmation rejected for ${staged.manifest.name}`
              : `plugin install: remote install requires --yes on non-interactive shells (${staged.manifest.name})`,
          }
        } } : {}),
      })
      if (!fetchResult.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: fetchResult.errorKind })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', fetchResult.errorKind)
        if (confirmation) span.setAttribute('confirmation', confirmation)
        instruments.pluginInstallsTotal.add(1, { status: 'failed' })
        log.warn('plugin.install.failed', {
          [Attr.COMPONENT]: 'plugin-install',
          error_kind: fetchResult.errorKind,
          message: fetchResult.message,
          ...(confirmation ? { confirmation } : {}),
        })
        return {
          ok: false,
          errorKind: fetchResult.errorKind,
          message: fetchResult.message,
          ...(confirmation ? { confirmation } : {}),
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
      if (fetchResult.resolvedRef) {
        entry.resolved_ref = fetchResult.resolvedRef
        span.setAttribute('git_resolved_ref', fetchResult.resolvedRef)
      }
      span.setAttribute('content_hash', fetchResult.contentHash)
      span.setAttribute('manifest_hash', fetchResult.manifestHash)
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

      // The fetch already resolved the upstream ref, so the post-
      // install probe would just confirm what we already know — and
      // would block on a slow or hung remote inside the same span.
      // Synthesize the "no update available" state directly.
      const updateState = await checkForPluginUpdate({
        entry,
        now: nowFn,
        freshlyResolved: source.kind === 'git' && !!entry.resolved_ref,
      })
      const entryWithUpdate = { ...entry, update: updateState }
      nextLock = upsertEntry(nextLock, entryWithUpdate)
      await writeLock(stateDir, nextLock)

      span.setAttribute('status', 'ok')
      if (confirmation) span.setAttribute('confirmation', confirmation)
      instruments.pluginInstallsTotal.add(1, { status: 'ok' })
      log.info('plugin.installed', {
        [Attr.COMPONENT]: 'plugin-install',
        [Attr.PLUGIN]: entry.name,
        version: entry.version,
        hyp_source_kind: source.kind,
        install_dir: entry.install_dir,
        ...(confirmation ? { confirmation } : {}),
      })

      return {
        ok: true,
        entry: entryWithUpdate,
        lock: nextLock,
        ...(confirmation ? { confirmation } : {}),
      }
    },
    { component: 'plugin-install' }
  )
}

/**
 * Update an installed plugin to its latest matching ref. Wraps the work
 * in a `plugin.update` span and delegates the actual fetch + lock-write
 * to `installPlugin` so the install pipeline (resolver, fetch, validate,
 * artifact swap, lock write) is shared between first install and update.
 *
 * The update span carries:
 *
 *   - `hyp_plugin`, `hyp_source_kind`
 *   - `previous_resolved_ref`, `previous_content_hash`
 *   - `git_resolved_ref`, `content_hash` (on success)
 *   - `confirmation` (matches the inner `plugin.install` span)
 *   - `status` (`ok`/`failed`), `error_kind` (on failure)
 *
 * If the user rejects the confirmation prompt the prior install is
 * left intact — the artifact swap inside `fetchGitSource` only fires
 * once the `beforeCommit` callback returns `proceed=true`.
 *
 * @param {object} args
 * @param {PluginName} args.name
 * @param {string}     args.stateDir
 * @param {ConfirmInstall} [args.confirm]
 * @param {() => Date}    [args.now]
 * @returns {Promise<InstallResult>}
 */
export async function updatePlugin({ name, stateDir, confirm, now }) {
  return withSpan(
    'plugin.update',
    {
      [Attr.COMPONENT]: 'plugin-install',
      [Attr.OPERATION]: 'plugin.update',
      [Attr.PLUGIN]: name,
    },
    async (span) => {
      const lock = await safeReadLock(stateDir)
      const previous = getEntry(lock, name)
      if (!previous) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'plugin_not_installed' })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'plugin_not_installed')
        return {
          ok: false,
          errorKind: 'plugin_not_installed',
          message: `plugin not installed: ${name}`,
        }
      }
      span.setAttribute('hyp_source_kind', previous.source.kind)
      span.setAttribute('previous_content_hash', previous.content_hash)
      if (previous.resolved_ref) {
        span.setAttribute('previous_resolved_ref', previous.resolved_ref)
      }

      const reinstallRef = refForReinstall(previous)
      const result = await installPlugin({
        rawSource: previous.source.raw,
        stateDir,
        ...(now ? { now } : {}),
        ...(reinstallRef !== undefined ? { opts: { ref: reinstallRef } } : {}),
        ...(confirm ? { confirm } : {}),
        previous,
      })

      if (result.confirmation) span.setAttribute('confirmation', result.confirmation)

      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.errorKind })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', result.errorKind)
        return result
      }

      span.setAttribute('status', 'ok')
      span.setAttribute('content_hash', result.entry.content_hash)
      if (result.entry.resolved_ref) {
        span.setAttribute('git_resolved_ref', result.entry.resolved_ref)
      }
      return result
    },
    { component: 'plugin-install' }
  )
}

/**
 * Recover the ref to pass back into `resolveSource` when re-installing
 * an existing entry. Returning `undefined` lets the resolver re-parse
 * whatever ref is encoded in `source.raw` (URL fragment) so we never
 * double-up and trip `source_ambiguous`.
 *
 * @param {PluginLockEntry} entry
 * @returns {string | undefined}
 */
function refForReinstall(entry) {
  if (entry.source.kind !== 'git') return undefined
  if (!entry.source.ref) return undefined
  if (typeof entry.source.raw === 'string' && entry.source.raw.includes('#')) {
    return undefined
  }
  return entry.source.ref
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
