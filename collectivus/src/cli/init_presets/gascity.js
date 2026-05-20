import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadConfigAsync as defaultLoadConfig } from '../../config.js'
import { resolveQueryPaths } from '../../query/paths.js'
import {
  listCollections,
  refreshCollectionCache,
  registerCollection,
} from '../../query/collections.js'
import { defaultConfigPath } from '../common.js'

/**
 * @import { CollectivusConfig } from '../../types.js'
 */

const SKILL_TEMPLATE_PATH = fileURLToPath(new URL('./gascity_skill.md', import.meta.url))
const EVENTS_TABLE = 'events'
const SEGMENTS_TABLE = 'session_segments'

const USAGE = `Usage:
  ctvs init gascity [--cwd <path>] [--config <path|url>] [--cache-dir <dir>] [--replace]

Register canonical gascity recordings as ctvs query tables, and drop a project-local
Claude Code skill that teaches agents how to use them.

The current directory must be a gascity workspace (contain a \`.gc/\` directory).

Options:
  --cwd <path>           Gascity root (defaults to the current working directory)
  --config <path|url>    Collectivus config (default: ~/.hyp/collectivus.json)
  --cache-dir <dir>    Query-cache directory override
  --replace              Re-register and re-materialize existing collections
  --help, -h             Show this help`

/**
 * @typedef {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   cwd?: string,
 *   loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>,
 *   readSkillTemplate?: () => string,
 * }} GascityPresetHooks
 */

