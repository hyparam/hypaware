import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { backfillSession } from '../gascity/backfill.js'
import { readCursor } from '../gascity/cursor.js'
import { NormalizerDispatcher } from '../gascity/normalizer_dispatcher.js'
import { registerProductionNormalizers } from '../gascity/normalizers/index.js'
import { ParquetWriter } from '../gascity/parquet_writer.js'
import { cursorsDir, defaultGascityRoot } from '../gascity/paths.js'
import { readRuntimeState } from '../gascity/runtime_state.js'
import { defaultGascityStatePath, defaultPidFilePath } from '../runtime/paths.js'
import { readPidFile } from '../runtime/pid_file.js'
import { ConfigError, loadConfig, parseConfig } from '../config.js'
import { defaultConfigPath } from './common.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import { GascityCityConfig, GascityRuntimeState } from '../gascity/types.d.ts'
 */

/**
 * @typedef {object} GascityHooks
 * @property {{ write: (s: string) => void }} [stdout]
 * @property {{ write: (s: string) => void }} [stderr]
 * @property {string} [configPath]                                   Override default `~/.hyp/collectivus.json`.
 * @property {string} [pidFilePath]                                  Override default daemon PID file location.
 * @property {string} [statePath]                                    Override default `~/.collectivus/runtime/gascity-state.json`.
 * @property {string} [sinkRoot]                                     Override the gascity sink root (mostly for backfill).
 * @property {(pid: number, signal: NodeJS.Signals | number) => void} [signalDaemon] Send a signal to the daemon (default `process.kill`).
 * @property {(pidPath: string) => Promise<number | undefined>} [readPid]            Override PID lookup.
 * @property {(statePath: string) => Promise<GascityRuntimeState | undefined>} [readState] Override state file lookup.
 * @property {typeof fetch} [fetchFn]                                Used by `attach` (auto-discover api_url) and `status` (reachability probe).
 * @property {(ms: number) => Promise<void>} [sleep]                 Used to poll the runtime state file in `attach`; tests override.
 * @property {() => Date} [now]                                      Deterministic clock for tests.
 */

const TOP_USAGE = `Usage:
  ctvs gascity <subcommand> [options]

Subcommands:
  attach <city|path> [--api-url <url>]   Add a [[gascity]] entry and reload the daemon
  detach <city>                          Remove a [[gascity]] entry and retire its workers
  list [--json]                          Show attached cities and per-session capture status
  backfill <city> [--since <duration>] [--all]
                                         Walk transcript history per session via /transcript
  status [--json]                        Gascity-source-specific health summary
  --help, -h                             Show this help

The daemon is reloaded by sending SIGHUP. Without a running daemon attach/detach
still mutate the config so the next \`ctvs install\` picks the new entries up.
`

const DEFAULT_GASCITY_API_URL = 'http://127.0.0.1:8372'

/**
 * Top-level dispatch for `ctvs gascity <sub>`.
 *
 * @param {string[]} argv
 * @param {GascityHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runGascity(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const sub = argv[0]
  const subArgs = argv.slice(1)
  if (sub === undefined || sub === '--help' || sub === '-h') {
    stdout.write(TOP_USAGE)
    return sub === undefined ? 2 : 0
  }
  switch (sub) {
  case 'attach': return runAttach(subArgs, hooks)
  case 'detach': return runDetach(subArgs, hooks)
  case 'list': return runList(subArgs, hooks)
  case 'backfill': return runBackfill(subArgs, hooks)
  case 'status': return runStatus(subArgs, hooks)
  default:
    stderr.write(`error: unknown gascity subcommand: ${sub}\n\n${TOP_USAGE}`)
    return 2
  }
}

// =============================================================================
// attach
// =============================================================================

const ATTACH_USAGE = `Usage:
  ctvs gascity attach <city-name-or-path> [--api-url <url>] [--config <path>]

Adds a [[gascity]] entry to the collectivus config and signals the running
daemon (SIGHUP) to start capturing. When <city-name-or-path> is a directory
the city name and api_url are inferred from its city.toml. Otherwise the city
name is used as given and api_url defaults to ${DEFAULT_GASCITY_API_URL}.

Options:
  --api-url <url>    Supervisor base URL (default: ${DEFAULT_GASCITY_API_URL})
  --config <path>    collectivus config to edit (default: ~/.hyp/collectivus.json)
  --no-wait          Don't block on the first lifecycle event
  --help, -h         Show this help
`

/**
 * @typedef {object} AttachParseResult
 * @property {string} [target]
 * @property {string} [apiUrl]
 * @property {string} [configPath]
 * @property {boolean} noWait
 * @property {boolean} help
 * @property {string} [error]
 */

/**
 * @param {string[]} argv
 * @returns {AttachParseResult}
 */
