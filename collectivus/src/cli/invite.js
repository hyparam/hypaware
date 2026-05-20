import process from 'node:process'
import { isValidGatewayId } from '../gateway_id.js'
import {
  adminConfigPath as defaultAdminConfigPath,
  readAdminConfig as defaultReadAdminConfig,
} from './common.js'

/**
 * @import { InviteHooks, InviteParseResult, InviteResponseBody } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs invite create [options]

Creates a join code by calling the central admin API
(POST /v1/admin/invites). Authentication uses the admin bearer token.

Options:
  --admin-url <url>          Override the central admin URL
  --admin-token <token>      Override the admin bearer token
  --gateway-prefix <id>      Gateway id (optional — central has a default)
  --max-uses <n>             Maximum uses for the join code
  --expires-in <duration>    Lifetime as a duration (e.g. 30m, 14d).
                             Mutually exclusive with --ttl-seconds.
  --ttl-seconds <n>          Lifetime in seconds.
                             Mutually exclusive with --expires-in.
  --display-name <name>      Human-readable label for the invite
  --json                     Print the response as JSON instead of human text
  --help, -h                 Show this help

Resolution order: flags > environment variables > saved admin config.
  Environment: COLLECTIVUS_ADMIN_URL, COLLECTIVUS_ADMIN_TOKEN
  Saved config: ~/.hyp/collectivus/admin.json (\`ctvs admin configure …\`)`

/**
 * Legacy AWS-only flags that the previous Lambda-based implementation accepted.
 * Reject these with a migration hint so users who copy/paste old commands
 * get a clear message instead of an opaque "unknown argument" error.
 */
const LEGACY_FLAGS = new Set([
  '--aws-stack',
  '--function-name',
  '--region',
  '--profile',
])

/**
 * Parse `ctvs invite <verb> [options]`.
 *
 * @param {string[]} argv
 * @returns {InviteParseResult}
 */
export function parseInviteArgs(argv) {
  if (argv.length === 0) {
    return { kind: 'error', message: 'subcommand is required', exitCode: 2 }
  }
  const [first, ...rest] = argv
  if (first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'create') return parseCreate(rest)
  return { kind: 'error', message: `unknown invite subcommand: ${first}`, exitCode: 2 }
}

/**
 * @param {string[]} argv
 * @returns {InviteParseResult}
 */