/**
 * @param {string[]} argv
 * @param {GascityPresetHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runGascityPreset(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const cwd0 = hooks.cwd ?? process.cwd()

  /** @type {{ cwd: string, configPath: string, cacheDir?: string, replace: boolean }} */
  const opts = {
    cwd: cwd0,
    configPath: defaultConfigPath(),
    replace: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      stdout.write(USAGE + '\n')
      return 0
    }
    if (arg === '--replace') {
      opts.replace = true
      continue
    }
    /**
     * @param {string} name
     * @returns {string | undefined}
     */
    function readValue(name) {
      const eq = `${name}=`
      if (arg.startsWith(eq)) return arg.slice(eq.length)
      if (arg === name) return argv[++i]
    }
    const cwd = readValue('--cwd')
    if (cwd !== undefined) {
      if (!cwd) { stderr.write('error: --cwd requires a path\n'); return 2 }
      opts.cwd = path.resolve(cwd0, cwd)
      continue
    }
    const cfg = readValue('--config')
    if (cfg !== undefined) {
      if (!cfg) { stderr.write('error: --config requires a path or URL\n'); return 2 }
      opts.configPath = cfg
      continue
    }
    const cacheDir = readValue('--cache-dir')
    if (cacheDir !== undefined) {
      if (!cacheDir) { stderr.write('error: --cache-dir requires a directory\n'); return 2 }
      opts.cacheDir = cacheDir
      continue
    }
    stderr.write(`error: unknown argument: ${arg}\n\n${USAGE}\n`)
    return 2
  }

  const gcRoot = opts.cwd
  if (!isGascityRoot(gcRoot)) {
    stderr.write(`error: not a gascity workspace — no \`.gc/\` found at ${gcRoot}\n`)
    stderr.write('Run this command from a gascity workspace, or pass --cwd <path>.\n')
    return 1
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await (hooks.loadConfig ?? defaultLoadConfig)(opts.configPath)
  } catch (err) {
    stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  let paths
  try {
    paths = resolveQueryPaths(config, opts.configPath, opts.cacheDir)
  } catch (err) {
    stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (!paths.cacheEnabled || !paths.cacheDir) {
    stderr.write('error: query cache is disabled; pass --cache-dir explicitly\n')
    return 1
  }

  const eventsPath = path.join(gcRoot, '.gc', 'events.jsonl')
  const segmentsGlob = path.join(gcRoot, '.gc', 'runtime', 'session-reconciler-trace', 'segments', '**', '*.jsonl')

  // Register events (single file)
  if (!fs.existsSync(eventsPath)) {
    stderr.write(`warning: ${eventsPath} not found — skipping events table\n`)
  } else {
    const existing = findCollection(paths.recordingRoot, EVENTS_TABLE)
    if (existing && existing.source_path !== eventsPath && !opts.replace) {
      stderr.write(`error: collection "${EVENTS_TABLE}" already registered with a different source (${existing.source_path}); pass --replace to overwrite\n`)
      return 1
    }
    if (!existing || opts.replace) {
      registerCollection({
        recordingRoot: paths.recordingRoot,
        filePath: eventsPath,
        name: EVENTS_TABLE,
        timestampColumn: 'ts',
        replace: true,
      })
    }
  }

  // Register session_segments (glob)
  const existingSegments = findCollection(paths.recordingRoot, SEGMENTS_TABLE)
  if (existingSegments && existingSegments.source_glob !== segmentsGlob && !opts.replace) {
    stderr.write(`error: collection "${SEGMENTS_TABLE}" already registered with a different source; pass --replace to overwrite\n`)
    return 1
  }
  if (!existingSegments || opts.replace) {
    registerCollection({
      recordingRoot: paths.recordingRoot,
      glob: segmentsGlob,
      name: SEGMENTS_TABLE,
      timestampColumn: 'ts',
      replace: true,
    })
  }

  // Refresh both tables
  const refreshResult = await refreshCollectionCache({
    paths,
    scope: { datasets: [EVENTS_TABLE, SEGMENTS_TABLE], limit: 100 },
    force: opts.replace,
    stdout,
  })

  // Write the project-local skill
  const skillDir = path.join(gcRoot, '.claude', 'skills', 'ctvs-gascity')
  const skillPath = path.join(skillDir, 'SKILL.md')
  const desired = (hooks.readSkillTemplate ?? defaultReadSkillTemplate)()
  fs.mkdirSync(skillDir, { recursive: true })
  let existingSkill
  try {
    existingSkill = fs.readFileSync(skillPath, 'utf8')
  } catch {
    existingSkill = undefined
  }
  if (existingSkill === undefined) {
    fs.writeFileSync(skillPath, desired)
    stdout.write(`wrote ${skillPath}\n`)
  } else if (existingSkill === desired) {
    stdout.write(`skill already up-to-date at ${skillPath}\n`)
  } else {
    const newPath = `${skillPath}.new`
    fs.writeFileSync(newPath, desired)
    stdout.write(`existing skill differs; wrote new version to ${newPath} (review and merge)\n`)
  }

  stdout.write('\nSummary:\n')
  stdout.write(`  events:            ${describeRefresh(refreshResult.files.filter((f) => f.dataset === EVENTS_TABLE))}\n`)
  stdout.write(`  session_segments:  ${describeRefresh(refreshResult.files.filter((f) => f.dataset === SEGMENTS_TABLE))}\n`)
  stdout.write('\nQuery with: ctvs query catalog\n')
  return refreshResult.failures === 0 ? 0 : 1
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function isGascityRoot(root) {
  if (!root) return false
  if (isDir(path.join(root, '.gc'))) return true
  return false
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string} recordingRoot
 * @param {string} table
 * @returns {ReturnType<typeof listCollections>[number] | undefined}
 */
function findCollection(recordingRoot, table) {
  return listCollections(recordingRoot).find((c) => c.table === table)
}

/**
 * @returns {string}
 */
function defaultReadSkillTemplate() {
  return fs.readFileSync(SKILL_TEMPLATE_PATH, 'utf8')
}

/**
 * @param {Array<{ rows: number, status: string }>} files
 * @returns {string}
 */
function describeRefresh(files) {
  if (files.length === 0) return 'no files (source not registered)'
  const rows = files.reduce((sum, f) => sum + (f.rows ?? 0), 0)
  const written = files.filter((f) => f.status === 'written').length
  const skipped = files.filter((f) => f.status === 'skipped').length
  const failed = files.filter((f) => f.status === 'failed').length
  const parts = [`${rows} row(s)`, `${written} written`, `${skipped} fresh`]
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.join(', ')
}
