import process from 'node:process'
import { IgnoreFilter, defaultIgnoreConfigPath, normalizeIgnorePath } from '../ignore.js'

/**
 * @import { IgnoreCliHooks, IgnoreParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs ignore add <path>      Ignore Claude requests originating from <path> and its descendants
  ctvs ignore remove <path>   Remove a previously registered ignore path
  ctvs ignore list            Print the registered ignore paths, one per line

Options:
  --help, -h                  Show this help

Paths are resolved against the current working directory, symlink-followed via
realpath, and stored as absolute paths in ~/.hyp/collectivus.json.`

/**
 * @param {string[]} argv
 * @returns {IgnoreParseResult}
 */
export function parseIgnoreArgs(argv) {
  if (argv.length === 0) return { help: true }
  const first = argv[0]
  if (first === '--help' || first === '-h') return { help: true }
  if (first === 'add' || first === 'remove') {
    /** @type {string | undefined} */
    let target
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--help' || arg === '-h') return { help: true }
      if (target !== undefined) return { error: `unexpected argument: ${arg}` }
      target = arg
    }
    if (!target) return { error: `${first} requires a path argument` }
    return { command: first, path: target }
  }
  if (first === 'list') {
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--help' || arg === '-h') return { help: true }
      return { error: `unexpected argument: ${arg}` }
    }
    return { command: 'list' }
  }
  return { error: `unknown ignore command: ${first}` }
}

/**
 * Run `ctvs ignore ...`. Reads and writes `~/.hyp/collectivus.json` directly
 * (the proxy reloads at next request because the filter consults its in-memory
 * copy; a long-running proxy daemon picks up changes the next time `load()`
 * runs — see DESIGN docs for the daemon-restart contract).
 *
 * @param {string[]} argv
 * @param {IgnoreCliHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runIgnore(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const cwd = hooks.cwd ?? process.cwd()
  const configPath = hooks.configPath ?? defaultIgnoreConfigPath(hooks.homeDir)

  const parsed = parseIgnoreArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  const filter = hooks.filter ?? new IgnoreFilter({ configPath })
  await filter.load({ stderr })

  if (parsed.command === 'list') {
    for (const p of filter.listPaths()) {
      stdout.write(p + '\n')
    }
    return 0
  }

  /** @type {string} */
  let normalized
  try {
    normalized = normalizeIgnorePath(parsed.path, { cwd })
  } catch (err) {
    stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (parsed.command === 'add') {
    const { added } = await filter.addPath(normalized)
    if (added) {
      stdout.write(`✓ Ignoring ${normalized}\n`)
    } else {
      stdout.write(`(already ignoring ${normalized})\n`)
    }
    return 0
  }
  // remove
  const { removed } = await filter.removePath(normalized)
  if (removed) {
    stdout.write(`✓ Removed ${normalized}\n`)
  } else {
    stderr.write(`error: ${normalized} was not in the ignore list\n`)
    return 1
  }
  return 0
}