export function parseAttachArgs(argv) {
  /** @type {AttachParseResult} */
  const r = { noWait: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    if (arg === '--no-wait') { r.noWait = true; continue }
    if (arg === '--api-url' || arg.startsWith('--api-url=')) {
      const value = arg === '--api-url' ? argv[++i] : arg.slice('--api-url='.length)
      if (!value) { r.error = '--api-url requires a value'; return r }
      r.apiUrl = value
      continue
    }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (arg.startsWith('-')) {
      r.error = `unknown argument: ${arg}`
      return r
    }
    if (r.target !== undefined) {
      r.error = `unexpected positional argument: ${arg}`
      return r
    }
    r.target = arg
  }
  if (!r.help && r.target === undefined) {
    r.error = 'attach requires a city name or path'
  }
  return r
}

/**
 * Run `ctvs gascity attach`.
 *
 * @param {string[]} argv
 * @param {GascityHooks} hooks
 * @returns {Promise<number>}
 */
export async function runAttach(argv, hooks) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseAttachArgs(argv)
  if (parsed.help) {
    stdout.write(ATTACH_USAGE)
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${ATTACH_USAGE}`)
    return 2
  }
  const configPath = parsed.configPath ?? hooks.configPath ?? defaultConfigPath()
  const target = /** @type {string} */ parsed.target
  /** @type {GascityCityConfig} */
  let entry
  try {
    entry = await resolveCityEntry(target, parsed.apiUrl)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  /** @type {Record<string, unknown>} */
  let configObj
  try {
    configObj = await readConfigObject(configPath)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  const before = (Array.isArray(configObj.gascity) ? configObj.gascity : []).slice()
  /** @type {GascityCityConfig[]} */
  const after = []
  let replaced = false
  for (const existing of before) {
    if (isObject(existing) && existing.name === entry.name) {
      after.push(entry)
      replaced = true
    } else if (isObject(existing) && typeof existing.name === 'string') {
      after.push(/** @type {GascityCityConfig} */ (/** @type {unknown} */ (existing)))
    }
  }
  if (!replaced) after.push(entry)
  configObj.gascity = after
  try {
    await writeConfigObject(configPath, configObj)
  } catch (err) {
    stderr.write(`error: failed to write ${configPath}: ${formatError(err)}\n`)
    return 1
  }
  stdout.write(`✓ ${replaced ? 'updated' : 'attached'}: ${entry.name} via ${entry.api_url}\n`)
  // Push the change to the running daemon (or warn the user when there isn't
  // one). The daemon's SIGHUP handler re-reads the config and applies the
  // diff via the gascity source's applyCityDiff method.
  const reload = await reloadRunningDaemon(hooks, stdout, stderr)
  if (reload === 'no-daemon') {
    stdout.write('  No running daemon — config saved; the next `ctvs install` will pick this up.\n')
    return 0
  }
  if (reload === 'failed') return 1
  if (parsed.noWait) return 0
  await waitForLifecycleEvent(entry.name, hooks, stdout, stderr)
  return 0
}

/**
 * Read the config file as a plain JSON object so we can mutate the
 * `gascity` array surgically. Validates the result against `parseConfig`
 * to surface schema errors at edit time rather than at next daemon load.
 *
 * @param {string} configPath
 * @returns {Promise<Record<string, unknown>>}
 */
async function readConfigObject(configPath) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      // No config yet — start a minimal one. The user will hit `ctvs install`
      // / `ctvs init` later anyway.
      return {}
    }
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`config ${configPath} is not valid JSON: ${formatError(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config ${configPath} must be a JSON object`)
  }
  return /** @type {Record<string, unknown>} */ (parsed)
}

/**
 * Write the config back atomically (tmp + rename). Validates the new
 * shape against the existing schema validator so we never persist an
 * invalid edit.
 *
 * @param {string} configPath
 * @param {Record<string, unknown>} obj
 * @returns {Promise<void>}
 */
async function writeConfigObject(configPath, obj) {
  const json = JSON.stringify(obj, null, 2) + '\n'
  // Validate by re-parsing through the strict-aware loader. Surface a
  // ConfigError as a thrown Error so the caller's catch path runs.
  parseConfig(json, configPath, {})
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp.${process.pid}`
  await fs.writeFile(tmp, json, 'utf8')
  await fs.rename(tmp, configPath)
}

/**
 * Resolve `target` (a name or filesystem path) into a `GascityCityConfig`.
 *
 *  - If `target` is a directory containing `city.toml`, parse that to
 *    derive the name + api_url. We use a tiny inline TOML reader that
 *    handles only the fields we need (name + api).
 *  - Otherwise treat `target` as the city name and use the default api_url.
 *
 * @param {string} target
 * @param {string | undefined} apiUrl
 * @returns {Promise<GascityCityConfig>}
 */
export async function resolveCityEntry(target, apiUrl) {
  /** @type {import('node:fs').Stats | undefined} */
  let stats
  try {
    stats = await fs.stat(target)
  } catch {
    stats = undefined
  }
  if (stats && stats.isDirectory()) {
    const cityToml = path.join(target, 'city.toml')
    /** @type {string | undefined} */
    let inferredName
    /** @type {string | undefined} */
    let inferredApi
    try {
      const raw = await fs.readFile(cityToml, 'utf8')
      const parsed = parseSimpleToml(raw)
      const nameVal = parsed.get('name')
      if (typeof nameVal === 'string') inferredName = nameVal
      const apiVal = parsed.get('api') ?? parsed.get('api_url')
      if (typeof apiVal === 'string') inferredApi = apiVal
    } catch (err) {
      throw new Error(`failed to read ${cityToml}: ${formatError(err)}`)
    }
    if (!inferredName) {
      throw new Error(`${cityToml} did not provide a string \`name\``)
    }
    const finalApiUrl = apiUrl ?? inferredApi ?? await discoverApiUrl(target) ?? DEFAULT_GASCITY_API_URL
    return { name: inferredName, api_url: finalApiUrl }
  }
  return { name: target, api_url: apiUrl ?? DEFAULT_GASCITY_API_URL }
}

/**
 * Try to read a Hyptown-style runtime state file under `cityPath` for an
 * `api_url` hint. Returns undefined when nothing useful is found —
 * caller falls back to requiring `--api-url`. We try a couple of common
 * shapes so an attach against a freshly-booted city works without the
 * user knowing the supervisor port.
 *
 * @param {string} cityPath
 * @returns {Promise<string | undefined>}
 */
async function discoverApiUrl(cityPath) {
  const candidates = [
    path.join(cityPath, '.runtime', 'supervisor.json'),
    path.join(cityPath, '.runtime', 'api.json'),
    path.join(cityPath, '.gc', 'runtime', 'supervisor.json'),
  ]
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const obj = /** @type {Record<string, unknown>} */ parsed
        const url = obj.url ?? obj.api_url ?? obj.base_url
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * Tiny TOML reader sufficient for `city.toml` discovery: top-level
 * `key = "value"` and `key = number/bool` lines, with `#` comments and
 * blank lines stripped. We deliberately don't pull in a real TOML
 * parser — this code path only needs the `name` + `api`/`api_url`
 * fields, and adding a full parser dependency just for that is overkill.
 *
 * @param {string} raw
 * @returns {Map<string, string | number | boolean>}
 */
function parseSimpleToml(raw) {
  /** @type {Map<string, string | number | boolean>} */
  const out = new Map()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('[')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, '')
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      out.set(key, JSON.parse(value))
      continue
    }
    if (value === 'true' || value === 'false') {
      out.set(key, value === 'true')
      continue
    }
    const num = Number(value)
    if (Number.isFinite(num)) {
      out.set(key, num)
      continue
    }
    out.set(key, value)
  }
  return out
}

