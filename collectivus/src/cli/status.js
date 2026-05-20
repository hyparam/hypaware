import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { isAttached as defaultIsAttached, defaultSettingsPath } from '../claude-code/settings.js'
import {
  LAUNCH_AGENT_LABEL,
  defaultConfigPath,
  defaultLogDir,
  defaultPlistPath,
  readInstalledPlist as defaultReadInstalledPlist,
  readPackageVersion,
} from './common.js'
import { isLaunchAgentInstalled as defaultIsLaunchAgentInstalled, launchAgentStatus as defaultLaunchAgentStatus } from '../daemon/macos.js'

/**
 * @import { CollectivusConfig, CollectivusMarker } from '../types.js'
 * @import { InstalledPlistFields, StatusHooks, StatusParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs status

Options:
  --help, -h        Show this help`

/**
 * @param {string[]} argv
 * @returns {StatusParseResult}
 */
export function parseStatusArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    return { help: false, error: `unknown argument: ${arg}` }
  }
  return { help: false }
}

/**
 * Run `collectivus status`.
 *
 * Reports four things in one human-readable block: daemon state (LaunchAgent
 * loaded/PID + log file existence), config state (path, parse status,
 * configured listeners), recordings (sink dir + jsonl file count), and
 * Claude Code attach state. Exit code is 0 unless an error makes the report
 * itself unreliable (e.g. settings.json is malformed, or the daemon
 * installation check throws).
 *
 * @param {string[]} argv
 * @param {StatusHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runStatus(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr

  const parsed = parseStatusArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  const launchAgentStatus = hooks.launchAgentStatus ?? defaultLaunchAgentStatus
  const isLaunchAgentInstalled = hooks.isLaunchAgentInstalled ?? defaultIsLaunchAgentInstalled
  const isAttached = hooks.isAttached ?? defaultIsAttached
  const readInstalledPlistFn = hooks.readInstalledPlist ?? defaultReadInstalledPlist
  const readSettingsRaw = hooks.readSettingsRaw ?? defaultReadSettingsRaw
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig
  const statFile = hooks.statFile ?? defaultStatFile
  const countSinkFiles = hooks.countSinkFiles ?? defaultCountSinkFiles
  const findLatestProxyFile = hooks.findLatestProxyFile ?? defaultFindLatestProxyFile
  const plistPath = hooks.plistPath ?? defaultPlistPath()
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const logDir = hooks.logDir ?? defaultLogDir()
  const fallbackConfigPath = hooks.configPath ?? defaultConfigPath()

  let exitCode = 0

  /** @type {string | undefined} */
  let version
  try {
    version = (hooks.readVersion ?? readPackageVersion)()
  } catch (err) {
    stderr.write(`warning: failed to read collectivus version: ${formatError(err)}\n`)
  }
  stdout.write(`collectivus${version ? ` v${version}` : ''}\n\n`)

  // --- Daemon section ---
  stdout.write('Daemon\n')
  /** @type {boolean} */
  let installed
  try {
    installed = await isLaunchAgentInstalled({ label: LAUNCH_AGENT_LABEL, plistDir: plistDirOf(plistPath) })
  } catch (err) {
    stderr.write(`error: failed to check daemon installation: ${formatError(err)}\n`)
    return 1
  }

  /** @type {string | undefined} */
  let configPathFromPlist
  /** @type {string} */
  let stdoutLogPath = `${logDir}/collectivus.log`
  /** @type {string} */
  let stderrLogPath = `${logDir}/collectivus.err.log`

  if (!installed) {
    stdout.write('  Status: not installed\n')
    stdout.write(`  Plist: ${plistPath} (missing)\n`)
  } else {
    /** @type {{ loaded: boolean, pid?: number }} */
    let agentStatus
    try {
      agentStatus = await launchAgentStatus({ label: LAUNCH_AGENT_LABEL })
    } catch (err) {
      stderr.write(`warning: failed to query launchctl: ${formatError(err)}\n`)
      agentStatus = { loaded: false }
    }
    stdout.write(`  Status: ${formatAgentStatus(agentStatus)}\n`)
    stdout.write(`  Plist: ${plistPath}\n`)

    /** @type {InstalledPlistFields | undefined} */
    let plistFields
    try {
      plistFields = readInstalledPlistFn(plistPath)
    } catch (err) {
      stderr.write(`warning: failed to parse plist: ${formatError(err)}\n`)
      plistFields = undefined
    }
    configPathFromPlist = plistFields?.configPath
    if (plistFields?.stdoutPath) stdoutLogPath = plistFields.stdoutPath
    if (plistFields?.stderrPath) stderrLogPath = plistFields.stderrPath
    if (configPathFromPlist) stdout.write(`  Config: ${configPathFromPlist}\n`)
    stdout.write('  Logs:\n')
    stdout.write(`    stdout: ${stdoutLogPath}${await formatLogStat(statFile, stdoutLogPath, stderr)}\n`)
    stdout.write(`    stderr: ${stderrLogPath}${await formatLogStat(statFile, stderrLogPath, stderr)}\n`)
  }

  // --- Config section ---
  stdout.write('\nConfig\n')
  const configPath = configPathFromPlist ?? fallbackConfigPath
  stdout.write(`  Path: ${configPath}\n`)
  /** @type {CollectivusConfig | undefined} */
  let config
  try {
    config = await loadConfigFn(configPath)
    stdout.write('  Status: valid\n')
  } catch (err) {
    if (err instanceof ConfigError && /not found/.test(err.message)) {
      stdout.write('  Status: missing\n')
    } else {
      stdout.write(`  Status: invalid (${formatError(err)})\n`)
      exitCode = 1
    }
  }
  if (config) printConfigDetails(stdout, config)

  // --- Recordings section ---
  if (config?.sink) {
    stdout.write('\nRecordings\n')
    const sinkDir = config.sink.dir
    stdout.write(`  Sink: ${sinkDir}\n`)

    // Proxy (Claude Code / LLM exchanges): recorded requests land in daily
    // JSONL files under <sink>/<gateway_id>/proxy/. We don't know the
    // gateway_id at status time (standalone resolves it from the OS user;
    // gateway/server take it from a JWT), so summarize whichever <id>/proxy/
    // directories exist. The most-recently-written file's size + mtime answer
    // "did anything actually get captured, and how recently?".
    /** @type {{ size: number, mtimeMs: number, name: string } | undefined} */
    let latestProxy
    try {
      latestProxy = await findLatestProxyFile(sinkDir)
    } catch (err) {
      stderr.write(`warning: failed to scan proxy recordings under ${sinkDir}: ${formatError(err)}\n`)
    }
    if (!latestProxy) {
      stdout.write('  Proxy:  no exchanges recorded yet (no <id>/proxy/*.jsonl found)\n')
    } else if (latestProxy.size === 0) {
      stdout.write(`  Proxy:  ${latestProxy.name} is empty (no exchanges recorded yet)\n`)
    } else {
      stdout.write(`  Proxy:  ${latestProxy.name} ${formatSize(latestProxy.size)}, last write ${formatTimestamp(latestProxy.mtimeMs)}\n`)
    }

    // OTLP (<sink>/<id>/<signal>/<date>.jsonl): count files under each
    // <id>/{logs,traces,metrics}/ across all gateway_ids. Excludes the
    // sibling proxy/ and raw/ subtrees; the proxy section above already
    // covers proxy/, and raw/ holds debug-only OTLP envelopes.
    /** @type {number | undefined} */
    let otlpCount
    try {
      otlpCount = await countSinkFiles(sinkDir)
    } catch (err) {
      stderr.write(`warning: failed to scan ${sinkDir}: ${formatError(err)}\n`)
    }
    if (otlpCount === undefined || otlpCount === 0) {
      stdout.write('  OTLP:   no recordings\n')
    } else {
      stdout.write(`  OTLP:   ${otlpCount} file${otlpCount === 1 ? '' : 's'} under <id>/{logs,traces,metrics}/\n`)
    }
  }

  // --- Claude Code section ---
  stdout.write('\nClaude Code\n')
  /** @type {boolean} */
  let attached
  try {
    attached = await isAttached({ settingsPath })
  } catch (err) {
    stderr.write(`error: failed to read ${settingsPath}: ${formatError(err)}\n`)
    stdout.write('  Status: unknown (settings.json could not be parsed)\n')
    stdout.write(`  Settings: ${settingsPath}\n`)
    return 1
  }

  if (!attached) {
    stdout.write('  Status: not attached\n')
    stdout.write(`  Settings: ${settingsPath}\n`)
    return exitCode
  }

  /** @type {CollectivusMarker | undefined} */
  let marker
  try {
    const raw = await readSettingsRaw(settingsPath)
    if (raw !== undefined) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed._collectivus
          && typeof parsed._collectivus === 'object' && !Array.isArray(parsed._collectivus)) {
        marker = parsed._collectivus
      }
    }
  } catch (err) {
    // isAttached already accepted the file, so a parse failure here is unexpected.
    // Keep going so we can still report the attached status.
    stderr.write(`warning: failed to parse marker: ${formatError(err)}\n`)
  }

  stdout.write('  Status: attached\n')
  if (marker?.attached_at) stdout.write(`  Attached at: ${marker.attached_at}\n`)
  if (typeof marker?.port === 'number') stdout.write(`  Port: ${marker.port}\n`)
  if (typeof marker?.version === 'string') stdout.write(`  Marker version: ${marker.version}\n`)
  stdout.write(`  Settings: ${settingsPath}\n`)
  return exitCode
}

