// @ts-check

import fs from 'node:fs/promises'

import { parseCoreCommandArgv } from '../cli/command_args.js'
import {
  SELF_BIN_PATH,
  entrypointConfigPath,
  liveEntrypoint,
  readEntrypoint,
  sameBin,
} from '../runtime/entrypoint.js'
import { atomicWriteJson } from '../util/fs_atomic.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { EntrypointRecord } from '../../../src/core/runtime/types.js'
 */

/**
 * `hyp entrypoint [show|claim|release]`: read or set which copy of the CLI
 * owns this machine, the local config's `entrypoint` key. An installer (the
 * native app, an MDM package) runs `claim` through its own copy, then
 * installs the service and attaches the clients; every other copy then hands
 * its commands to this one.
 *
 * Runs in the invoked copy, never handed off (runtime/entrypoint.js), so a
 * copy can claim while another one is named.
 *
 * @ref LLP 0621#claim [implements]: the installer claims through its own copy; release only by the owner unless forced
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runEntrypoint(argv, ctx) {
  const parsed = parseCoreCommandArgv('entrypoint', argv, ctx)
  if (!parsed.ok) return parsed.code
  const params = parsed.params
  const action = typeof params.action === 'string' ? params.action : 'show'
  const env = ctx.env
  const configPath = entrypointConfigPath(env)

  if (action === 'claim') {
    /** @type {EntrypointRecord} */
    const record = { bin: SELF_BIN_PATH, node: typeof params.node === 'string' ? params.node : process.execPath }
    if (typeof params.owner === 'string' && params.owner) record.owner = params.owner
    const failure = await writeEntrypointKey(configPath, record)
    if (failure) {
      ctx.stderr.write(`could not record the entry point in ${configPath}: ${failure}\n`)
      return 1
    }
    ctx.stdout.write(`entry point: ${record.bin}\n`)
    return 0
  }

  if (action === 'release') {
    const record = readEntrypoint(env)
    if (!record) {
      ctx.stdout.write('no entry point is set\n')
      return 0
    }
    if (!sameBin(record.bin, SELF_BIN_PATH) && params.force !== true) {
      ctx.stderr.write(`the entry point is ${record.bin}, not this copy (${SELF_BIN_PATH}); pass --force to clear it anyway\n`)
      return 1
    }
    const failure = await writeEntrypointKey(configPath, undefined)
    if (failure) {
      ctx.stderr.write(`could not clear the entry point in ${configPath}: ${failure}\n`)
      return 1
    }
    ctx.stdout.write('entry point cleared\n')
    return 0
  }

  const record = readEntrypoint(env)
  const live = liveEntrypoint(env)
  if (params.json === true) {
    ctx.stdout.write(JSON.stringify({
      config_path: configPath,
      entrypoint: record ?? null,
      live: live !== undefined,
      self: SELF_BIN_PATH,
      is_self: record !== undefined && sameBin(record.bin, SELF_BIN_PATH),
    }) + '\n')
    return 0
  }
  if (!record) {
    ctx.stdout.write(`no entry point is set; this copy runs its own commands (${SELF_BIN_PATH})\n`)
    return 0
  }
  const owner = record.owner ? ` (${record.owner})` : ''
  ctx.stdout.write(`entry point: ${record.bin}${owner}\n`)
  if (!live) ctx.stdout.write('  missing on disk, so it is ignored\n')
  else if (sameBin(record.bin, SELF_BIN_PATH)) ctx.stdout.write('  this copy\n')
  else ctx.stdout.write(`  this copy (${SELF_BIN_PATH}) hands its commands to it\n`)
  return 0
}

/**
 * Set (or with `undefined`, remove) the `entrypoint` key in the local config,
 * leaving every other key as it is. A missing config becomes `{ version: 2 }`
 * plus the key. The write is atomic and refuses if the file changed under it.
 *
 * @param {string} configPath
 * @param {EntrypointRecord | undefined} record
 * @returns {Promise<string | undefined>} a failure message, or undefined on success
 */
async function writeEntrypointKey(configPath, record) {
  /** @type {Record<string, unknown>} */
  let raw = { version: 2 }
  /** @type {{ mode: number, expectedMtimeMs: number } | undefined} */
  let guard
  try {
    const stat = await fs.stat(configPath)
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'the config is not a JSON object'
    raw = parsed
    guard = { mode: stat.mode & 0o777, expectedMtimeMs: stat.mtimeMs }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
      return err instanceof Error ? err.message : String(err)
    }
    if (record === undefined) return undefined
  }
  if (record === undefined) {
    if (!('entrypoint' in raw)) return undefined
    const { entrypoint: _drop, ...rest } = raw
    raw = rest
  } else {
    raw = { ...raw, entrypoint: record }
  }
  try {
    await atomicWriteJson(configPath, raw, guard)
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