/**
 * Send SIGHUP to the running daemon (looked up via the PID file). Returns
 * `'sent'` on success, `'no-daemon'` when no live PID is found, or
 * `'failed'` when the signal could not be delivered (logged to stderr).
 *
 * @param {GascityHooks} hooks
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<'sent' | 'no-daemon' | 'failed'>}
 */
async function reloadRunningDaemon(hooks, stdout, stderr) {
  const pidPath = hooks.pidFilePath ?? defaultPidFilePath()
  const readPid = hooks.readPid ?? readPidFile
  /** @type {number | undefined} */
  let pid
  try {
    pid = await readPid(pidPath)
  } catch (err) {
    stderr.write(`warning: failed to read pid file ${pidPath}: ${formatError(err)}\n`)
    return 'failed'
  }
  if (pid === undefined) return 'no-daemon'
  const sender = hooks.signalDaemon ?? ((p, s) => process.kill(p, s))
  try {
    sender(pid, 'SIGHUP')
    stdout.write(`  Signaled daemon (pid ${pid}) to reload config\n`)
    return 'sent'
  } catch (err) {
    stderr.write(`warning: failed to signal daemon (pid ${pid}): ${formatError(err)}\n`)
    return 'failed'
  }
}

/**
 * Block (with a short timeout) on the gascity runtime-state file showing
 * a lifecycle event for the newly attached city. The bead's acceptance
 * criterion is that `ctvs gascity attach hyptown` followed by
 * `ctvs gascity list` shows active sessions within 5s — this poll loop
 * gives the daemon time to actually open the lifecycle SSE before we
 * hand control back. A timeout downgrades to a WARN so a flaky
 * supervisor doesn't fail the attach outright.
 *
 * @param {string} cityName
 * @param {GascityHooks} hooks
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<void>}
 */
async function waitForLifecycleEvent(cityName, hooks, stdout, stderr) {
  const statePath = hooks.statePath ?? defaultGascityStatePath()
  const sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const readState = hooks.readState ?? readRuntimeState
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    /** @type {GascityRuntimeState | undefined} */
    let state
    try {
      state = await readState(statePath)
    } catch (err) {
      stderr.write(`warning: failed to read gascity state: ${formatError(err)}\n`)
      return
    }
    const city = state?.cities.find((c) => c.name === cityName)
    if (city && (city.lifecycle_connected || city.lifecycle_last_event_at !== undefined || city.sessions.length > 0)) {
      stdout.write(`  Daemon picked up ${cityName} (lifecycle ${city.lifecycle_connected ? 'connected' : 'pending'})\n`)
      return
    }
    await sleep(250)
  }
  stderr.write(`warning: did not see a lifecycle event for ${cityName} within 10s; the daemon may catch up later\n`)
}