function parseCreate(argv) {
  /** @type {string | undefined} */ let adminUrl
  /** @type {string | undefined} */ let adminToken
  /** @type {string | undefined} */ let gatewayPrefix
  /** @type {number | undefined} */ let maxUses
  /** @type {number | undefined} */ let expiresInSeconds
  /** @type {number | undefined} */ let ttlSeconds
  /** @type {string | undefined} */ let displayName
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'create-help' }

    const flagName = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (LEGACY_FLAGS.has(flagName)) {
      return {
        kind: 'error',
        message: `${flagName} is no longer supported. Configure Central with 'ctvs admin configure --central <url> --admin-token <token>' and re-run.`,
        exitCode: 2,
      }
    }

    if (arg === '--admin-url' || arg.startsWith('--admin-url=')) {
      const value = arg === '--admin-url' ? argv[++i] : arg.slice('--admin-url='.length)
      if (!value) return { kind: 'error', message: '--admin-url requires a URL', exitCode: 2 }
      adminUrl = value
      continue
    }
    if (arg === '--admin-token' || arg.startsWith('--admin-token=')) {
      const value = arg === '--admin-token' ? argv[++i] : arg.slice('--admin-token='.length)
      if (!value) return { kind: 'error', message: '--admin-token requires a token', exitCode: 2 }
      adminToken = value
      continue
    }
    if (arg === '--gateway-prefix' || arg.startsWith('--gateway-prefix=')) {
      const value = arg === '--gateway-prefix' ? argv[++i] : arg.slice('--gateway-prefix='.length)
      if (!value) return { kind: 'error', message: '--gateway-prefix requires a value', exitCode: 2 }
      if (!isValidGatewayId(value)) {
        return { kind: 'error', message: `--gateway-prefix is not a valid gateway id: ${value}`, exitCode: 2 }
      }
      gatewayPrefix = value
      continue
    }
    if (arg === '--max-uses' || arg.startsWith('--max-uses=')) {
      const value = arg === '--max-uses' ? argv[++i] : arg.slice('--max-uses='.length)
      if (!value) return { kind: 'error', message: '--max-uses requires a positive integer', exitCode: 2 }
      const parsed = parsePositiveInteger(value)
      if (parsed === undefined) {
        return { kind: 'error', message: `--max-uses must be a positive integer: ${value}`, exitCode: 2 }
      }
      maxUses = parsed
      continue
    }
    if (arg === '--expires-in' || arg.startsWith('--expires-in=')) {
      const value = arg === '--expires-in' ? argv[++i] : arg.slice('--expires-in='.length)
      if (!value) return { kind: 'error', message: '--expires-in requires a duration (e.g. 14d)', exitCode: 2 }
      const seconds = parseDurationSeconds(value)
      if (seconds === undefined) {
        return { kind: 'error', message: `--expires-in is not a valid duration: ${value}`, exitCode: 2 }
      }
      expiresInSeconds = seconds
      continue
    }
    if (arg === '--ttl-seconds' || arg.startsWith('--ttl-seconds=')) {
      const value = arg === '--ttl-seconds' ? argv[++i] : arg.slice('--ttl-seconds='.length)
      if (!value) return { kind: 'error', message: '--ttl-seconds requires a positive integer', exitCode: 2 }
      const parsed = parsePositiveInteger(value)
      if (parsed === undefined) {
        return { kind: 'error', message: `--ttl-seconds must be a positive integer: ${value}`, exitCode: 2 }
      }
      ttlSeconds = parsed
      continue
    }
    if (arg === '--display-name' || arg.startsWith('--display-name=')) {
      const value = arg === '--display-name' ? argv[++i] : arg.slice('--display-name='.length)
      if (!value) return { kind: 'error', message: '--display-name requires a non-empty value', exitCode: 2 }
      displayName = value
      continue
    }
    if (arg === '--json') { json = true; continue }
    return { kind: 'error', message: `unknown argument: ${arg}`, exitCode: 2 }
  }

  if (expiresInSeconds !== undefined && ttlSeconds !== undefined) {
    return { kind: 'error', message: '--expires-in and --ttl-seconds are mutually exclusive', exitCode: 2 }
  }

  return {
    kind: 'create',
    adminUrl,
    adminToken,
    gatewayPrefix,
    maxUses,
    ttlSeconds: ttlSeconds ?? expiresInSeconds,
    displayName,
    json,
  }
}

/**
 * Parse a human-readable duration (e.g. `30m`, `14d`) into integer seconds.
 * Returns undefined for malformed input so callers can produce a parse error
 * that quotes the original value.
 *
 * @param {string} input
 * @returns {number | undefined}
 */
export function parseDurationSeconds(input) {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(input)
  if (!match) return undefined
  const value = Number.parseInt(match[1], 10)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = match[2]
  /** @type {number} */
  let factor
  switch (unit) {
  case 's': factor = 1; break
  case 'm': factor = 60; break
  case 'h': factor = 60 * 60; break
  case 'd': factor = 24 * 60 * 60; break
  case 'w': factor = 7 * 24 * 60 * 60; break
  default: return undefined
  }
  return value * factor
}

/**
 * Validate and narrow an HTTP response body to the {@link InviteResponseBody}
 * shape returned by `POST /v1/admin/invites` (see `src/server/admin_invites.js`).
 *
 * Throws on shape mismatches so the CLI can refuse to print a malformed
 * response instead of rendering partial fields and confusing the operator.
 *
 * @param {unknown} body
 * @returns {InviteResponseBody}
 */
