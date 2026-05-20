import process from 'node:process'
import { detach as defaultDetachClaude, defaultSettingsPath } from '../claude-code/settings.js'
import { defaultConfigPath as defaultCodexConfigPath, detach as defaultDetachCodex } from '../codex/settings.js'

/**
 * @import { DetachHooks, DetachParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs detach [--client claude|codex|all]

Removes the collectivus-managed config from Claude Code and/or Codex.
Safe no-op when no marker is present.

Options:
  --client <name>   Tool to restore: claude, codex, or all (default: claude)
  --help, -h        Show this help`

/**
 * @param {string[]} argv
 * @returns {DetachParseResult}
 */
export function parseDetachArgs(argv) {
  /** @type {DetachParseResult} */
  const r = { help: false, client: 'claude' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      r.help = true
      return r
    }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires claude, codex, or all'; return r }
      if (value !== 'claude' && value !== 'codex' && value !== 'all') {
        r.error = `--client: expected claude, codex, or all (got "${value}")`
        return r
      }
      r.client = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * Run `collectivus detach`.
 *
 * @param {string[]} argv
 * @param {DetachHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runDetach(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const detachClaude = hooks.detachClaude ?? hooks.detach ?? defaultDetachClaude
  const detachCodex = hooks.detachCodex ?? defaultDetachCodex
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const codexConfigPath = hooks.codexConfigPath ?? defaultCodexConfigPath()

  const parsed = parseDetachArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  for (const client of selectedClients(parsed.client)) {
    if (client === 'claude') {
      try {
        const result = await detachClaude({ settingsPath })
        writeClaudeResult(stdout, settingsPath, result)
      } catch (err) {
        stderr.write(`error: failed to detach Claude Code: ${formatError(err)}\n`)
        return 1
      }
    } else {
      try {
        const result = await detachCodex({ configPath: codexConfigPath })
        writeCodexResult(stdout, codexConfigPath, result)
      } catch (err) {
        stderr.write(`error: failed to detach Codex: ${formatError(err)}\n`)
        return 1
      }
    }
  }
  return 0
}

/**
 * @param {'claude' | 'codex' | 'all'} client
 * @returns {Array<'claude' | 'codex'>}
 */
function selectedClients(client) {
  return client === 'all' ? ['claude', 'codex'] : [client]
}

/**
 * @param {{ write: (s: string) => void }} stdout
 * @param {string} settingsPath
 * @param {{ changed: boolean, removed?: string, warning?: string }} result
 * @returns {void}
 */
function writeClaudeResult(stdout, settingsPath, result) {
  if (!result.changed) {
    stdout.write(`No collectivus marker found in ${settingsPath}; nothing to do.\n`)
    return
  }
  stdout.write(`✓ Claude Code reverted (${settingsPath})\n`)
  if (result.removed !== undefined) {
    stdout.write(`  Removed ANTHROPIC_BASE_URL=${result.removed}\n`)
  }
  if (result.warning !== undefined) {
    stdout.write(`  warning: ${result.warning}\n`)
  }
}

/**
 * @param {{ write: (s: string) => void }} stdout
 * @param {string} configPath
 * @param {{ changed: boolean, removed?: string, restoredValue?: string, warning?: string }} result
 * @returns {void}
 */
function writeCodexResult(stdout, configPath, result) {
  if (!result.changed) {
    stdout.write(`No collectivus marker found in ${configPath}; nothing to do.\n`)
    return
  }
  stdout.write(`✓ Codex reverted (${configPath})\n`)
  if (result.removed !== undefined) {
    stdout.write(`  Removed base_url=${result.removed}\n`)
  }
  if (result.restoredValue !== undefined) {
    stdout.write(`  Restored model_provider=${result.restoredValue}\n`)
  }
  if (result.warning !== undefined) {
    stdout.write(`  warning: ${result.warning}\n`)
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
