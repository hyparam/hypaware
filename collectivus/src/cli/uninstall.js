import process from 'node:process'
import { detach as defaultDetachClaude, isAttached as defaultIsClaudeAttached, defaultSettingsPath } from '../claude-code/settings.js'
import { defaultConfigPath as defaultCodexConfigPath, detach as defaultDetachCodex, isAttached as defaultIsCodexAttached } from '../codex/settings.js'
import { LAUNCH_AGENT_LABEL, daemonKindLabel } from './common.js'
import { uninstallDaemon } from '../daemon/index.js'

/**
 * @import { UninstallHooks, UninstallParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs uninstall

Removes the daemon and reverts any attached clients (Claude Code, Codex).

Options:
  --help, -h        Show this help`

/**
 * Parse the argument list of `collectivus uninstall`.
 *
 * @param {string[]} argv
 * @returns {UninstallParseResult}
 */
export function parseUninstallArgs(argv) {
  /** @type {UninstallParseResult} */
  const r = { help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * Run `collectivus uninstall`.
 *
 * Removes the daemon, then unconditionally reverts any attached clients
 * (Claude Code, Codex). Idempotent: clients that are not attached are
 * reported and skipped.
 *
 * @param {string[]} argv
 * @param {UninstallHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runUninstall(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const uninstallFn = hooks.uninstallLaunchAgent ?? uninstallDaemon
  const detachClaude = hooks.detachClaude ?? hooks.detach ?? defaultDetachClaude
  const detachCodex = hooks.detachCodex ?? defaultDetachCodex
  const isClaudeAttached = hooks.isClaudeAttached ?? hooks.isAttached ?? defaultIsClaudeAttached
  const isCodexAttached = hooks.isCodexAttached ?? defaultIsCodexAttached
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const codexConfigPath = hooks.codexConfigPath ?? defaultCodexConfigPath()

  const parsed = parseUninstallArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  try {
    await uninstallFn({
      label: LAUNCH_AGENT_LABEL,
      ...hooks.plistDir !== undefined ? { plistDir: hooks.plistDir } : {},
    })
  } catch (err) {
    stderr.write(`error: failed to uninstall daemon: ${formatError(err)}\n`)
    return 1
  }
  stdout.write(`✓ Daemon removed (${daemonKindLabel()})\n`)

  try {
    if (await isClaudeAttached({ settingsPath })) {
      const result = await detachClaude({ settingsPath })
      if (result.changed) {
        stdout.write(`✓ Claude Code reverted (${settingsPath})\n`)
        if (result.warning) stdout.write(`  warning: ${result.warning}\n`)
      } else {
        stdout.write('  Claude Code: no marker found, nothing to revert\n')
      }
    } else {
      stdout.write('  Claude Code: not attached\n')
    }
  } catch (err) {
    stderr.write(`error: failed to revert Claude Code: ${formatError(err)}\n`)
    return 1
  }

  try {
    if (await isCodexAttached({ configPath: codexConfigPath })) {
      const result = await detachCodex({ configPath: codexConfigPath })
      if (result.changed) {
        stdout.write(`✓ Codex reverted (${codexConfigPath})\n`)
        if (result.removed) stdout.write(`  Removed base_url=${result.removed}\n`)
        if (result.restoredValue) stdout.write(`  Restored model_provider=${result.restoredValue}\n`)
        if (result.warning) stdout.write(`  warning: ${result.warning}\n`)
      } else {
        stdout.write('  Codex: no marker found, nothing to revert\n')
      }
    } else {
      stdout.write('  Codex: not attached\n')
    }
  } catch (err) {
    stderr.write(`error: failed to revert Codex: ${formatError(err)}\n`)
    return 1
  }

  return 0
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
