// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson } from '../../../../src/core/util/fs_atomic.js'
import { isPlainObject } from '../../../../src/core/util/json_util.js'
import { cloudAgentId, cloudRepository, CursorCloudError, readCursorCloudMetadata } from './cloud-client.js'

/** @import { CursorCloudConnection } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js' */

/** @param {string} stateDir */
export const cursorCloudConnectionPath = stateDir => path.join(stateDir, 'cursor-cloud.json')

/** @param {string} stateDir @returns {Promise<CursorCloudConnection | undefined>} */
export async function readCursorCloudConnection(stateDir) {
  try {
    const file = cursorCloudConnectionPath(stateDir)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 16384) throw new CursorCloudError('cloud_connection_invalid')
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!isPlainObject(value) || value.version !== 1 || !cloudAgentId(value.agentId) || !cloudRepository(value.repository) ||
        typeof value.cwd !== 'string' || value.cwd.length > 4096 || !path.isAbsolute(value.cwd) || value.cwd !== path.resolve(value.cwd) ||
        Object.keys(value).some(key => !['version', 'agentId', 'repository', 'cwd'].includes(key))) throw new CursorCloudError('cloud_connection_invalid')
    return { version: 1, agentId: value.agentId, repository: value.repository, cwd: value.cwd }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    throw new CursorCloudError('cloud_connection_invalid')
  }
}

/** @param {string} stateDir @param {CursorCloudConnection} expected */
export async function cursorCloudConnectionCurrent(stateDir, expected) {
  const current = await readCursorCloudConnection(stateDir)
  return current?.agentId === expected.agentId && current?.cwd === expected.cwd && current?.repository === expected.repository
}

/**
 * @param {string} stateDir
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {{ metadata?: typeof readCursorCloudMetadata, beforeSave?: (connection: CursorCloudConnection) => Promise<unknown>, dryRun?: boolean }} [deps]
 * @ref LLP 0593#scope: connection is a local, explicit grant for the current native agent and canonical workspace.
 */
export async function connectCursorCloud(stateDir, cwd, env, deps = {}) {
  if (!env.CURSOR_API_KEY?.trim()) throw new CursorCloudError('cloud_api_key_missing_or_invalid')
  const metadata = await (deps.metadata ?? readCursorCloudMetadata)(env)
  const root = await fs.realpath(cwd)
  /** @type {CursorCloudConnection} */
  const connection = { version: 1, ...metadata, cwd: root }
  await deps.beforeSave?.(connection)
  if (!deps.dryRun) await atomicWriteJson(cursorCloudConnectionPath(stateDir), connection, { mode: 0o600, dirMode: 0o700 })
  return connection
}
