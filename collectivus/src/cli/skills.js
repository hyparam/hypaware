import process from 'node:process'
import { installSkillBundle as defaultInstallSkillBundle } from '../skills/install.js'

/**
 * @import { SkillInstallClient, SkillInstallResult } from '../skills/types.d.ts'
 * @import { SkillsHooks, SkillsParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs skills install [--client claude|codex|all] [--force] [--dry-run]

Options:
  --client <name>  Tool to install into: claude, codex, or all (default: all)
  --force          Overwrite an existing unmanaged skill directory
  --dry-run        Print target paths without writing files
  --help, -h       Show this help`

/**
 * @param {string[]} argv
 * @returns {SkillsParseResult}
 */
export function parseSkillsArgs(argv) {
  /** @type {SkillsParseResult} */
  const r = { command: 'install', client: 'all', force: false, dryRun: false, help: false }
  if (argv.length === 0) {
    r.help = true
    return r
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      r.help = true
      return r
    }
    if (i === 0) {
      if (arg !== 'install') {
        r.error = `unknown skills command: ${arg}`
        return r
      }
      r.command = 'install'
      continue
    }
    if (arg === '--force') {
      r.force = true
      continue
    }
    if (arg === '--dry-run') {
      r.dryRun = true
      continue
    }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires claude, codex, or all'; return r }
      if (!isSkillClient(value)) {
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
 * Run `ctvs skills`.
 *
 * @param {string[]} argv
 * @param {SkillsHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runSkills(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const installSkillBundle = hooks.installSkill ?? defaultInstallSkillBundle

  const parsed = parseSkillsArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  /** @type {SkillInstallResult} */
  let result
  try {
    result = await installSkillBundle({
      client: parsed.client,
      force: parsed.force,
      dryRun: parsed.dryRun,
      homeDir: hooks.homeDir,
      codexHome: hooks.codexHome,
      sourceDir: hooks.sourceDir,
    })
  } catch (err) {
    stderr.write(`error: failed to install collectivus skills: ${formatError(err)}\n`)
    return 1
  }

  for (const destination of result.destinations) {
    const verb = parsed.dryRun
      ? destination.action === 'would-update' ? 'Would update' : 'Would install'
      : destination.action === 'updated' ? 'Updated' : 'Installed'
    stdout.write(`✓ ${verb} ${clientLabel(destination.client)} skill (${destination.path})\n`)
  }
  return 0
}

/**
 * @param {unknown} value
 * @returns {value is SkillInstallClient}
 */
function isSkillClient(value) {
  return value === 'claude' || value === 'codex' || value === 'all'
}

/**
 * @param {'claude' | 'codex'} client
 * @returns {string}
 */
function clientLabel(client) {
  return client === 'claude' ? 'Claude Code' : 'Codex'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
