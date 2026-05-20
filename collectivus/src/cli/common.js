import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @import { InstalledPlistFields } from './types.d.ts'
 */

export const LAUNCH_AGENT_LABEL = 'com.hyparam.collectivus'
export const DEFAULT_PLIST_DIR_SEGMENTS = ['Library', 'LaunchAgents']

/**
 * Human-readable description of the daemon artifact for the running platform.
 * Used in install/uninstall success messages so Linux output doesn't claim a
 * "LaunchAgent" was touched when in fact a systemd user unit was.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function daemonKindLabel(platform = process.platform) {
  if (platform === 'linux') return `systemd unit: ${LAUNCH_AGENT_LABEL}.service`
  return `LaunchAgent: ${LAUNCH_AGENT_LABEL}`
}

const here = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_PATH = path.join(here, '..', '..', 'package.json')

/**
 * Read the `version` field from package.json.
 *
 * Used to stamp the `_collectivus.version` marker so detach can compare against
 * the install that wrote it.
 *
 * @returns {string}
 */
export function readPackageVersion() {
  const raw = fs.readFileSync(PACKAGE_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json is missing a string `version` field')
  }
  return parsed.version
}

/**
 * Default directory for daemon log files: `~/.hyp/collectivus`.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string}
 */
export function defaultLogDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus')
}

/**
 * Default config save path: `~/.hyp/collectivus.json`. Lives alongside the
 * daemon log directory at `~/.hyp/collectivus/` and is the path the
 * interactive walkthrough writes to and the `status` command falls back to
 * when no LaunchAgent is installed.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string}
 */
export function defaultConfigPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus.json')
}

/**
 * Return `defaultConfigPath(homeDir)` when that file exists, otherwise
 * undefined. Used by every CLI that accepts `--config` so callers can omit
 * the flag when the standard `~/.hyp/collectivus.json` file is present.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string | undefined}
 */
export function resolveDefaultConfigPath(homeDir) {
  const p = defaultConfigPath(homeDir)
  try {
    if (fs.statSync(p).isFile()) return p
  } catch {
    // ignore missing file
  }
  return undefined
}

/**
 * Path to the admin client config: `~/.hyp/collectivus/admin.json`.
 *
 * Stored beside the daemon log directory so a self-hosting operator can keep
 * admin state alongside the running collectivus install. Used by
 * `ctvs admin configure/status/clear` and read by `ctvs invite create` when
 * talking to the central admin API.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string}
 */
export function adminConfigPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus', 'admin.json')
}

/**
 * Read the admin config at `configPath`. Returns undefined when the file does
 * not exist; throws on parse errors or other I/O failures so the caller can
 * surface a clear message instead of pretending the operator has no config.
 *
 * @param {string} configPath
 * @returns {{ central_url: string, admin_token: string } | undefined}
 */
export function readAdminConfig(configPath) {
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`admin config ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`admin config ${configPath} must be a JSON object`)
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed)
  if (typeof obj.central_url !== 'string' || obj.central_url.length === 0) {
    throw new Error(`admin config ${configPath} is missing a string \`central_url\``)
  }
  if (typeof obj.admin_token !== 'string' || obj.admin_token.length === 0) {
    throw new Error(`admin config ${configPath} is missing a string \`admin_token\``)
  }
  return { central_url: obj.central_url, admin_token: obj.admin_token }
}

/**
 * Atomically write the admin config to `configPath`. Creates the parent
 * directory and uses tmp+rename with mode 0600 (same pattern as
 * `flushRecords` in `src/server/enrollment.js`).
 *
 * @param {string} configPath
 * @param {{ central_url: string, admin_token: string }} config
 * @returns {void}
 */
export function writeAdminConfig(configPath, config) {
  const dir = path.dirname(configPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, configPath)
}

/**
 * Remove the admin config file. Returns true when a file was unlinked, false
 * when it was already absent. Errors other than ENOENT propagate so the
 * caller can surface them.
 *
 * @param {string} configPath
 * @returns {boolean}
 */
export function clearAdminConfig(configPath) {
  try {
    fs.unlinkSync(configPath)
    return true
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return false
    throw err
  }
}

/**
 * Default LaunchAgent plist path: `~/Library/LaunchAgents/com.hyparam.collectivus.plist`.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string}
 */
export function defaultPlistPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), ...DEFAULT_PLIST_DIR_SEGMENTS, `${LAUNCH_AGENT_LABEL}.plist`)
}