export function validateInviteResponse(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('response body is not a JSON object')
  }
  const obj = /** @type {Record<string, unknown>} */ (body)
  if (typeof obj.joinCode !== 'string' || obj.joinCode.length === 0) {
    throw new Error('response is missing string `joinCode`')
  }
  if (typeof obj.expiresAt !== 'string' || obj.expiresAt.length === 0) {
    throw new Error('response is missing string `expiresAt`')
  }
  if (Number.isNaN(Date.parse(obj.expiresAt))) {
    throw new Error('response `expiresAt` is not a valid ISO date')
  }
  if (typeof obj.maxUses !== 'number' || !Number.isInteger(obj.maxUses) || obj.maxUses < 1) {
    throw new Error('response is missing positive integer `maxUses`')
  }
  if (typeof obj.gatewayPrefix !== 'string' || !isValidGatewayId(obj.gatewayPrefix)) {
    throw new Error('response is missing valid `gatewayPrefix`')
  }
  if (typeof obj.rendezvousUrl !== 'string' || !isHttpUrl(obj.rendezvousUrl)) {
    throw new Error('response is missing valid http(s) `rendezvousUrl`')
  }
  if (typeof obj.command !== 'string' || obj.command.length === 0) {
    throw new Error('response is missing string `command`')
  }
  return {
    joinCode: obj.joinCode,
    expiresAt: obj.expiresAt,
    maxUses: obj.maxUses,
    gatewayPrefix: obj.gatewayPrefix,
    rendezvousUrl: obj.rendezvousUrl,
    command: obj.command,
  }
}

/**
 * Run `ctvs invite <verb>`. The admin bearer token is resolved from
 * (in order) flags, env (`COLLECTIVUS_ADMIN_URL`, `COLLECTIVUS_ADMIN_TOKEN`),
 * then `~/.hyp/collectivus/admin.json`. The token is never logged or echoed
 * in error output — even on transport failures the format helper only
 * surfaces the error message, not the request headers.
 *
 * @param {string[]} argv
 * @param {InviteHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runInvite(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const env = hooks.env ?? process.env
  const fetchFn = hooks.fetchFn ?? fetch
  const configPath = hooks.configPath ?? defaultAdminConfigPath(hooks.homeDir)
  const readAdminConfig = hooks.readAdminConfig ?? defaultReadAdminConfig

  const parsed = parseInviteArgs(argv)
  switch (parsed.kind) {
  case 'help':
  case 'create-help':
    stdout.write(USAGE + '\n')
    return 0
  case 'error':
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
  case 'create':
    return runCreate(parsed, { stdout, stderr, env, fetchFn, configPath, readAdminConfig })
  default: {
    /** @type {never} */
    const exhaustive = parsed
    throw new Error(`unhandled invite parse result: ${JSON.stringify(exhaustive)}`)
  }
  }
}

/**
 * @param {Extract<InviteParseResult, { kind: 'create' }>} opts
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   env: NodeJS.ProcessEnv,
 *   fetchFn: typeof fetch,
 *   configPath: string,
 *   readAdminConfig: (configPath: string) => { central_url: string, admin_token: string } | undefined,
 * }} deps
 * @returns {Promise<number>}
 */
