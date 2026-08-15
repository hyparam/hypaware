// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteFile, errCode } from 'hypaware/core/util'
import { defaultPlistDir } from './platform.js'
import { runServiceCommand } from './service_ops.js'

/**
 * The launchd user-environment delivery for `NODE_USE_SYSTEM_CA=1`.
 *
 * The variable must be in the real process environment when Claude Code
 * boots - the Bun runtime fixes its default trust store before any
 * JavaScript runs, so settings.json env (applied after startup) can never
 * carry it. `launchctl setenv` covers every process launched in the login
 * session from now on, and a LaunchAgent whose only job is to re-run the
 * same command re-applies it at login.
 * @ref LLP 0236#boot-time-env [constrained-by]: no config file reaches the Bun trust store
 * @ref LLP 0239#launchctl-setenv [implements]
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
 * The plist XML for the env LaunchAgent. `RunAtLoad` with no `KeepAlive`:
 * the program runs once per login, sets the variable, and exits. The agent
 * is inert configuration, not a resident process.
 *
 * @returns {string}
 */
export function buildEnvAgentPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${ENV_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/launchctl</string>',
    '    <string>setenv</string>',
    `    <string>${ENV_VAR_NAME}</string>`,
    `    <string>${ENV_VAR_VALUE}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/**
 * Set the variable in the launchd user environment now and persist the
 * LaunchAgent that re-applies it at login.
 *
 * `launchctl setenv` reaches only processes launchd starts after this call
 * (GUI apps, and terminal apps relaunched from scratch). New windows of an
 * already-running terminal app inherit the app's environment from before the
 * call, so they do NOT see the variable; the app must be fully quit and
 * reopened. The caller owns telling the user that
 * (LLP 0239#terminals-predating-attach).
 *
 * @param {object} args
 * @param {string} [args.homeDir]
 * @param {TrustCommandRunner} [args.run]
 * @returns {Promise<{ set: boolean, plistPath: string, detail?: string }>}
 */
export async function installLaunchdEnv({ homeDir, run = defaultRunner } = {}) {
  const plistPath = envAgentPlistPath(homeDir)
  const result = await run('launchctl', ['setenv', ENV_VAR_NAME, ENV_VAR_VALUE])
  if (result.exitCode !== 0) {
    return {
      set: false,
      plistPath,
      detail: (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`,
    }
  }
  await fsp.mkdir(path.dirname(plistPath), { recursive: true })
  await atomicWriteFile(plistPath, buildEnvAgentPlist(), { mode: 0o644 })
  return { set: true, plistPath }
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
 * `hyp status` style reporting.
 *
 * @param {object} args
 * @param {TrustCommandRunner} [args.run]
 * @returns {Promise<boolean>}
 */
export async function isLaunchdEnvSet({ run = defaultRunner } = {}) {
  const result = await run('launchctl', ['getenv', ENV_VAR_NAME])
  return result.exitCode === 0 && result.stdout.trim() === ENV_VAR_VALUE
}