/**
 * Read an installed LaunchAgent plist and extract the fields that the
 * `status` command surfaces. Returns undefined when the plist file is missing.
 *
 * The plist is the one written by `buildPlist` in `src/daemon/macos.js`, so
 * the structure is predictable. Regex-based extraction is sufficient and
 * keeps us free of an XML parser dependency.
 *
 * @param {string} plistPath
 * @returns {InstalledPlistFields | undefined}
 */
export function readInstalledPlist(plistPath) {
  /** @type {string} */
  let xml
  try {
    xml = fs.readFileSync(plistPath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
  return parsePlistFields(xml)
}

/**
 * @param {string} xml
 * @returns {InstalledPlistFields}
 */
function parsePlistFields(xml) {
  /** @type {InstalledPlistFields} */
  const fields = {}
  const arrayMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)
  if (arrayMatch) {
    const items = [...arrayMatch[1].matchAll(/<string>([^<]*)<\/string>/g)].map(function(m) {
      return unescapeXml(m[1])
    })
    const idx = items.indexOf('--config')
    if (idx !== -1 && idx + 1 < items.length) fields.configPath = items[idx + 1]
  }
  const stdoutPath = extractStringForKey(xml, 'StandardOutPath')
  if (stdoutPath !== undefined) fields.stdoutPath = stdoutPath
  const stderrPath = extractStringForKey(xml, 'StandardErrorPath')
  if (stderrPath !== undefined) fields.stderrPath = stderrPath
  return fields
}

/**
 * @param {string} xml
 * @param {string} key
 * @returns {string | undefined}
 */
function extractStringForKey(xml, key) {
  const re = new RegExp(`<key>${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}<\\/key>\\s*<string>([^<]*)<\\/string>`)
  const m = re.exec(xml)
  return m ? unescapeXml(m[1]) : undefined
}

/**
 * @param {string} value
 * @returns {string}
 */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Extract the numeric port from a `host:port` listen address. Bracketed IPv6
 * forms (`[::1]:8787`) are unwrapped so we only have to look at the suffix.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseListenPort(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid listen value: ${String(value)}`)
  }
  /** @type {string} */
  let portStr
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1 || value[close + 1] !== ':') {
      throw new Error(`invalid listen value: ${value}`)
    }
    portStr = value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon <= 0) throw new Error(`invalid listen value: ${value}`)
    portStr = value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port in listen value: ${value}`)
  }
  return port
}

/**
 * Heuristic to detect whether a script path was resolved through `npx`.
 *
 * npx unpacks the package into `~/.npm/_npx/<hash>/...` so the binary path is
 * not stable across invocations and would silently break a LaunchAgent on the
 * next `npx` run. Match `_npx` as a path component to avoid false positives on
 * directory names that merely contain the substring.
 *
 * @param {unknown} p
 * @returns {boolean}
 */
export function isNpxBinPath(p) {
  if (typeof p !== 'string') return false
  return /[/\\]_npx[/\\]/.test(p)
}

/**
 * Install the current published package into npm's global prefix.
 *
 * @returns {Promise<boolean>}
 */
export async function installGlobalCollectivus() {
  const exitCode = await runInherited(defaultNpmPath(), ['install', '-g', 'collectivus'])
  return exitCode === 0
}

/**
 * Resolve the stable CLI entrypoint after `npm install -g collectivus`.
 *
 * @returns {Promise<string>}
 */
export async function resolveGlobalCollectivusBinPath() {
  const result = await runCaptured(defaultNpmPath(), ['root', '-g'])
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `npm root -g exited ${result.exitCode}`)
  }
  const root = result.stdout.trim()
  if (!root) throw new Error('npm root -g returned an empty path')
  const binPath = path.join(root, 'collectivus', 'bin', 'cli.js')
  if (!fs.existsSync(binPath)) {
    throw new Error(`${binPath} does not exist after npm install -g collectivus`)
  }
  return binPath
}

/**
 * @returns {string}
 */
function defaultNpmPath() {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return path.join(path.dirname(process.execPath), name)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function runInherited(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code === null ? -1 : code))
  })
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runCaptured(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ exitCode: code === null ? -1 : code, stdout, stderr }))
  })
}

/**
 * Read a single line from stdin, prompted with `question`. Lazily imports
 * readline so non-prompt code paths don't pay for it.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function defaultPrompt(question) {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(function(resolve) {
    rl.question(question, function(answer) {
      rl.close()
      resolve(answer.trim())
    })
  })
}
