import fs from 'node:fs'
import process from 'node:process'
import {
  ConfigError,
  loadConfig as defaultLoadConfig,
  parseConfig as parseCollectivusConfig,
  validateCollectivusConfig,
} from '../config.js'
import { GATEWAY_ID_MAX_LENGTH, GATEWAY_ID_PATTERN } from '../gateway_id.js'
import { sha256Hex } from '../rendezvous/store.js'
import { createConfigRegistry, deleteConfig, getConfig, listGateways, resolveConfigsDir, setConfig } from '../server/config_registry.js'
import {
  createEnrollmentStore,
  generateEnrollmentCode,
  registerEnrollment,
  resolveEnrollmentStorePath,
} from '../server/enrollment.js'
import { BootstrapStore, DEFAULT_BOOTSTRAP_TTL_SECONDS } from '../server/identity.js'
import { shellSingleQuote } from '../server/util.js'
import { defaultPrompt } from './common.js'

/**
 * @import { CollectivusConfig, ServerConfig } from '../types.js'
 * @import { ConfigCliHooks, ParsedConfigArgs, ParsedDelete, ParsedError, ParsedGet, ParsedHelp, ParsedList, ParsedSet, ParsedTokenIssue, ParsedTokenRevoke } from './types.d.ts'
 * @import { ConfigRegistry } from '../server/types.d.ts'
 */

const USAGE = `Usage:
  ctvs config set <gateway-id> --server-config <path> --file <config.json>
  ctvs config get <gateway-id> --server-config <path>
  ctvs config list --server-config <path>
  ctvs config delete <gateway-id> --server-config <path> [--yes]
  ctvs config bootstrap-token issue <gateway-id> --server-config <path> [--ttl-seconds <n>]
                                               [--rendezvous <url>] [--rendezvous-token <token>]
                                               [--max-uses <n>]
  ctvs config bootstrap-token revoke <gateway-id> --server-config <path>

Options:
  --server-config <path>   Path to the server's collectivus.json config
  --server-config-env <e>  Environment variable containing the server config JSON
  --file <path>            For \`set\`: path to the JSON config to register
  --yes, -y                For \`delete\`: skip the interactive confirmation
  --ttl-seconds <n>        For \`bootstrap-token issue\`: TTL override in seconds
  --rendezvous <url>       For \`bootstrap-token issue\`: register a short join key with rendezvous
  --rendezvous-token <t>   For \`bootstrap-token issue\`: rendezvous registration bearer token
                           (or COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN)
  --max-uses <n>           For rendezvous issue: number of successful joins allowed (default 1)
  --help, -h               Show this help`

const RENDEZVOUS_TOKEN_ENV = 'COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN'
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse the argument list of `collectivus config <subcommand>`.
 *
 * @param {string[]} argv
 * @returns {ParsedConfigArgs}
 */
export function parseConfigArgs(argv) {
  if (argv.length === 0) {
    return { kind: 'error', message: 'subcommand is required', exitCode: 2 }
  }
  const [first, ...rest] = argv
  if (first === '--help' || first === '-h') return { kind: 'help' }
  switch (first) {
  case 'set': return parseSet(rest)
  case 'get': return parseGet(rest)
  case 'list': return parseList(rest)
  case 'delete': return parseDelete(rest)
  case 'bootstrap-token': return parseBootstrapToken(rest)
  default:
    return { kind: 'error', message: `unknown subcommand: ${first}`, exitCode: 2 }
  }
}

/**
 * @param {string[]} argv
 * @returns {ParsedSet | ParsedHelp | ParsedError}
 */
