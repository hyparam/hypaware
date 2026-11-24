// @ts-check

import { parseCoreCommandArgv } from '../cli/command_args.js'
import {
  SELF_BIN_PATH,
  clearEntrypoint,
  entrypointPath,
  liveEntrypoint,
  readEntrypoint,
  sameBin,
  writeEntrypoint,
} from '../runtime/entrypoint.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { EntrypointRecord } from '../../../src/core/runtime/types.js'
 */

/**
 * `hyp entrypoint [show|claim|release]`: read or set which copy of the CLI
 * owns this machine. An installer (the native app, an MDM package) runs
 * `claim` through its own copy, then installs the service and attaches the
 * clients; every other copy then hands its commands to this one.
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

  if (action === 'claim') {
    /** @type {EntrypointRecord} */
    const record = { bin: SELF_BIN_PATH, node: typeof params.node === 'string' ? params.node : process.execPath }
    if (typeof params.owner === 'string' && params.owner) record.owner = params.owner
    writeEntrypoint(record, env)
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
    clearEntrypoint(env)
    ctx.stdout.write('entry point cleared\n')
    return 0
  }

  const record = readEntrypoint(env)
  const live = liveEntrypoint(env)
  if (params.json === true) {
    ctx.stdout.write(JSON.stringify({
      path: entrypointPath(env),
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
