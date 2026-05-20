import process from 'node:process'
import {
  adminConfigPath as defaultAdminConfigPath,
  clearAdminConfig as defaultClearAdminConfig,
  readAdminConfig as defaultReadAdminConfig,
  writeAdminConfig as defaultWriteAdminConfig,
} from './common.js'

/**
 * @import { AdminHooks, AdminParseResult } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs admin configure --central <url> --admin-token <token>
  ctvs admin status
  ctvs admin clear

Persists the central URL and admin bearer token used by \`ctvs invite create\`
to talk to a self-hosted collectivus admin API.

Options:
  --central <url>        Base URL of the collectivus admin API (http or https)
  --admin-token <token>  Bearer token authorized for /v1/admin/*
  --help, -h             Show this help`

const CONFIGURE_USAGE = `Usage:
  ctvs admin configure --central <url> --admin-token <token>

Options:
  --central <url>        Base URL of the collectivus admin API (http or https)
  --admin-token <token>  Bearer token authorized for /v1/admin/*
  --help, -h             Show this help`

const STATUS_USAGE = `Usage:
  ctvs admin status

Prints the saved central URL and a redacted preview of the admin token.
Exits nonzero if no admin config has been written.

Options:
  --help, -h             Show this help`

const CLEAR_USAGE = `Usage:
  ctvs admin clear

Removes the saved admin config. Idempotent — succeeds even if no config exists.

Options:
  --help, -h             Show this help`

/**
 * Parse `ctvs admin <verb> [options]`.
 *
 * @param {string[]} argv
 * @returns {AdminParseResult}
 */
export function parseAdminArgs(argv) {
  if (argv.length === 0) {
    return { kind: 'error', message: 'subcommand is required', exitCode: 2 }
  }
  const [first, ...rest] = argv
  if (first === '--help' || first === '-h') return { kind: 'help' }
  switch (first) {
  case 'configure': return parseConfigure(rest)
  case 'status': return parseStatus(rest)
  case 'clear': return parseClear(rest)
  default:
    return { kind: 'error', message: `unknown admin subcommand: ${first}`, exitCode: 2 }
  }
}

/**
 * @param {string[]} argv
 * @returns {AdminParseResult}
 */
function parseConfigure(argv) {
  /** @type {string | undefined} */ let central
  /** @type {string | undefined} */ let adminToken
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'configure-help' }
    if (arg === '--central' || arg.startsWith('--central=')) {
      const value = arg === '--central' ? argv[++i] : arg.slice('--central='.length)
      if (!value) return { kind: 'error', message: '--central requires a URL', exitCode: 2 }
      central = value
      continue
    }
    if (arg === '--admin-token' || arg.startsWith('--admin-token=')) {
      const value = arg === '--admin-token' ? argv[++i] : arg.slice('--admin-token='.length)
      if (!value) return { kind: 'error', message: '--admin-token requires a token', exitCode: 2 }
      adminToken = value
      continue
    }
    return { kind: 'error', message: `unknown argument: ${arg}`, exitCode: 2 }
  }
  if (central === undefined) {
    return { kind: 'error', message: '--central is required', exitCode: 2 }
  }
  if (adminToken === undefined) {
    return { kind: 'error', message: '--admin-token is required', exitCode: 2 }
  }
  if (!isHttpUrl(central)) {
    return { kind: 'error', message: '--central must be an http or https URL', exitCode: 2 }
  }
  if (adminToken.length === 0) {
    return { kind: 'error', message: '--admin-token must not be empty', exitCode: 2 }
  }
  return { kind: 'configure', central, adminToken }
}

/**
 * @param {string[]} argv
 * @returns {AdminParseResult}
 */
function parseStatus(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'status-help' }
    return { kind: 'error', message: `unknown argument: ${arg}`, exitCode: 2 }
  }
  return { kind: 'status' }
}

/**
 * @param {string[]} argv
 * @returns {AdminParseResult}
 */
function parseClear(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'clear-help' }
    return { kind: 'error', message: `unknown argument: ${arg}`, exitCode: 2 }
  }
  return { kind: 'clear' }
}

/**
 * Run `ctvs admin <verb>`.
 *
 * @param {string[]} argv
 * @param {AdminHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runAdmin(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const configPath = hooks.configPath ?? defaultAdminConfigPath(hooks.homeDir)
  const readAdminConfig = hooks.readAdminConfig ?? defaultReadAdminConfig
  const writeAdminConfig = hooks.writeAdminConfig ?? defaultWriteAdminConfig
  const clearAdminConfig = hooks.clearAdminConfig ?? defaultClearAdminConfig

  const parsed = parseAdminArgs(argv)
  switch (parsed.kind) {
  case 'help':
    stdout.write(USAGE + '\n')
    return 0
  case 'configure-help':
    stdout.write(CONFIGURE_USAGE + '\n')
    return 0
  case 'status-help':
    stdout.write(STATUS_USAGE + '\n')
    return 0
  case 'clear-help':
    stdout.write(CLEAR_USAGE + '\n')
    return 0
  case 'error':
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
  case 'configure':
    try {
      writeAdminConfig(configPath, { central_url: parsed.central, admin_token: parsed.adminToken })
    } catch (err) {
      stderr.write(`error: failed to write admin config: ${formatError(err)}\n`)
      return 1
    }
    stdout.write(`Saved admin config to ${configPath}\n`)
    return 0
  case 'status': {
    /** @type {{ central_url: string, admin_token: string } | undefined} */
    let config
    try {
      config = readAdminConfig(configPath)
    } catch (err) {
      stderr.write(`error: ${formatError(err)}\n`)
      return 1
    }
    if (!config) {
      stderr.write(`error: no admin config at ${configPath} (run \`ctvs admin configure\`)\n`)
      return 1
    }
    stdout.write(`central_url: ${config.central_url}\n`)
    stdout.write(`admin_token: ${redactToken(config.admin_token)}\n`)
    return 0
  }
  case 'clear': {
    /** @type {boolean} */
    let removed
    try {
      removed = clearAdminConfig(configPath)
    } catch (err) {
      stderr.write(`error: failed to remove admin config: ${formatError(err)}\n`)
      return 1
    }
    stdout.write(removed
      ? `Removed admin config at ${configPath}\n`
      : `No admin config at ${configPath} (nothing to remove)\n`)
    return 0
  }
  default: {
    /** @type {never} */
    const exhaustive = parsed
    throw new Error(`unhandled admin parse result: ${JSON.stringify(exhaustive)}`)
  }
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  /** @type {URL} */
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * Render a token as `…<last4>` so `ctvs admin status` does not leak the full
 * bearer to a shared terminal or screenshot. Tokens shorter than four chars
 * (already invalid at configure time, but a corrupt file could carry one)
 * fall back to the literal value to avoid an empty preview.
 *
 * @param {string} token
 * @returns {string}
 */
function redactToken(token) {
  if (token.length <= 4) return token
  return `…${token.slice(-4)}`
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}
