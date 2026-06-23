// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { defaultConfigPath } from '../config/schema.js'
import { readObservabilityEnv } from '../observability/env.js'
import {
  readCredentials,
  remoteTokenEnvVar,
  removeToken,
  writeToken,
} from '../remote/credentials.js'

/**
 * @import { CommandRunContext } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Core `remote` commands manage named MCP targets + their query-scoped
 * tokens (LLP 0033 §commands). `hyp` is the MCP client on the human-CLI
 * path, so these are **core**, not a plugin. `remote add` is a local-layer
 * config writer (create-or-augment); `remote login` writes the `0600`
 * credential store. An admin who never ran HypAware gets queryable in two
 * commands: `remote add prod <url>` → `remote login prod`.
 */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runRemoteHelp(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp remote <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: add, login, list, remove\n')
    return 0
  }
  ctx.stderr.write(`hyp remote: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: add, login, list, remove\n')
  return 2
}

/**
 * `hyp remote add <name> <url>` — register (or update) a target in the
 * local config's `query.remotes`. The URL is non-secret and committable.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0033#commands [implements] — `remote add` is a local-layer writer; URL in config, token never in config
 */
export async function runRemoteAdd(argv, ctx) {
  const positional = argv.filter((a) => !a.startsWith('-'))
  const [name, url] = positional
  if (!name || !url) {
    ctx.stderr.write('usage: hyp remote add <name> <url>\n')
    return 2
  }
  if (!/^https?:\/\//.test(url)) {
    ctx.stderr.write(`hyp remote add: url must be an http(s) URL (got ${url})\n`)
    return 2
  }
  const configPath = localConfigPath(ctx)
  try {
    await mutateLocalConfig(configPath, (config) => {
      const query = (config.query = isObject(config.query) ? config.query : {})
      const remotes = (query.remotes = isObject(query.remotes) ? query.remotes : {})
      remotes[name] = { url }
    })
  } catch (err) {
    ctx.stderr.write(`hyp remote add: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  ctx.stdout.write(`added remote '${name}' → ${url}\n`)
  ctx.stdout.write(`  next: hyp remote login ${name}\n`)
  return 0
}

/**
 * `hyp remote login <name>` — store the query-scoped token for a target.
 * Token source: `--token-file <path>` or piped stdin (a TTY with neither is
 * an error, never a hang).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0033#credentials [implements] — token to the 0600 store, never config; one login per server
 */