function parseSet(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  /** @type {string | undefined} */ let serverConfigEnv
  /** @type {string | undefined} */ let file
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const sourceFlag = parseServerConfigSourceFlag(arg, argv, i)
    if (sourceFlag.matched) {
      if (sourceFlag.error) return parseError(sourceFlag.error)
      if (sourceFlag.serverConfig !== undefined) serverConfig = sourceFlag.serverConfig
      if (sourceFlag.serverConfigEnv !== undefined) serverConfigEnv = sourceFlag.serverConfigEnv
      i = sourceFlag.index
      continue
    }
    if (arg === '--file' || arg.startsWith('--file=')) {
      const value = arg === '--file' ? argv[++i] : arg.slice('--file='.length)
      if (!value) return parseError('--file requires a path')
      file = value
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  const sourceError = validateServerConfigSource(serverConfig, serverConfigEnv)
  if (sourceError) return sourceError
  if (!file) return parseError('--file is required')
  return withServerConfigSource({ kind: 'set', gatewayId, file }, serverConfig, serverConfigEnv)
}

/**
 * @param {string[]} argv
 * @returns {ParsedGet | ParsedHelp | ParsedError}
 */
function parseGet(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  /** @type {string | undefined} */ let serverConfigEnv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const sourceFlag = parseServerConfigSourceFlag(arg, argv, i)
    if (sourceFlag.matched) {
      if (sourceFlag.error) return parseError(sourceFlag.error)
      if (sourceFlag.serverConfig !== undefined) serverConfig = sourceFlag.serverConfig
      if (sourceFlag.serverConfigEnv !== undefined) serverConfigEnv = sourceFlag.serverConfigEnv
      i = sourceFlag.index
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  const sourceError = validateServerConfigSource(serverConfig, serverConfigEnv)
  if (sourceError) return sourceError
  return withServerConfigSource({ kind: 'get', gatewayId }, serverConfig, serverConfigEnv)
}

/**
 * @param {string[]} argv
 * @returns {ParsedList | ParsedHelp | ParsedError}
 */
function parseList(argv) {
  /** @type {string | undefined} */ let serverConfig
  /** @type {string | undefined} */ let serverConfigEnv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const sourceFlag = parseServerConfigSourceFlag(arg, argv, i)
    if (sourceFlag.matched) {
      if (sourceFlag.error) return parseError(sourceFlag.error)
      if (sourceFlag.serverConfig !== undefined) serverConfig = sourceFlag.serverConfig
      if (sourceFlag.serverConfigEnv !== undefined) serverConfigEnv = sourceFlag.serverConfigEnv
      i = sourceFlag.index
      continue
    }
    return parseError(`unknown argument: ${arg}`)
  }
  const sourceError = validateServerConfigSource(serverConfig, serverConfigEnv)
  if (sourceError) return sourceError
  return withServerConfigSource({ kind: 'list' }, serverConfig, serverConfigEnv)
}

/**
 * @param {string[]} argv
 * @returns {ParsedDelete | ParsedHelp | ParsedError}
 */
function parseDelete(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  /** @type {string | undefined} */ let serverConfigEnv
  let yes = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const sourceFlag = parseServerConfigSourceFlag(arg, argv, i)
    if (sourceFlag.matched) {
      if (sourceFlag.error) return parseError(sourceFlag.error)
      if (sourceFlag.serverConfig !== undefined) serverConfig = sourceFlag.serverConfig
      if (sourceFlag.serverConfigEnv !== undefined) serverConfigEnv = sourceFlag.serverConfigEnv
      i = sourceFlag.index
      continue
    }
    if (arg === '--yes' || arg === '-y') { yes = true; continue }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  const sourceError = validateServerConfigSource(serverConfig, serverConfigEnv)
  if (sourceError) return sourceError
  return withServerConfigSource({ kind: 'delete', gatewayId, yes }, serverConfig, serverConfigEnv)
}

/**
 * @param {string[]} argv
 * @returns {ParsedTokenIssue | ParsedTokenRevoke | ParsedHelp | ParsedError}
 */
function parseBootstrapToken(argv) {
  if (argv.length === 0) return parseError('bootstrap-token requires "issue" or "revoke"')
  const [action, ...rest] = argv
  if (action === '--help' || action === '-h') return { kind: 'help' }
  if (action === 'issue') return parseTokenIssue(rest)
  if (action === 'revoke') return parseTokenRevoke(rest)
  return parseError(`unknown bootstrap-token action: ${action}`)
}

/**
 * @param {string[]} argv
 * @returns {ParsedTokenIssue | ParsedHelp | ParsedError}
 */
function parseTokenIssue(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  /** @type {string | undefined} */ let serverConfigEnv
  /** @type {number | undefined} */ let ttlSeconds
  /** @type {number | undefined} */ let maxUses
  /** @type {string | undefined} */ let rendezvous
  /** @type {string | undefined} */ let rendezvousToken
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const sourceFlag = parseServerConfigSourceFlag(arg, argv, i)
    if (sourceFlag.matched) {
      if (sourceFlag.error) return parseError(sourceFlag.error)
      if (sourceFlag.serverConfig !== undefined) serverConfig = sourceFlag.serverConfig
      if (sourceFlag.serverConfigEnv !== undefined) serverConfigEnv = sourceFlag.serverConfigEnv
      i = sourceFlag.index
      continue
    }
    if (arg === '--ttl-seconds' || arg.startsWith('--ttl-seconds=')) {
      const value = arg === '--ttl-seconds' ? argv[++i] : arg.slice('--ttl-seconds='.length)
      if (!value) return parseError('--ttl-seconds requires a value')
      const n = Number.parseInt(value, 10)
      if (!Number.isInteger(n) || n <= 0 || String(n) !== value.trim()) {
        return parseError('--ttl-seconds must be a positive integer')
      }
      ttlSeconds = n
      continue
    }
    if (arg === '--max-uses' || arg.startsWith('--max-uses=')) {
      const value = arg === '--max-uses' ? argv[++i] : arg.slice('--max-uses='.length)
      if (!value) return parseError('--max-uses requires a value')
      const n = Number.parseInt(value, 10)
      if (!Number.isInteger(n) || n <= 0 || String(n) !== value.trim()) {
        return parseError('--max-uses must be a positive integer')
      }
      maxUses = n
      continue
    }
    if (arg === '--rendezvous' || arg.startsWith('--rendezvous=')) {
      const value = arg === '--rendezvous' ? argv[++i] : arg.slice('--rendezvous='.length)
      if (!value) return parseError('--rendezvous requires a URL')
      if (!isHttpUrl(value)) return parseError('--rendezvous requires an http(s) URL')
      rendezvous = value
      continue
    }
    if (arg === '--rendezvous-token' || arg.startsWith('--rendezvous-token=')) {
      const value = arg === '--rendezvous-token' ? argv[++i] : arg.slice('--rendezvous-token='.length)
      if (!value) return parseError('--rendezvous-token requires a token')
      rendezvousToken = value
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  const sourceError = validateServerConfigSource(serverConfig, serverConfigEnv)
  if (sourceError) return sourceError
  if (rendezvousToken && !rendezvous) return parseError('--rendezvous-token requires --rendezvous')
  if (maxUses !== undefined && !rendezvous) return parseError('--max-uses requires --rendezvous')
  /** @type {ParsedTokenIssue} */
  const result = withServerConfigSource({ kind: 'token-issue', gatewayId }, serverConfig, serverConfigEnv)
  if (ttlSeconds !== undefined) result.ttlSeconds = ttlSeconds
  if (maxUses !== undefined) result.maxUses = maxUses
  if (rendezvous !== undefined) result.rendezvous = rendezvous
  if (rendezvousToken !== undefined) result.rendezvousToken = rendezvousToken
  return result
}

/**
 * @param {string[]} argv
 * @returns {ParsedTokenRevoke | ParsedHelp | ParsedError}
 */
function parseTokenRevoke(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  /** @type {string | undefined} */ let serverConfigEnv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const sourceFlag = parseServerConfigSourceFlag(arg, argv, i)
    if (sourceFlag.matched) {
      if (sourceFlag.error) return parseError(sourceFlag.error)
      if (sourceFlag.serverConfig !== undefined) serverConfig = sourceFlag.serverConfig
      if (sourceFlag.serverConfigEnv !== undefined) serverConfigEnv = sourceFlag.serverConfigEnv
      i = sourceFlag.index
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  const sourceError = validateServerConfigSource(serverConfig, serverConfigEnv)
  if (sourceError) return sourceError
  return withServerConfigSource({ kind: 'token-revoke', gatewayId }, serverConfig, serverConfigEnv)
}

/**
 * @param {string} arg
 * @param {string[]} argv
 * @param {number} index
 * @returns {{ matched: false } | { matched: true, index: number, serverConfig?: string, serverConfigEnv?: string, error?: string }}
 */
function parseServerConfigSourceFlag(arg, argv, index) {
  if (arg === '--server-config' || arg.startsWith('--server-config=')) {
    const value = arg === '--server-config' ? argv[index + 1] : arg.slice('--server-config='.length)
    if (!value) return { matched: true, index, error: '--server-config requires a path' }
    return { matched: true, index: arg === '--server-config' ? index + 1 : index, serverConfig: value }
  }
  if (arg === '--server-config-env' || arg.startsWith('--server-config-env=')) {
    const value = arg === '--server-config-env' ? argv[index + 1] : arg.slice('--server-config-env='.length)
    if (!value) return { matched: true, index, error: '--server-config-env requires an environment variable name' }
    if (!ENV_NAME_PATTERN.test(value)) {
      return { matched: true, index, error: '--server-config-env must be an environment variable name' }
    }
    return { matched: true, index: arg === '--server-config-env' ? index + 1 : index, serverConfigEnv: value }
  }
  return { matched: false }
}

/**
 * @param {string | undefined} serverConfig
 * @param {string | undefined} serverConfigEnv
 * @returns {ParsedError | undefined}
 */
function validateServerConfigSource(serverConfig, serverConfigEnv) {
  if (!serverConfig && !serverConfigEnv) return parseError('--server-config or --server-config-env is required')
  if (serverConfig && serverConfigEnv) {
    return parseError('--server-config and --server-config-env are mutually exclusive')
  }
  return undefined
}

/**
 * @template {object} T
 * @param {T} result
 * @param {string | undefined} serverConfig
 * @param {string | undefined} serverConfigEnv
 * @returns {T & { serverConfig?: string, serverConfigEnv?: string }}
 */
function withServerConfigSource(result, serverConfig, serverConfigEnv) {
  const out = /** @type {T & { serverConfig?: string, serverConfigEnv?: string }} */ (result)
  if (serverConfig !== undefined) out.serverConfig = serverConfig
  if (serverConfigEnv !== undefined) out.serverConfigEnv = serverConfigEnv
  return out
}

/**
 * @param {string} message
 * @returns {ParsedError}
 */
function parseError(message) {
  return { kind: 'error', message, exitCode: 2 }
}

/**
 * Mirrors the registry's gateway-id rules so a malformed id is rejected at
 * parse time with a friendly message rather than bubbling up from the registry
 * as a generic "invalid gatewayId" error.
 *
 * @param {string} id
 * @returns {ParsedError | undefined}
 */
function validateGatewayId(id) {
  if (id.length > GATEWAY_ID_MAX_LENGTH || !GATEWAY_ID_PATTERN.test(id) || id === '.' || id === '..') {
    return parseError(
      `invalid gateway-id ${JSON.stringify(id)}: must start with [A-Za-z0-9] and contain only [A-Za-z0-9._+@-] (max ${GATEWAY_ID_MAX_LENGTH} chars); cannot be "." or ".."`
    )
  }
  return undefined
}

/**
 * Run `collectivus config <subcommand>`.
 *
 * Operator-mode CLI for managing per-gateway configs and bootstrap tokens.
 * Every subcommand needs `--server-config` so we can locate `data_dir` (config
 * registry) and `identity_issuer.bootstrap_store_path` (bootstrap store) — the
 * CLI must read the same on-disk state the running server uses.
 *
 * @param {string[]} argv
 * @param {ConfigCliHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runConfig(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const isTTY = hooks.isTTY ?? Boolean(process.stdin.isTTY)
  const promptFn = hooks.prompt ?? defaultPrompt
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig
  const readFileFn = hooks.readFile ?? ((/** @type {string} */ p) => fs.readFileSync(p, 'utf8'))
  const env = hooks.env ?? process.env
  const fetchFn = hooks.fetch ?? fetch
  const makeRegistry = hooks.makeRegistry ?? ((/** @type {ServerConfig} */ s) => createConfigRegistry({ configsDir: resolveConfigsDir(s) }))
  const makeBootstrapStore = hooks.makeBootstrapStore ?? ((/** @type {string} */ p) => new BootstrapStore({ path: p }))
  const makeEnrollmentStore = hooks.makeEnrollmentStore ?? ((/** @type {string} */ p) => createEnrollmentStore({ path: p }))

  const parsed = parseConfigArgs(argv)
  if (parsed.kind === 'help') {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.kind === 'error') {
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
  }

  /** @type {CollectivusConfig} */
  let serverConfig
  try {
    serverConfig = loadServerConfig(parsed, { env, loadConfig: loadConfigFn })
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`error: server config: ${err.message}\n`)
      return 1
    }
    throw err
  }

  if (serverConfig.role !== 'server' || !serverConfig.server) {
    stderr.write('error: server config must have role: "server" (the operator CLI runs on the server host)\n')
    return 1
  }
  const server = serverConfig.server

  switch (parsed.kind) {
  case 'set': return runSet(parsed, server, { stdout, stderr, readFile: readFileFn, makeRegistry })
  case 'get': return runGet(parsed, server, { stdout, stderr, makeRegistry })
  case 'list': return runList(parsed, server, { stdout, makeRegistry })
  case 'delete': return runDelete(parsed, server, { stdout, stderr, isTTY, prompt: promptFn, makeRegistry })
  case 'token-issue': return runTokenIssue(parsed, server, { stdout, stderr, env, fetchFn, makeBootstrapStore, makeEnrollmentStore })
  case 'token-revoke': return runTokenRevoke(parsed, server, { stdout, makeBootstrapStore })
  default: {
    /** @type {never} */ const exhaustive = parsed
    void exhaustive
    return 1
  }
  }
}