// =============================================================================
// detach
// =============================================================================

const DETACH_USAGE = `Usage:
  ctvs gascity detach <city> [--config <path>]

Removes the named [[gascity]] entry from the collectivus config and signals
the running daemon (SIGHUP). The daemon retires the city's session workers,
flushes pending buffers, and stamps cursors with retired=true so a later
backfill skips them.

Options:
  --config <path>   collectivus config to edit (default: ~/.hyp/collectivus.json)
  --help, -h        Show this help
`

/**
 * @typedef {object} DetachParseResult
 * @property {string} [city]
 * @property {string} [configPath]
 * @property {boolean} help
 * @property {string} [error]
 */

/**
 * @param {string[]} argv
 * @returns {DetachParseResult}
 */
export function parseDetachArgs(argv) {
  /** @type {DetachParseResult} */
  const r = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (arg.startsWith('-')) { r.error = `unknown argument: ${arg}`; return r }
    if (r.city !== undefined) { r.error = `unexpected positional argument: ${arg}`; return r }
    r.city = arg
  }
  if (!r.help && r.city === undefined) r.error = 'detach requires a city name'
  return r
}

/**
 * @param {string[]} argv
 * @param {GascityHooks} hooks
 * @returns {Promise<number>}
 */
export async function runDetach(argv, hooks) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseDetachArgs(argv)
  if (parsed.help) {
    stdout.write(DETACH_USAGE)
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${DETACH_USAGE}`)
    return 2
  }
  const configPath = parsed.configPath ?? hooks.configPath ?? defaultConfigPath()
  const cityName = /** @type {string} */ parsed.city
  /** @type {Record<string, unknown>} */
  let configObj
  try {
    configObj = await readConfigObject(configPath)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  const before = (Array.isArray(configObj.gascity) ? configObj.gascity : []).slice()
  /** @type {GascityCityConfig[]} */
  const after = []
  let removed = false
  for (const existing of before) {
    if (isObject(existing) && existing.name === cityName) {
      removed = true
      continue
    }
    if (isObject(existing) && typeof existing.name === 'string') {
      after.push(/** @type {GascityCityConfig} */ (/** @type {unknown} */ (existing)))
    }
  }
  if (!removed) {
    stderr.write(`warning: no [[gascity]] entry named "${cityName}" found in ${configPath}\n`)
    return 0
  }
  if (after.length === 0) {
    delete configObj.gascity
  } else {
    configObj.gascity = after
  }
  try {
    await writeConfigObject(configPath, configObj)
  } catch (err) {
    stderr.write(`error: failed to write ${configPath}: ${formatError(err)}\n`)
    return 1
  }
  stdout.write(`✓ detached: ${cityName}\n`)
  const reload = await reloadRunningDaemon(hooks, stdout, stderr)
  if (reload === 'no-daemon') {
    stdout.write('  No running daemon — config saved.\n')
    return 0
  }
  if (reload === 'failed') return 1
  return 0
}

// =============================================================================
// list
// =============================================================================

const LIST_USAGE = `Usage:
  ctvs gascity list [--json]

Renders the daemon's runtime state snapshot for attached cities and their
active sessions. With --json, the snapshot is emitted as JSON for scripts.

Options:
  --json         Emit JSON instead of a table
  --help, -h     Show this help
`

/**
 * @typedef {object} ListParseResult
 * @property {boolean} json
 * @property {boolean} help
 * @property {string} [error]
 */

/**
 * @param {string[]} argv
 * @returns {ListParseResult}
 */
export function parseListArgs(argv) {
  /** @type {ListParseResult} */
  const r = { json: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    if (arg === '--json') { r.json = true; continue }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * @param {string[]} argv
 * @param {GascityHooks} hooks
 * @returns {Promise<number>}
 */
export async function runList(argv, hooks) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseListArgs(argv)
  if (parsed.help) {
    stdout.write(LIST_USAGE)
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${LIST_USAGE}`)
    return 2
  }
  const statePath = hooks.statePath ?? defaultGascityStatePath()
  const readState = hooks.readState ?? readRuntimeState
  /** @type {GascityRuntimeState | undefined} */
  let state
  try {
    state = await readState(statePath)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  if (parsed.json) {
    const payload = state ?? { schema_version: 0, updated_at: null, cities: [] }
    stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return 0
  }
  if (!state || state.cities.length === 0) {
    stdout.write('No gascity cities attached or no daemon running.\n')
    return 0
  }
  const now = (hooks.now ?? (() => new Date()))()
  printSessionTable(stdout, state, now)
  return 0
}

/**
 * Render the per-session table from the runtime state. Columns and widths
 * mirror the bead's example output so operators have something predictable
 * to grep / pipe.
 *
 * @param {{ write: (s: string) => void }} stdout
 * @param {GascityRuntimeState} state
 * @param {Date} now
 */
