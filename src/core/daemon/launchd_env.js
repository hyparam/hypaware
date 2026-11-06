// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { errCode } from 'hypaware/core/util'
import { defaultPlistDir } from './platform.js'
import { runServiceCommand } from './service_ops.js'

/**
 * Remove and inspect the launchd environment left by legacy proxy attach.
 * OTEL attach no longer installs it, but disk-driven detach must still undo
 * the environment variable and login-time LaunchAgent on older installs.
 * @ref LLP 0258#nothing-else [constrained-by]: current attach writes no launchd environment
 *
 * In core rather than the claude plugin because the disk-driven detach undo
 * (LLP 0045 Part 3) must reverse it with no plugin loaded.
 *
 * @import { TrustCommandRunner } from '../../../src/core/tls/types.js'
 */

export const ENV_VAR_NAME = 'NODE_USE_SYSTEM_CA'
export const ENV_VAR_VALUE = '1'

/**
 * Reverse-DNS label for the env LaunchAgent, distinct from the daemon's
 * `com.hyperparam.hypaware` so the two cannot shadow each other.
 */
export const ENV_AGENT_LABEL = 'com.hyperparam.hypaware.node-system-ca'

/** @type {TrustCommandRunner} */
const defaultRunner = (cmd, args) => runServiceCommand(cmd, args)

/**
 * Where the env LaunchAgent plist lives.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function envAgentPlistPath(homeDir) {
  return path.join(defaultPlistDir(homeDir), `${ENV_AGENT_LABEL}.plist`)
}

/**
 * Unset the variable and remove the LaunchAgent. Idempotent: `launchctl
 * unsetenv` succeeds for an absent variable and a missing plist is the
 * desired end state.
 *
 * @param {object} args
 * @param {string} [args.homeDir]
 * @param {TrustCommandRunner} [args.run]
 * @returns {Promise<{ unset: boolean, removedPlist: boolean, detail?: string }>}
 */
export async function removeLaunchdEnv({ homeDir, run = defaultRunner } = {}) {
  const result = await run('launchctl', ['unsetenv', ENV_VAR_NAME])
  const unset = result.exitCode === 0
  let removedPlist = false
  try {
    await fsp.unlink(envAgentPlistPath(homeDir))
    removedPlist = true
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err
  }
  if (unset) return { unset, removedPlist }
  return {
    unset,
    removedPlist,
    detail: (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`,
  }
}

/**
 * Whether the variable is present in the launchd user environment, for
 * `hyp status` style reporting. `timeoutMs` bounds the spawn, for the same
 * reason `isCaTrusted` takes one: a status run has nobody waiting on it who
 * could decide to give up.
 *
 * @param {object} args
 * @param {TrustCommandRunner} [args.run]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isLaunchdEnvSet({ run, timeoutMs } = {}) {
  const runner = run ?? ((cmd, args) => runServiceCommand(cmd, args, { timeoutMs }))
  const result = await runner('launchctl', ['getenv', ENV_VAR_NAME])
  return result.exitCode === 0 && result.stdout.trim() === ENV_VAR_VALUE
}
