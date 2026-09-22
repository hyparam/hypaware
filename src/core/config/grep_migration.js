// @ts-check

import fs from 'node:fs/promises'

import { getLogger } from '../observability/index.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { withFileLock } from '../util/file_lock.js'
import { configRecordsPickAnswer, isForgedGrepOnlyConfig, loadConfigFile, prepareLocalConfigWrite } from './schema.js'

/**
 * @import { LoadConfigResult } from '../../../src/core/config/types.js'
 */

const GREP = '@hypaware/grep'

/**
 * Upgrade only the client-owned layer. The caller opts in after discovering
 * the bundled grep plugin; generic config readers and explicit host profiles
 * retain their read-only behavior.
 *
 * @param {{ configPath: string | null, centralConfigPath: string | null, migrateGrep?: boolean }} args
 * @ref LLP 0415#migration [implements]: preserve the previously intrinsic search surface on upgrade
 */
export async function loadClientConfigLayers({ configPath, centralConfigPath, migrateGrep = false }) {
  const read = async () => ({
    local: configPath ? await loadConfigFile(configPath) : null,
    central: centralConfigPath ? await loadConfigFile(centralConfigPath) : null,
  })
  let layers = await read()
  if (!migrateGrep || !configPath || !needsGrep(layers)) return layers
  // Persisting here would forge a pick answer nobody gave: onboarding would
  // then open with every detected client unchecked, and status would call the
  // machine a returning one. Search still works; it just costs the two list
  // checks again next boot.
  // @ref LLP 0418#no-forged-answer [implements]: the compatibility entry stays in memory whenever writing it would record an answer
  if (forgesPickAnswer(layers.local)) return withGrep(layers, configPath)

  try {
    return await withFileLock(`${configPath}.grep-migration.lock`, async () => {
      // Another CLI or the daemon may have finished while we waited.
      const stat = await fs.lstat(configPath).catch((err) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      layers = await read()
      if (!needsGrep(layers)) return layers
      // Re-checked under the lock: the local layer may have been removed or
      // rewritten answer-less since the read above.
      if (forgesPickAnswer(layers.local)) return withGrep(layers, configPath)
      if (!stat) {
        throw Object.assign(new Error('config appeared during migration'), { code: 'CONCURRENT_EDIT' })
      }
      // A symlink may target a managed central slot. Preserve it and use the
      // compatibility entry in memory instead of replacing or following it.
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw Object.assign(new Error('config is not a regular file'), { code: 'CONFIG_NOT_REGULAR' })
      }
      if (centralConfigPath &&
          await fs.realpath(configPath) === await fs.realpath(centralConfigPath)) {
        throw Object.assign(new Error('config names the central layer'), { code: 'CONFIG_CENTRAL' })
      }
      await fs.access(configPath, fs.constants.W_OK)
      const upgraded = withGrep(layers, configPath)
      const guard = await prepareLocalConfigWrite({ targetPath: configPath, force: true })
      if (!guard.proceed) throw new Error('config backup refused')
      // Use the raw document so shape parsing cannot normalize unrelated
      // optional fields while adding the one entry.
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
      raw.plugins = [...(raw.plugins ?? []), { name: GREP }]
      await atomicWriteJson(configPath, raw, {
        mode: stat.mode & 0o777, expectedMtimeMs: stat.mtimeMs,
      })
      getLogger('config').info('config.grep_migration', {
        status: 'ok', migration_status: 'persisted', hyp_plugin: GREP, config_path: configPath,
        ...(guard.backupPath ? { backup_path: guard.backupPath } : {}),
      })
      return upgraded
    })
  } catch (err) {
    // Re-read before falling back: a concurrent explicit disable must win.
    layers = await read()
    if (!needsGrep(layers)) return layers
    getLogger('config', { mirrorStderr: true }).warn(
      'config.grep_migration: search enabled for this process; config could not be saved', {
        status: 'failed', migration_status: 'memory_only', hyp_plugin: GREP, config_path: configPath,
        error_kind: /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'config_write_failed',
      })
    return withGrep(layers, configPath)
  }
}

/**
 * Whether persisting the compatibility entry would leave behind a local layer
 * that records a pick answer the user never gave. Two shapes qualify: a local
 * config with no `plugins` array, and no local config at all (the central-only
 * lane, where the file the migration would create is `{ version, plugins }` and
 * nothing else). Both seed onboarding from detection today, and a written
 * `plugins` array is indistinguishable from a completed picker run.
 *
 * A third shape joined them: a local config that is exactly
 * `{ version, plugins: [] }`. It records an answer, but appending the
 * compatibility entry to it would mint the very document the readers
 * classify as forged residue (LLP 0426), so that one append also stays in
 * memory and the emptied config keeps recording its answer.
 *
 * @ref LLP 0418#no-forged-answer [implements]: a missing local layer is answer-less in the same way an answer-less one is
 * @ref LLP 0277#answer-less [constrained-by]: the `plugins` key is the pick-answer discriminator this predicate reuses
 * @ref LLP 0426#no-minting [implements]: the persist lane declines the one write whose output would match the forged shape
 * @param {LoadConfigResult | null} local
 * @returns {boolean}
 */
function forgesPickAnswer(local) {
  if (!local?.ok || !configRecordsPickAnswer(local.config)) return true
  return isForgedGrepOnlyConfig({
    ...local.config,
    plugins: [...(local.config.plugins ?? []), { name: GREP }],
  })
}

/** @param {{ local: LoadConfigResult | null, central: LoadConfigResult | null }} layers */
function needsGrep({ local, central }) {
  // An invalid/unreadable layer cannot prove that grep was not disabled.
  if (local && !local.ok && local.errorKind !== 'config_missing') return false
  if (central && !central.ok) return false
  if (!local?.ok && !central?.ok) return false
  return ![local, central].some((layer) =>
    layer?.ok && layer.config.plugins?.some((entry) => entry.name === GREP))
}

/**
 * @param {{ local: LoadConfigResult | null, central: LoadConfigResult | null }} layers
 * @param {string} configPath
 */
function withGrep(layers, configPath) {
  const config = layers.local?.ok ? layers.local.config : { version: /** @type {const} */ (2) }
  return {
    ...layers,
    local: /** @type {LoadConfigResult} */ ({
      ok: true, configPath,
      config: { ...config, plugins: [...(config.plugins ?? []), { name: GREP }] },
    }),
  }
}