function printSessionTable(stdout, state, now) {
  /** @type {Array<{ city: string, session: string, template: string, state: string, frames: string, last: string }>} */
  const rows = []
  for (const city of state.cities) {
    if (city.sessions.length === 0) {
      rows.push({
        city: city.name,
        session: '-',
        template: '-',
        state: city.lifecycle_connected ? 'idle' : 'disconnected',
        frames: '0',
        last: '-',
      })
      continue
    }
    for (const sess of city.sessions) {
      rows.push({
        city: city.name,
        session: sess.sessionId,
        template: sess.template ?? '-',
        state: sess.state,
        frames: String(sess.frames),
        last: sess.last_frame_at ? humanAge(now, sess.last_frame_at) : '-',
      })
    }
  }
  const widths = {
    city: Math.max('CITY'.length, ...rows.map((r) => r.city.length)),
    session: Math.max('SESSION'.length, ...rows.map((r) => r.session.length)),
    template: Math.max('TEMPLATE'.length, ...rows.map((r) => r.template.length)),
    state: Math.max('STATE'.length, ...rows.map((r) => r.state.length)),
    frames: Math.max('FRAMES'.length, ...rows.map((r) => r.frames.length)),
    last: Math.max('LAST_FRAME'.length, ...rows.map((r) => r.last.length)),
  }
  const header = [
    'CITY'.padEnd(widths.city),
    'SESSION'.padEnd(widths.session),
    'TEMPLATE'.padEnd(widths.template),
    'STATE'.padEnd(widths.state),
    'FRAMES'.padEnd(widths.frames),
    'LAST_FRAME'.padEnd(widths.last),
  ].join('  ')
  stdout.write(header + '\n')
  for (const r of rows) {
    stdout.write([
      r.city.padEnd(widths.city),
      r.session.padEnd(widths.session),
      r.template.padEnd(widths.template),
      r.state.padEnd(widths.state),
      r.frames.padEnd(widths.frames),
      r.last.padEnd(widths.last),
    ].join('  ') + '\n')
  }
}

/**
 * Render an ISO timestamp as a coarse "Ns ago" / "Nm ago" string for the
 * table output. We don't need millisecond precision here — operators just
 * want to know whether a session is still actively producing frames.
 *
 * @param {Date} now
 * @param {string} iso
 * @returns {string}
 */