/**
 * @param {{ serverConfig?: string, serverConfigEnv?: string }} parsed
 * @param {{ env: NodeJS.ProcessEnv, loadConfig: (p: string) => CollectivusConfig }} ctx
 * @returns {CollectivusConfig}
 */
function loadServerConfig(parsed, ctx) {
  if (parsed.serverConfigEnv) {
    const raw = ctx.env[parsed.serverConfigEnv]
    if (!raw) throw new ConfigError(`environment variable ${parsed.serverConfigEnv} is not set`)
    return parseCollectivusConfig(raw, `env:${parsed.serverConfigEnv}`)
  }
  if (!parsed.serverConfig) throw new ConfigError('missing server config source')
  return ctx.loadConfig(parsed.serverConfig)
}

/**
 * @param {ParsedSet} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   readFile: (p: string) => string,
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {number}
 */
function runSet(parsed, server, ctx) {
  /** @type {string} */
  let raw
  try {
    raw = ctx.readFile(parsed.file)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') {
      ctx.stderr.write(`error: file not found: ${parsed.file}\n`)
      return 1
    }
    ctx.stderr.write(`error: failed to read ${parsed.file}: ${formatError(err)}\n`)
    return 1
  }

  /** @type {unknown} */
  let parsedConfig
  try {
    parsedConfig = JSON.parse(raw)
  } catch (err) {
    ctx.stderr.write(`error: invalid JSON in ${parsed.file}: ${formatError(err)}\n`)
    return 1
  }

  // Validate up-front with the operator's stderr so unknown top-level keys
  // produce a visible warning here (the registry's own validation is silent).
  try {
    validateCollectivusConfig(parsedConfig, { stderr: ctx.stderr })
  } catch (err) {
    if (err instanceof ConfigError) {
      ctx.stderr.write(`error: invalid config: ${err.message}\n`)
      return 1
    }
    throw err
  }

  /** @type {ConfigRegistry} */
  const registry = ctx.makeRegistry(server)
  /** @type {{ etag: string }} */
  let result
  try {
    result = setConfig(registry, parsed.gatewayId, parsedConfig)
  } catch (err) {
    ctx.stderr.write(`error: failed to write config: ${formatError(err)}\n`)
    return 1
  }
  ctx.stdout.write(`✓ Wrote config for ${parsed.gatewayId} (etag ${result.etag})\n`)
  return 0
}

