// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveLayeredConfigFromDisk } from '../runtime/boot.js'
import { withFileLock } from '../util/file_lock.js'
import { atomicWriteFile } from '../util/fs_atomic.js'
import { prepareLocalConfigWrite } from './schema.js'

/** @import { HypAwareV2Config } from '../../../hypaware-plugin-kernel-types.js' */

/** @param {string} stateRoot @param {string} configPath */
export async function readLocalPluginLayers(stateRoot, configPath) {
  const layers = await resolveLayeredConfigFromDisk({ stateRoot, configPath })
  for (const loaded of [layers.localLoaded, layers.centralLoaded]) {
    if (loaded?.ok === false && loaded.errorKind !== 'config_missing') throw new Error(`could not load ${loaded.configPath}. Validate the config and retry.`)
  }
  return layers
}

/**
 * @param {{
 *   stateRoot: string,
 *   configPath: string,
 *   select: (config: HypAwareV2Config, layers: Awaited<ReturnType<typeof readLocalPluginLayers>>) => void,
 * }} args
 * @ref LLP 0031#local-layer-writers [implements]: standalone opt-ins back up the local layer before a guarded write
 */
export async function updateLocalPluginSelection({ stateRoot, configPath: configuredPath, select }) {
  const configuredFile = await fs.lstat(configuredPath).catch(err => {
    if (err.code !== 'ENOENT') throw err
    return undefined
  })
  const configPath = configuredFile?.isSymbolicLink() ? await fs.realpath(configuredPath) : configuredPath
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  return withFileLock(`${configPath}.plugin-selection.lock`, async () => {
    const stat = await fs.stat(configPath).catch(err => {
      if (err.code !== 'ENOENT') throw err
      return undefined
    })
    const layers = await readLocalPluginLayers(stateRoot, configPath)
    if (Boolean(stat) !== Boolean(layers.localConfig)) throw new Error('config changed during save')
    /** @type {HypAwareV2Config} */
    const base = layers.localConfig ?? { version: 2, plugins: [] }
    const config = { ...base, plugins: (base.plugins ?? []).map(plugin => ({ ...plugin })) }
    select(config, layers)
    if (isDeepStrictEqual(base.plugins ?? [], config.plugins)) return false
    await prepareLocalConfigWrite({ targetPath: configPath, force: true })
    await atomicWriteFile(configPath, JSON.stringify(config, null, 2) + '\n', {
      mode: stat ? stat.mode & 0o777 : 0o600,
      expectedMtimeMs: stat?.mtimeMs,
      fsync: true,
    })
    return true
  })
}