async function runCreate(opts, deps) {
  const { stdout, stderr, env, fetchFn, configPath, readAdminConfig } = deps

  /** @type {{ central_url?: string, admin_token?: string }} */
  let fileConfig = {}
  if (opts.adminUrl === undefined || opts.adminToken === undefined) {
    try {
      const fromFile = readAdminConfig(configPath)
      if (fromFile) fileConfig = fromFile
    } catch (err) {
      stderr.write(`error: ${formatError(err)}\n`)
      return 1
    }
  }
  const adminUrl = opts.adminUrl ?? env.COLLECTIVUS_ADMIN_URL ?? fileConfig.central_url
  const adminToken = opts.adminToken ?? env.COLLECTIVUS_ADMIN_TOKEN ?? fileConfig.admin_token

  if (!adminUrl) {
    stderr.write(
      'error: no central admin URL configured. ' +
      'Pass --admin-url, set COLLECTIVUS_ADMIN_URL, or run `ctvs admin configure`.\n'
    )
    return 1
  }
  if (!adminToken) {
    stderr.write(
      'error: no admin token configured. ' +
      'Pass --admin-token, set COLLECTIVUS_ADMIN_TOKEN, or run `ctvs admin configure`.\n'
    )
    return 1
  }
  if (!isHttpUrl(adminUrl)) {
    stderr.write(`error: admin URL must be http or https: ${adminUrl}\n`)
    return 1
  }

  /** @type {Record<string, unknown>} */
  const body = {}
  if (opts.gatewayPrefix !== undefined) body.gatewayPrefix = opts.gatewayPrefix
  if (opts.maxUses !== undefined) body.maxUses = opts.maxUses
  if (opts.ttlSeconds !== undefined) body.ttlSeconds = opts.ttlSeconds
  if (opts.displayName !== undefined) body.displayName = opts.displayName

  const endpoint = `${adminUrl.replace(/\/+$/, '')}/v1/admin/invites`

  /** @type {Response} */
  let response
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${adminToken}`,
        'accept': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    stderr.write(`error: failed to reach admin API at ${endpoint}: ${formatError(err)}\n`)
    return 1
  }

  /** @type {string} */
  let rawBody = ''
  try {
    rawBody = await response.text()
  } catch {
    // Treat an unreadable body the same as an empty one. We still have
    // the status code to make a decision.
  }

  if (response.status === 200) {
    /** @type {unknown} */
    let parsedBody
    try {
      parsedBody = rawBody.length === 0 ? null : JSON.parse(rawBody)
    } catch (err) {
      stderr.write(`error: admin API returned invalid JSON: ${formatError(err)}\n`)
      return 1
    }
    /** @type {InviteResponseBody} */
    let validated
    try {
      validated = validateInviteResponse(parsedBody)
    } catch (err) {
      stderr.write(`error: admin API returned an invalid invite response: ${formatError(err)}\n`)
      return 1
    }
    renderInvite(validated, opts.json, stdout)
    return 0
  }

  if (response.status === 401) {
    stderr.write('error: unauthorized: check `ctvs admin status` and the COLLECTIVUS_ADMIN_TOKEN env var\n')
    return 1
  }

  if (response.status === 400) {
    const message = extractErrorMessage(rawBody) ?? 'bad request'
    stderr.write(`error: ${message}\n`)
    return 1
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const suffix = retryAfter ? ` in ${retryAfter} seconds` : ''
    stderr.write(`error: rate limited; retry${suffix}\n`)
    return 1
  }

  if (response.status >= 500) {
    const message = extractErrorMessage(rawBody)
    stderr.write(`error: admin API returned ${response.status}${message ? `: ${message}` : ''}\n`)
    return 1
  }

  stderr.write(`error: admin API returned unexpected status ${response.status}\n`)
  return 1
}

/**
 * @param {InviteResponseBody} invite
 * @param {boolean} asJson
 * @param {{ write: (s: string) => void }} stdout
 * @returns {void}
 */
function renderInvite(invite, asJson, stdout) {
  if (asJson) {
    stdout.write(JSON.stringify(invite, null, 2) + '\n')
    return
  }
  stdout.write(`Join code:     ${invite.joinCode}\n`)
  stdout.write(`Expires at:    ${invite.expiresAt}\n`)
  stdout.write(`Max uses:      ${invite.maxUses}\n`)
  stdout.write(`Gateway:       ${invite.gatewayPrefix}\n`)
  stdout.write(`Rendezvous:    ${invite.rendezvousUrl}\n`)
  stdout.write(`\nShare this command:\n  ${invite.command}\n`)
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
 * @param {string} value
 * @returns {number | undefined}
 */
function parsePositiveInteger(value) {
  if (!/^\d+$/.test(value)) return undefined
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}

/**
 * Pull the server-supplied `error` string out of a JSON error body. Returns
 * undefined when the body is empty or not the expected shape, so callers can
 * decide whether to substitute a generic message.
 *
 * @param {string} rawBody
 * @returns {string | undefined}
 */
function extractErrorMessage(rawBody) {
  if (!rawBody) return undefined
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return undefined
  }
  if (parsed && typeof parsed === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (parsed)
    if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error
  }
  return undefined
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}