function humanAge(now, iso) {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso
  const ms = now.getTime() - then
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h ago`
  const days = Math.round(hr / 24)
  return `${days}d ago`
}

// =============================================================================
// backfill
// =============================================================================

const BACKFILL_USAGE = `Usage:
  ctvs gascity backfill <city> [--since <duration>] [--all]

Walks the city's transcript history per session via /v0/city/{city}/session/{id}/transcript?format=raw.
By default, backfill uses local session cursors and skips retired sessions.
With --all, it asks the supervisor for all recoverable sessions and replays each
transcript from the beginning. The dispatch path is the same one the live SSE
tail uses, so re-running is idempotent — the writer's dedup set collapses any
overlap.

Options:
  --since <duration>   Skip sessions whose cursor's last_timestamp is older than this (e.g. 7d, 12h)
  --all                Discover and backfill all recoverable supervisor sessions
  --config <path>      collectivus config (default: ~/.hyp/collectivus.json)
  --help, -h           Show this help
`
const BACKFILL_DISCOVERY_TIMEOUT_MS = 5000

/**
 * @typedef {object} BackfillParseResult
 * @property {string} [city]
 * @property {string} [since]
 * @property {boolean} all
 * @property {string} [configPath]
 * @property {boolean} help
 * @property {string} [error]
 */

/**
 * @param {string[]} argv
 * @returns {BackfillParseResult}
 */
export function parseBackfillArgs(argv) {
  /** @type {BackfillParseResult} */
  const r = { all: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    if (arg === '--all') { r.all = true; continue }
    if (arg === '--since' || arg.startsWith('--since=')) {
      const value = arg === '--since' ? argv[++i] : arg.slice('--since='.length)
      if (!value) { r.error = '--since requires a duration'; return r }
      r.since = value
      continue
    }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (arg.startsWith('-')) { r.error = `unknown argument: ${arg}`; return r }
    if (r.city !== undefined) { r.error = `unexpected positional argument: ${arg}`; return r }
    r.city = arg
  }
  if (!r.help && r.city === undefined) r.error = 'backfill requires a city name'
  return r
}

/**
 * @param {string[]} argv
 * @param {GascityHooks} hooks
 * @returns {Promise<number>}
 */
export async function runBackfill(argv, hooks) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseBackfillArgs(argv)
  if (parsed.help) {
    stdout.write(BACKFILL_USAGE)
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${BACKFILL_USAGE}`)
    return 2
  }
  const configPath = parsed.configPath ?? hooks.configPath ?? defaultConfigPath()
  const cityName = /** @type {string} */ parsed.city
  /** @type {CollectivusConfig} */
  let config
  try {
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`error: ${err.message}\n`)
      return 1
    }
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  const cities = config.gascity ?? []
  const city = cities.find((c) => c.name === cityName)
  if (!city) {
    stderr.write(`error: no [[gascity]] entry named "${cityName}" in ${configPath}\n`)
    return 1
  }
  /** @type {number | undefined} */
  let sinceMs
  if (parsed.since !== undefined) {
    const ms = parseDuration(parsed.since)
    if (ms === undefined) {
      stderr.write(`error: invalid --since value "${parsed.since}" (try "7d", "12h", "30m")\n`)
      return 2
    }
    sinceMs = ms
  }
  // Build a writer + dispatcher just like startGascitySource does, but
  // without the SSE machinery — we only need the backfill dispatch path.
  const sinkRoot = hooks.sinkRoot ?? defaultGascityRoot()
  const writer = new ParquetWriter({ sinkRoot, stderr })
  const dispatcher = new NormalizerDispatcher({ stderr, writer })
  registerProductionNormalizers(dispatcher)
  const fetchFn = hooks.fetchFn ?? globalThis.fetch
  /** @type {{ sessionsAttempted: number, framesDispatched: number, sessionsFailed: number, sessionsSkipped: number }} */
  const result = { sessionsAttempted: 0, framesDispatched: 0, sessionsFailed: 0, sessionsSkipped: 0 }
  try {
    const cursorsRoot = cursorsDir(sinkRoot, city.name)
    /** @type {string[]} */
    let entries
    try {
      entries = await fs.readdir(cursorsRoot)
    } catch (err) {
      if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        entries = []
      } else {
        throw err
      }
    }
    const cursors = new Map()
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'lifecycle.json') continue
      const sessionId = entry.slice(0, -'.json'.length)
      if (sessionId.length === 0) continue
      const cursorPath = `${cursorsRoot}/${entry}`
      const cursor = await readCursor(cursorPath)
      if (cursor) cursors.set(sessionId, cursor)
    }

    const cutoff = sinceMs !== undefined ? Date.now() - sinceMs : undefined
    const targets = parsed.all
      ? await discoverAllBackfillTargets({ city, fetchFn, stdout, cursors })
      : cursorBackfillTargets(cursors)

    for (const target of targets) {
      const { cursor } = target
      if (!parsed.all && cursor?.retired === true) {
        result.sessionsSkipped += 1
        continue
      }
      const timestamp = target.lastTimestamp ?? (typeof cursor?.last_timestamp === 'string' ? cursor.last_timestamp : undefined)
      if (cutoff !== undefined && timestamp !== undefined) {
        const ts = Date.parse(timestamp)
        if (Number.isFinite(ts) && ts < cutoff) {
          result.sessionsSkipped += 1
          continue
        }
      }

      result.sessionsAttempted += 1
      try {
        const backfillCityConfig = cityForBackfillSession(city, target)
        const dispatched = await backfillSession({
          city: backfillCityConfig,
          sessionId: target.sessionId,
          afterUuid: parsed.all ? undefined : typeof cursor?.last_uuid === 'string' ? cursor.last_uuid : undefined,
          dispatcher,
          fetchFn,
          stderr,
          debug: false,
        })
        result.framesDispatched += dispatched
        stdout.write(`  ${target.sessionId}: ${dispatched} frames\n`)
      } catch (err) {
        result.sessionsFailed += 1
        stderr.write(
          `[gascity] backfill_session_failed city=${city.name} session=${target.sessionId} err=${formatError(err)}\n`
        )
      }
    }
  } catch (err) {
    stderr.write(`error: backfill failed: ${formatError(err)}\n`)
    await dispatcher.drain().catch(swallow)
    await writer.stop().catch(swallow)
    return 1
  }
  await dispatcher.drain()
  await writer.stop()
  stdout.write(
    `Backfill complete: ${result.sessionsAttempted} attempted, ` +
    `${result.framesDispatched} frames, ${result.sessionsFailed} failed, ${result.sessionsSkipped} skipped\n`
  )
  return result.sessionsFailed > 0 ? 1 : 0
}

/**
 * @typedef {{
 *   sessionId: string,
 *   cursor?: import('../gascity/types.d.ts').SessionCursor,
 *   template?: string,
 *   rig?: string,
 *   alias?: string,
 *   lastTimestamp?: string,
 * }} BackfillTarget
 */

/**
 * @param {Map<string, import('../gascity/types.d.ts').SessionCursor>} cursors
 * @returns {BackfillTarget[]}
 */
function cursorBackfillTargets(cursors) {
  return Array.from(cursors.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sessionId, cursor]) => ({ sessionId, cursor }))
}

/**
 * @param {{
 *   city: import('../gascity/types.d.ts').GascityCityConfig,
 *   fetchFn: typeof fetch,
 *   stdout: { write: (s: string) => void },
 *   cursors: Map<string, import('../gascity/types.d.ts').SessionCursor>,
 * }} args
 * @returns {Promise<BackfillTarget[]>}
 */