/**
 * @param {ParsedGet} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {number}
 */
function runGet(parsed, server, ctx) {
  const registry = ctx.makeRegistry(server)
  /** @type {ReturnType<typeof getConfig>} */
  let entry
  try {
    entry = getConfig(registry, parsed.gatewayId)
  } catch (err) {
    ctx.stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  if (!entry) {
    ctx.stderr.write(`error: no config found for ${parsed.gatewayId}\n`)
    return 1
  }
  ctx.stdout.write(JSON.stringify(entry.config, null, 2) + '\n')
  return 0
}

/**
 * @param {ParsedList} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {number}
 */
function runList(parsed, server, ctx) {
  void parsed
  const registry = ctx.makeRegistry(server)
  const ids = listGateways(registry)
  for (const id of ids) ctx.stdout.write(id + '\n')
  return 0
}

/**
 * @param {ParsedDelete} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   isTTY: boolean,
 *   prompt: (q: string) => Promise<string>,
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {Promise<number>}
 */
async function runDelete(parsed, server, ctx) {
  if (!parsed.yes) {
    if (!ctx.isTTY) {
      ctx.stderr.write('error: refusing to delete without --yes (no TTY for confirmation)\n')
      return 1
    }
    const answer = await ctx.prompt(`Delete config for ${parsed.gatewayId}? [y/N] `)
    if (!/^y(es)?$/i.test(answer)) {
      ctx.stdout.write('  Cancelled.\n')
      return 0
    }
  }
  const registry = ctx.makeRegistry(server)
  /** @type {boolean} */
  let removed
  try {
    removed = deleteConfig(registry, parsed.gatewayId)
  } catch (err) {
    ctx.stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  if (removed) {
    ctx.stdout.write(`✓ Deleted config for ${parsed.gatewayId}\n`)
  } else {
    ctx.stdout.write(`  No config registered for ${parsed.gatewayId}; nothing to delete.\n`)
  }
  return 0
}

/**
 * @param {ParsedTokenIssue} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   env: NodeJS.ProcessEnv,
 *   fetchFn: typeof fetch,
 *   makeBootstrapStore: (p: string) => BootstrapStore,
 *   makeEnrollmentStore: (p: string) => import('../server/enrollment.d.ts').EnrollmentStore,
 * }} ctx
 * @returns {Promise<number>}
 */
async function runTokenIssue(parsed, server, ctx) {
  const storePath = server.identity_issuer.bootstrap_store_path
  if (!storePath) {
    ctx.stderr.write(
      'error: server.identity_issuer.bootstrap_store_path is not set; ' +
      'add it to the server config so bootstrap tokens can be issued\n'
    )
    return 1
  }
  const rendezvousToken = parsed.rendezvous
    ? parsed.rendezvousToken ?? ctx.env[RENDEZVOUS_TOKEN_ENV]
    : undefined
  if (parsed.rendezvous && !rendezvousToken) {
    ctx.stderr.write(`error: --rendezvous-token or ${RENDEZVOUS_TOKEN_ENV} is required when --rendezvous is set\n`)
    return 1
  }
  if (parsed.rendezvous && !server.public_url) {
    ctx.stderr.write(
      'error: server.public_url is required when --rendezvous is set; ' +
      'set it to the Central server URL gateways can reach\n'
    )
    return 1
  }

  const ttlSeconds = parsed.ttlSeconds ?? server.identity_issuer.bootstrap_ttl_seconds
  if (parsed.rendezvous && rendezvousToken && server.public_url) {
    return await runRendezvousTokenIssue({ ...parsed, rendezvous: parsed.rendezvous }, { ...server, public_url: server.public_url }, {
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      fetchFn: ctx.fetchFn,
      makeEnrollmentStore: ctx.makeEnrollmentStore,
      rendezvousToken,
      ttlSeconds: ttlSeconds ?? DEFAULT_BOOTSTRAP_TTL_SECONDS,
    })
  }

  const store = ctx.makeBootstrapStore(storePath)
  /** @type {{ token: string, expiresAt: number }} */
  let result
  try {
    result = ttlSeconds !== undefined
      ? store.register({ gatewayId: parsed.gatewayId, ttlSeconds })
      : store.register({ gatewayId: parsed.gatewayId })
  } catch (err) {
    ctx.stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  // Print the plaintext token on its own line so it round-trips through pipes
  // and copy-paste cleanly. The expiry goes to stderr so the operator sees it
  // interactively without polluting `--quiet`-style scripted captures.
  ctx.stdout.write(result.token + '\n')
  ctx.stderr.write(
    `Token issued for ${parsed.gatewayId}; expires at ${formatExpiry(result.expiresAt)}.\n` +
    'Hand this token to the gateway in central_server.identity.bootstrap_token. It can be redeemed exactly once.\n'
  )
  if (server.public_url) {
    ctx.stderr.write(
      'One-line gateway setup:\n' +
      `  npx collectivus --config-endpoint='${bootstrapConfigUrl(server.public_url, result.token)}'\n`
    )
  }
  return 0
}

/**
 * @param {ParsedTokenIssue & { rendezvous: string }} parsed
 * @param {ServerConfig & { public_url: string }} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   fetchFn: typeof fetch,
 *   makeEnrollmentStore: (p: string) => import('../server/enrollment.d.ts').EnrollmentStore,
 *   rendezvousToken: string,
 *   ttlSeconds: number,
 * }} ctx
 * @returns {Promise<number>}
 */
async function runRendezvousTokenIssue(parsed, server, ctx) {
  const joinCode = generateEnrollmentCode()
  const maxUses = parsed.maxUses ?? 1
  const enrollmentStore = ctx.makeEnrollmentStore(resolveEnrollmentStorePath(server))
  /** @type {ReturnType<typeof registerEnrollment>} */
  let record
  try {
    record = registerEnrollment(enrollmentStore, {
      joinCodeHash: sha256Hex(joinCode),
      gatewayId: parsed.gatewayId,
      ttlSeconds: ctx.ttlSeconds,
      maxUses,
    })
  } catch (err) {
    ctx.stderr.write(`error: failed to register enrollment: ${formatError(err)}\n`)
    return 1
  }

  try {
    await registerRendezvousInvite({
      kind: 'enterprise_enrollment',
      rendezvousUrl: parsed.rendezvous,
      registrationToken: ctx.rendezvousToken,
      joinCodeHash: sha256Hex(joinCode),
      connectUrl: server.public_url,
      gatewayId: parsed.gatewayId,
      expiresAt: record.expiresAt,
      maxUses,
      fetchFn: ctx.fetchFn,
    })
  } catch (err) {
    ctx.stderr.write(`error: failed to register rendezvous invite: ${formatError(err)}\n`)
    return 1
  }

  ctx.stdout.write(joinCode + '\n')
  ctx.stderr.write(
    `Rendezvous join key issued for ${parsed.gatewayId}; ` +
    `expires at ${formatExpiry(record.expiresAt)}; max uses ${maxUses}.\n` +
    'One-line gateway setup via rendezvous:\n' +
    `  npx collectivus join ${shellSingleQuote(joinCode)} --rendezvous ${shellSingleQuote(parsed.rendezvous)}\n`
  )
  return 0
}

/**
 * @param {ParsedTokenRevoke} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   makeBootstrapStore: (p: string) => BootstrapStore,
 * }} ctx
 * @returns {number}
 */
function runTokenRevoke(parsed, server, ctx) {
  const storePath = server.identity_issuer.bootstrap_store_path
  if (!storePath) {
    // No store configured ⇒ no tokens exist. Treat as no-op rather than error;
    // a revoke that finds nothing has the same effect either way.
    ctx.stdout.write(`  No bootstrap store configured; 0 tokens revoked for ${parsed.gatewayId}.\n`)
    return 0
  }
  const store = ctx.makeBootstrapStore(storePath)
  const removed = store.revokeUnusedForGateway(parsed.gatewayId)
  ctx.stdout.write(`✓ Revoked ${removed} unused bootstrap token${removed === 1 ? '' : 's'} for ${parsed.gatewayId}\n`)
  return 0
}

/**
 * @param {number} epochSeconds
 * @returns {string}
 */
function formatExpiry(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString()
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * @param {string} publicUrl
 * @param {string} token
 * @returns {string}
 */
function bootstrapConfigUrl(publicUrl, token) {
  const base = publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`
  const url = new URL('/v1/bootstrap-config', base)
  url.searchParams.set('token', token)
  return url.toString()
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * @param {{
 *   kind?: 'one_time_gateway' | 'enterprise_enrollment',
 *   rendezvousUrl: string,
 *   registrationToken: string,
 *   joinCodeHash: string,
 *   connectUrl: string,
 *   gatewayId: string,
 *   expiresAt: number,
 *   maxUses?: number,
 *   fetchFn: typeof fetch,
 * }} args
 * @returns {Promise<void>}
 */
async function registerRendezvousInvite(args) {
  const response = await args.fetchFn(joinUrl(args.rendezvousUrl, '/v1/rendezvous/invites'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.registrationToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      kind: args.kind ?? 'one_time_gateway',
      join_code_hash: args.joinCodeHash,
      connect_url: args.connectUrl,
      gateway_id: args.gatewayId,
      expires_at: formatExpiry(args.expiresAt),
      ...args.maxUses !== undefined ? { max_uses: args.maxUses } : {},
    }),
  })
  if (!response.ok) {
    throw new Error(await readErrorDetail(response))
  }
}

/**
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorDetail(response) {
  /** @type {unknown} */
  let body
  try {
    body = await response.json()
  } catch {
    return `HTTP ${response.status} ${response.statusText}`
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && 'error' in body && typeof body.error === 'string') {
    return `${body.error} (HTTP ${response.status})`
  }
  return `HTTP ${response.status} ${response.statusText}`
}