export async function runRemoteLogin(argv, ctx) {
  const positional = argv.filter((a) => !a.startsWith('-'))
  const name = positional[0]
  if (!name) {
    ctx.stderr.write('usage: hyp remote login <name> [--token-file <path>]\n')
    return 2
  }
  const tokenFileIdx = argv.indexOf('--token-file')
  const tokenFile = tokenFileIdx >= 0 ? argv[tokenFileIdx + 1] : undefined
  if (tokenFileIdx >= 0 && (!tokenFile || tokenFile.startsWith('-'))) {
    ctx.stderr.write('hyp remote login: --token-file expects a path\n')
    return 2
  }

  /** @type {string} */
  let token
  try {
    if (tokenFile) {
      token = (await fs.readFile(tokenFile, 'utf8')).trim()
    } else {
      const stdin = /** @type {any} */ (ctx.stdin ?? process.stdin)
      if (stdin && stdin.isTTY) {
        ctx.stderr.write("hyp remote login: provide the token via --token-file <path> or pipe it on stdin\n")
        return 2
      }
      token = (await readAllStdin(stdin)).trim()
    }
  } catch (err) {
    ctx.stderr.write(`hyp remote login: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (!token) {
    ctx.stderr.write('hyp remote login: empty token\n')
    return 2
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir
  await writeToken(stateDir, name, token)
  ctx.stdout.write(`stored query-scoped token for '${name}' (mode 0600)\n`)

  // A friendly nudge if the target isn't configured — the token still
  // stores (an env override may use it), but a typo here is common.
  const remotes = await readConfiguredRemotes(ctx)
  if (!remotes[name]) {
    ctx.stderr.write(`note: '${name}' is not a configured target — add it with 'hyp remote add ${name} <url>'\n`)
  }
  return 0
}

/**
 * `hyp remote list` — targets + token status (`stored` / `env` / `missing`),
 * never the token itself.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runRemoteList(argv, ctx) {
  const json = argv.includes('--json')
  const remotes = await readConfiguredRemotes(ctx)
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const stored = await readCredentials(stateDir)
  const names = Object.keys(remotes).sort()

  /** @param {string} name */
  const tokenStatus = (name) => {
    if (typeof ctx.env[remoteTokenEnvVar(name)] === 'string' && ctx.env[remoteTokenEnvVar(name)]) return 'env'
    return stored[name] ? 'stored' : 'missing'
  }

  if (json) {
    ctx.stdout.write(JSON.stringify(
      names.map((name) => ({ name, url: remotes[name].url, token: tokenStatus(name) })),
      null,
      2
    ) + '\n')
    return 0
  }
  if (names.length === 0) {
    ctx.stdout.write("no remote targets configured — add one with 'hyp remote add <name> <url>'\n")
    return 0
  }
  for (const name of names) {
    ctx.stdout.write(`  ${name}\t${remotes[name].url}\ttoken: ${tokenStatus(name)}\n`)
  }
  return 0
}

/**
 * `hyp remote remove <name>` — drop the target from config + its stored token.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runRemoteRemove(argv, ctx) {
  const positional = argv.filter((a) => !a.startsWith('-'))
  const name = positional[0]
  if (!name) {
    ctx.stderr.write('usage: hyp remote remove <name>\n')
    return 2
  }
  let removedConfig = false
  const configPath = localConfigPath(ctx)
  try {
    await mutateLocalConfig(configPath, (config) => {
      if (isObject(config.query) && isObject(config.query.remotes) && config.query.remotes[name] !== undefined) {
        delete config.query.remotes[name]
        removedConfig = true
        if (config.query.default_remote === name) delete config.query.default_remote
      }
    })
  } catch (err) {
    ctx.stderr.write(`hyp remote remove: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const removedToken = await removeToken(stateDir, name)
  if (!removedConfig && !removedToken) {
    ctx.stderr.write(`hyp remote remove: no target or token named '${name}'\n`)
    return 1
  }
  ctx.stdout.write(`removed remote '${name}'${removedToken ? ' (config + token)' : ' (config)'}\n`)
  return 0
}

/* ---------- helpers ---------- */

/**
 * @param {CommandRunContext} ctx
 * @returns {string}
 */
function localConfigPath(ctx) {
  if (ctx.env.HYP_CONFIG) return path.resolve(ctx.env.HYP_CONFIG)
  return defaultConfigPath(readObservabilityEnv(ctx.env).hypHome)
}

/**
 * Read the configured `query.remotes` from the local config file (raw, so a
 * malformed-but-readable file still surfaces what targets exist).
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<Record<string, { url: string }>>}
 */
async function readConfiguredRemotes(ctx) {
  const config = await readLocalConfigRaw(localConfigPath(ctx))
  if (isObject(config.query) && isObject(config.query.remotes)) {
    /** @type {Record<string, { url: string }>} */
    const out = {}
    for (const [name, entry] of Object.entries(config.query.remotes)) {
      if (isObject(entry) && typeof entry.url === 'string') out[name] = { url: entry.url }
    }
    return out
  }
  return {}
}

/**
 * Create-or-augment the local config file with `mutate`. Reads the raw JSON
 * (preserving the user's file), applies the mutation, and writes atomically.
 *
 * @param {string} configPath
 * @param {(config: any) => void} mutate
 * @returns {Promise<void>}
 */
async function mutateLocalConfig(configPath, mutate) {
  const config = await readLocalConfigRaw(configPath)
  if (config.version === undefined) config.version = 2
  mutate(config)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmpPath = `${configPath}.tmp-${process.pid}`
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n')
  await fs.rename(tmpPath, configPath)
}

/**
 * @param {string} configPath
 * @returns {Promise<any>}
 */
async function readLocalConfigRaw(configPath) {
  let raw
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { version: 2 }
    throw err
  }
  try {
    const parsed = JSON.parse(raw)
    return isObject(parsed) ? parsed : { version: 2 }
  } catch {
    throw new Error(`local config is not valid JSON: ${configPath}`)
  }
}

/**
 * @param {any} stdin
 * @returns {Promise<string>}
 */
async function readAllStdin(stdin) {
  if (!stdin) return ''
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