async function discoverAllBackfillTargets(args) {
  args.stdout.write(`Discovering recoverable sessions for ${args.city.name}; this can take a while for large cities.\n`)
  const sessions = await fetchSupervisorSessions({
    city: args.city,
    fetchFn: args.fetchFn,
    state: 'all',
  })
  args.stdout.write(`Discovered ${sessions.length} session${sessions.length === 1 ? '' : 's'} from supervisor.\n`)
  /** @type {Map<string, BackfillTarget>} */
  const targets = new Map()
  for (const session of sessions) {
    /** @type {BackfillTarget} */
    const target = { sessionId: session.sessionId }
    const cursor = args.cursors.get(session.sessionId)
    if (cursor !== undefined) target.cursor = cursor
    if (session.template !== undefined) target.template = session.template
    if (session.rig !== undefined) target.rig = session.rig
    if (session.alias !== undefined) target.alias = session.alias
    if (session.lastTimestamp !== undefined) target.lastTimestamp = session.lastTimestamp
    targets.set(session.sessionId, target)
  }
  for (const [sessionId, cursor] of args.cursors) {
    if (targets.has(sessionId)) continue
    targets.set(sessionId, { sessionId, cursor })
  }
  return Array.from(targets.values()).sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/**
 * @param {{
 *   city: import('../gascity/types.d.ts').GascityCityConfig,
 *   fetchFn: typeof fetch,
 *   state: 'active' | 'all',
 * }} args
 * @returns {Promise<import('../gascity/types.d.ts').SupervisorSessionInfo[]>}
 */
async function fetchSupervisorSessions(args) {
  const url = buildSessionsUrl(args.city.api_url, args.city.name, args.state)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), BACKFILL_DISCOVERY_TIMEOUT_MS)
  /** @type {Response} */
  let response
  try {
    response = await args.fetchFn(url, { signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(swallow)
    throw new Error(`sessions HTTP ${response.status}`)
  }
  /** @type {unknown} */
  const body = await response.json()
  return parseSupervisorSessions(body, { includeInactive: args.state === 'all' })
}

/**
 * @param {string} apiUrl
 * @param {string} city
 * @param {'active' | 'all'} state
 * @returns {string}
 */
function buildSessionsUrl(apiUrl, city, state) {
  const base = `${apiUrl.replace(/\/+$/, '')}/v0/city/${encodeURIComponent(city)}/sessions`
  return `${base}?${new URLSearchParams({ state }).toString()}`
}

/**
 * @param {unknown} body
 * @param {{ includeInactive: boolean }} opts
 * @returns {import('../gascity/types.d.ts').SupervisorSessionInfo[]}
 */
function parseSupervisorSessions(body, opts) {
  if (body === null || typeof body !== 'object') return []
  const { items } = /** @type {Record<string, unknown>} */ (body)
  if (!Array.isArray(items)) return []
  /** @type {import('../gascity/types.d.ts').SupervisorSessionInfo[]} */
  const sessions = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const state = pickString(item, 'state')
    if (!opts.includeInactive && state !== undefined && state !== 'active') continue
    const alias = pickString(item, 'alias')
    const id = pickString(item, 'id')
    const sessionId = alias ?? id
    if (sessionId === undefined || sessionId.length === 0) continue
    const template = pickString(item, 'template') ?? sessionId
    const rig = pickString(item, 'rig')
    const lastTimestamp =
      pickString(item, 'last_timestamp') ??
      pickString(item, 'last_frame_at') ??
      pickString(item, 'updated_at') ??
      pickString(item, 'stopped_at') ??
      pickString(item, 'created_at')
    /** @type {import('../gascity/types.d.ts').SupervisorSessionInfo} */
    const session = { sessionId }
    if (template !== undefined) session.template = template
    if (rig !== undefined) session.rig = rig
    if (alias !== undefined) session.alias = alias
    if (state !== undefined) session.state = state
    if (lastTimestamp !== undefined) session.lastTimestamp = lastTimestamp
    sessions.push(session)
  }
  return sessions
}

/**
 * @param {import('../gascity/types.d.ts').GascityCityConfig} city
 * @param {BackfillTarget} target
 * @returns {{ name: string, api_url: string, template?: string, rig?: string, alias?: string }}
 */
function cityForBackfillSession(city, target) {
  /** @type {{ name: string, api_url: string, template?: string, rig?: string, alias?: string }} */
  const out = { name: city.name, api_url: city.api_url }
  if (target.template !== undefined) out.template = target.template
  if (target.rig !== undefined) out.rig = target.rig
  if (target.alias !== undefined) out.alias = target.alias
  return out
}

/**
 * @param {unknown} obj
 * @param {string} key
 * @returns {string | undefined}
 */