/**
 * @param {{ write: (s: string) => void }} stdout
 * @param {CollectivusConfig} config
 */
function printConfigDetails(stdout, config) {
  if (config.proxy) {
    const upstreams = config.proxy.upstreams ?? []
    const detail = upstreams
      .map(function(u) {
        const prefix = u?.match?.path_prefix ?? ''
        return `${u?.name ?? ''} → ${u?.base_url ?? ''}${prefix}`
      })
      .join(', ')
    stdout.write(`  proxy:  ${config.proxy.listen}${detail ? `  (${detail})` : ''}\n`)
  }
  if (config.otel) {
    stdout.write(`  otel:   ${config.otel.listen}\n`)
  }
  if (config.sink) {
    stdout.write(`  sink:   ${config.sink.dir}\n`)
  }
  if (config.upload) {
    stdout.write(`  upload: s3://${config.upload.bucket}/${config.upload.prefix ?? 'collectivus'}\n`)
  }
}

/**
 * @param {(p: string) => Promise<{ size: number } | undefined>} statFn
 * @param {string} p
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<string>}
 */
async function formatLogStat(statFn, p, stderr) {
  try {
    const s = await statFn(p)
    if (!s) return ' (missing)'
    return ` (${formatSize(s.size)})`
  } catch (err) {
    stderr.write(`warning: failed to stat ${p}: ${formatError(err)}\n`)
    return ''
  }
}

