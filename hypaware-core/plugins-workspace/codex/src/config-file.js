// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { ConcurrentEditError, atomicWriteFile } from 'hypaware/core/util'

import { CodexSettingsError } from './errors.js'

/**
 * Default Codex config location: `$CODEX_HOME/config.toml` when set,
 * otherwise `~/.codex/config.toml`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultConfigPath(env, homeDir) {
  const e = env ?? process.env
  if (typeof e.CODEX_HOME === 'string' && e.CODEX_HOME.length > 0) {
    return path.join(e.CODEX_HOME, 'config.toml')
  }
  return path.join(homeDir ?? os.homedir(), '.codex', 'config.toml')
}

/**
 * @param {string} configPath
 * @returns {Promise<{ content: string, existed: boolean, mtimeMs: number | undefined }>}
 */
export async function readConfig(configPath) {
  /** @type {string} */
  let content
  try {
    content = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { content: '', existed: false, mtimeMs: undefined }
    }
    throw new CodexSettingsError(`failed to read ${configPath}: ${errMsg(err)}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(configPath)
  } catch (err) {
    throw new CodexSettingsError(`failed to stat ${configPath}: ${errMsg(err)}`, { cause: err })
  }
  return { content, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {string} filePath
 * @param {string} body
 * @param {number | undefined} expectedMtimeMs
 * @returns {Promise<void>}
 */
export async function writeAtomic(filePath, body, expectedMtimeMs) {
  try {
    await atomicWriteFile(filePath, body, { mode: 0o600, fsync: true, expectedMtimeMs })
  } catch (err) {
    if (err instanceof ConcurrentEditError) {
      throw new CodexSettingsError(err.message, { code: 'CONCURRENT_EDIT', cause: err.cause ?? err })
    }
    throw err
  }
}

/** @param {unknown} err */
function errCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : undefined
}

/** @param {unknown} err */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