function pickString(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined
  const value = /** @type {Record<string, unknown>} */ (obj)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse a duration like `7d`, `12h`, `30m`, `45s`. Returns the equivalent
 * milliseconds, or undefined for malformed input.
 *
 * @param {string} value
 * @returns {number | undefined}
 */
export function parseDuration(value) {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim())
  if (!match) return undefined
  const n = Number.parseInt(match[1], 10)
  if (!Number.isFinite(n) || n <= 0) return undefined
  switch (match[2]) {
  case 's': return n * 1000
  case 'm': return n * 60_000
  case 'h': return n * 3_600_000
  case 'd': return n * 86_400_000
  }
  return undefined
}

// =============================================================================
// status
// =============================================================================

const STATUS_USAGE = `Usage:
  ctvs gascity status [--json]

Reports the gascity source's reachability and capture state for each attached
city (distinct from \`ctvs status\`, which covers daemon-wide health).

Options:
  --json         Emit the report as JSON
  --help, -h     Show this help
`

/**
 * @typedef {object} StatusParseResult
 * @property {boolean} json
 * @property {boolean} help
 * @property {string} [error]
 */

/**
 * @param {string[]} argv
 * @returns {StatusParseResult}
 */
export function parseStatusArgs(argv) {
  /** @type {StatusParseResult} */
  const r = { json: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    if (arg === '--json') { r.json = true; continue }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * @param {string[]} argv
 * @param {GascityHooks} hooks
 * @returns {Promise<number>}
 */
export async function runStatus(argv, hooks) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseStatusArgs(argv)
  if (parsed.help) {
    stdout.write(STATUS_USAGE)
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${STATUS_USAGE}`)
    return 2
  }
  const statePath = hooks.statePath ?? defaultGascityStatePath()
  const readState = hooks.readState ?? readRuntimeState
  const fetchFn = hooks.fetchFn ?? globalThis.fetch
  const now = (hooks.now ?? (() => new Date()))()

  /** @type {GascityRuntimeState | undefined} */
  let state
  try {
    state = await readState(statePath)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  /** @type {Array<{ name: string, api_url: string, reachable: boolean, lifecycle_connected: boolean, lifecycle_last_event_at?: string, active_sessions: number, frames_total: number }>} */
  const cities = []
  if (state) {
    await Promise.all(state.cities.map(async (c) => {
      const reachable = await probeReachable(fetchFn, c.api_url, c.name)
      /** @type {(typeof cities)[number]} */
      const entry = {
        name: c.name,
        api_url: c.api_url,
        reachable,
        lifecycle_connected: c.lifecycle_connected,
        active_sessions: c.sessions.filter((s) => s.state === 'active').length,
        frames_total: c.frames_total,
      }
      if (c.lifecycle_last_event_at !== undefined) entry.lifecycle_last_event_at = c.lifecycle_last_event_at
      cities.push(entry)
    }))
    cities.sort((a, b) => a.name.localeCompare(b.name))
  }
  const payload = {
    schema_version: state?.schema_version ?? 0,
    updated_at: state?.updated_at ?? null,
    daemon_running: state !== undefined,
    cities,
  }
  if (parsed.json) {
    stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return 0
  }
  stdout.write('Gascity source:\n')
  stdout.write(`  Daemon: ${payload.daemon_running ? 'running' : 'not running'}\n`)
  stdout.write(`  Cities attached: ${cities.length}\n`)
  for (const c of cities) {
    const lifecycle = c.lifecycle_connected ? 'connected' : 'disconnected'
    const reachable = c.reachable ? 'reachable' : 'unreachable'
    stdout.write(`  - ${c.name} (${c.api_url}): ${reachable}, lifecycle SSE ${lifecycle}\n`)
    stdout.write(`      Active sessions: ${c.active_sessions}\n`)
    stdout.write(`      Frames captured: ${c.frames_total}\n`)
    if (c.lifecycle_last_event_at) {
      stdout.write(`      Last lifecycle event: ${humanAge(now, c.lifecycle_last_event_at)}\n`)
    }
  }
  return 0
}

/**
 * GET the per-city status endpoint first, then fall back to generic health
 * probes. Returns true on a 2xx response. We don't care which endpoint the
 * supervisor exposes — anything that 200s tells us "the port is live and
 * answering". Any error or non-2xx means we render "unreachable" and let
 * the operator decide.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} apiUrl
 * @param {string} cityName
 * @returns {Promise<boolean>}
 */
async function probeReachable(fetchFn, apiUrl, cityName) {
  const baseUrl = apiUrl.replace(/\/+$/, '')
  const candidates = [
    `${baseUrl}/v0/city/${encodeURIComponent(cityName)}/status`,
    `${baseUrl}/v0/health`,
    `${baseUrl}/health`,
    `${baseUrl}/`,
  ]
  for (const url of candidates) {
    /** @type {AbortController} */
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetchFn(url, { signal: controller.signal })
      if (response.ok) return true
    } catch {
      // Try the next candidate.
    } finally {
      clearTimeout(timer)
    }
  }
  return false
}

// =============================================================================
// shared helpers
// =============================================================================

/**
 * Swallow a rejection so a `.catch(swallow)` doesn't add an implicit-any
 * arrow that trips `noImplicitAny`.
 *
 * @returns {void}
 */
function swallow() { /* swallow */ }

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