/**
 * @param {number} mtimeMs
 * @returns {string}
 */
function formatTimestamp(mtimeMs) {
  const ago = Date.now() - mtimeMs
  return `${new Date(mtimeMs).toISOString()} (${formatDuration(ago)} ago)`
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h`
  const days = Math.round(hr / 24)
  return `${days}d`
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * @param {{ loaded: boolean, pid?: number }} status
 * @returns {string}
 */
function formatAgentStatus(status) {
  if (!status.loaded) return 'installed but not loaded'
  if (typeof status.pid === 'number') return `loaded (PID ${status.pid})`
  return 'loaded (no PID; daemon may have exited)'
}

/**
 * @param {string} p
 * @returns {string}
 */
function plistDirOf(p) {
  const slash = p.lastIndexOf('/')
  return slash === -1 ? p : p.slice(0, slash)
}

/**
 * @param {string} p
 * @returns {Promise<string | undefined>}
 */
async function defaultReadSettingsRaw(p) {
  try {
    return await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * @param {string} p
 * @returns {Promise<{ size: number, mtimeMs: number } | undefined>}
 */
async function defaultStatFile(p) {
  try {
    const s = await fs.stat(p)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * Find the newest `*.jsonl` under any `<sinkDir>/<id>/proxy/` directory and
 * return its display name + size + mtime. Returns undefined when no proxy
 * directories exist or none contain `.jsonl` files.
 *
 * @param {string} sinkDir
 * @returns {Promise<{ size: number, mtimeMs: number, name: string } | undefined>}
 */
async function defaultFindLatestProxyFile(sinkDir) {
  /** @type {import('node:fs').Dirent[]} */
  let topEntries
  try {
    topEntries = await fs.readdir(sinkDir, { withFileTypes: true })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
  /** @type {{ size: number, mtimeMs: number, name: string } | undefined} */
  let best
  for (const top of topEntries) {
    if (!top.isDirectory()) continue
    const proxyDir = path.join(sinkDir, top.name, 'proxy')
    /** @type {import('node:fs').Dirent[]} */
    let inner
    try {
      inner = await fs.readdir(proxyDir, { withFileTypes: true })
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') continue
      throw err
    }
    for (const entry of inner) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const full = path.join(proxyDir, entry.name)
      try {
        const s = await fs.stat(full)
        if (best === undefined || s.mtimeMs > best.mtimeMs) {
          best = { size: s.size, mtimeMs: s.mtimeMs, name: path.join(top.name, 'proxy', entry.name) }
        }
      } catch {
        // File could disappear mid-walk; skip silently.
      }
    }
  }
  return best
}

/** OTLP signal subdirectories the standalone Collector writes under each id. */
const OTLP_SIGNAL_DIRS = new Set(['logs', 'traces', 'metrics'])

/**
 * Count OTLP `.jsonl` files written under `<sinkDir>/<id>/{logs,traces,metrics}/`.
 * Skips sibling subtrees (`proxy/`, `raw/`) so the OTLP and Proxy lines stay
 * independent. Returns undefined when `sinkDir` itself is missing; missing
 * intermediate directories are treated as zero contribution.
 *
 * @param {string} sinkDir
 * @returns {Promise<number | undefined>}
 */
async function defaultCountSinkFiles(sinkDir) {
  /** @type {import('node:fs').Dirent[]} */
  let topEntries
  try {
    topEntries = await fs.readdir(sinkDir, { withFileTypes: true })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
  let count = 0
  for (const top of topEntries) {
    if (!top.isDirectory()) continue
    /** @type {import('node:fs').Dirent[]} */
    let signalEntries
    try {
      signalEntries = await fs.readdir(path.join(sinkDir, top.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const sig of signalEntries) {
      if (!sig.isDirectory() || !OTLP_SIGNAL_DIRS.has(sig.name)) continue
      /** @type {import('node:fs').Dirent[]} */
      let dateEntries
      try {
        dateEntries = await fs.readdir(path.join(sinkDir, top.name, sig.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const f of dateEntries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) count += 1
      }
    }
  }
  return count
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
