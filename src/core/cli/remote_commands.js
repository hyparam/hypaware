// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { defaultConfigPath } from '../config/schema.js'
import { readObservabilityEnv } from '../observability/env.js'
import {
  deriveIdentityBase,
  readCredentials,
  remoteTokenEnvVar,
  removeToken,
  writeSession,
  writeToken,
} from '../remote/credentials.js'
import { loginWithBrowser } from '../remote/oidc_login.js'

/**
 * @import { CommandRunContext } from '../../../collectivus-plugin-kernel-types.js'
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
    ctx.stdout.write('  login: browser sign-in by default; --token-file/stdin for a static token,\n')
    ctx.stdout.write('         --org <name> to select an org, --no-browser to print the URL\n')
    return 0
  }
  ctx.stderr.write(`hyp remote: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: add, login, list, remove\n')
  return 2
}

/**
 * `hyp remote add <name> <url>`: register (or update) a target in the
 * local config's `query.remotes`. The URL is non-secret and committable.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0033#commands [implements]: `remote add` is a local-layer writer; URL in config, token never in config
 */
export async function runRemoteAdd(argv, ctx) {
  const [name, url] = positionals(argv)
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
 * `hyp remote login <name>`: populate the target's query-scoped credential.
 *
 * Two modes, one store (LLP 0046 D1). A **static** token still comes from
 * `--token-file <path>` or piped stdin, unchanged (the headless escape hatch,
 * D8). Otherwise an interactive **browser** authorization-code flow runs
 * against the target's identity endpoint and stores an OIDC session. `--org`
 * selects an org; `--browser` forces the flow even with stdin piped;
 * `--no-browser` prints the URL instead of opening it.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ login?: typeof loginWithBrowser }} [deps] test seam for the browser flow
 * @ref LLP 0046#d1 [implements]: browser mode of `hyp remote login`; one command, one store, one more way to populate it
 */
export async function runRemoteLogin(argv, ctx, deps = {}) {
  const tokenFileIdx = argv.indexOf('--token-file')
  const tokenFile = tokenFileIdx >= 0 ? argv[tokenFileIdx + 1] : undefined
  if (tokenFileIdx >= 0 && (!tokenFile || tokenFile.startsWith('-'))) {
    ctx.stderr.write('hyp remote login: --token-file expects a path\n')
    return 2
  }
  const orgIdx = argv.indexOf('--org')
  const org = orgIdx >= 0 ? argv[orgIdx + 1] : undefined
  if (orgIdx >= 0 && (!org || org.startsWith('-'))) {
    ctx.stderr.write('hyp remote login: --org expects an org name\n')
    return 2
  }
  // The target name is the first positional. Skip the VALUE slot of a
  // value-taking flag so e.g. `login --org acme` (name omitted) is not misread
  // as the target 'acme'.
  const name = positionals(argv, new Set(['--token-file', '--org']))[0]
  if (!name) {
    ctx.stderr.write('usage: hyp remote login <name> [--token-file <path>] [--org <name>] [--no-browser]\n')
    return 2
  }
  const forceBrowser = argv.includes('--browser')
  const noBrowser = argv.includes('--no-browser')

  const stdin = /** @type {any} */ (ctx.stdin ?? process.stdin)
  const stdinPiped = !!stdin && !stdin.isTTY
  // Static path: an explicit token file, or a piped token unless a browser
  // mode flag forces the authorization-code flow.
  const useStatic = !!tokenFile || (stdinPiped && !forceBrowser && !noBrowser)

  if (useStatic) {
    // --org only applies to the browser flow; say so rather than silently drop it.
    if (org) {
      ctx.stderr.write('note: --org is ignored with a static token (it applies to the browser login flow)\n')
    }
    return runStaticLogin(name, tokenFile, stdin, ctx)
  }

  // `--no-browser` with a piped token is contradictory: the flag is a browser
  // mode modifier ("print the URL") but a piped token signals static intent.
  // Peek stdin to tell a real token apart from an empty pipe: a non-empty value
  // is stored statically (never silently discarded), while an empty pipe falls
  // through to the browser flow (which is what `--no-browser` is for).
  if (stdinPiped && noBrowser && !forceBrowser && !tokenFile) {
    /** @type {string} */
    let piped
    try {
      piped = (await readAllStdin(stdin)).trim()
    } catch (err) {
      ctx.stderr.write(`hyp remote login: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    if (piped) {
      ctx.stderr.write('note: --no-browser is ignored because a token was piped on stdin (storing it statically)\n')
      if (org) {
        ctx.stderr.write('note: --org is ignored with a static token (it applies to the browser login flow)\n')
      }
      return persistStaticToken(name, piped, ctx)
    }
    // Empty pipe: this is the documented "print the URL" path. The browser flow
    // below must not re-read the (now exhausted) stdin, so signal it explicitly.
    return runBrowserLogin(name, { org, noBrowser }, ctx, deps.login ?? loginWithBrowser)
  }

  return runBrowserLogin(name, { org, noBrowser }, ctx, deps.login ?? loginWithBrowser)
}

/**
 * Return the positional arguments in order, skipping flags and the value slot
 * of any value-taking flag (so e.g. `--org acme` is not read as a positional).
 * The one parser every `remote` subcommand uses, so a value flag added to any
 * of them never misreads its value as a positional.
 *
 * @param {string[]} argv
 * @param {Set<string>} [valueFlags]
 * @returns {string[]}
 */
function positionals(argv, valueFlags = new Set()) {
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++ // consume its value
      continue
    }
    out.push(a)
  }
  return out
}

/**
 * The static-token path (LLP 0033, unchanged behavior): read a token from
 * `--token-file` or piped stdin and store it as a `kind: 'static'` record.
 *
 * @param {string} name
 * @param {string | undefined} tokenFile
 * @param {any} stdin
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0046#d8 [implements]: static token stays the documented headless fallback
 */
async function runStaticLogin(name, tokenFile, stdin, ctx) {
  /** @type {string} */
  let token
  try {
    token = tokenFile
      ? (await fs.readFile(tokenFile, 'utf8')).trim()
      : (await readAllStdin(stdin)).trim()
  } catch (err) {
    ctx.stderr.write(`hyp remote login: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (!token) {
    ctx.stderr.write('hyp remote login: empty token\n')
    // Non-TTY stdin without a browser-mode flag routes here even when no
    // token was piped; point at the browser flow it bypassed.
    if (!tokenFile) {
      ctx.stderr.write('  (to sign in with a browser instead, re-run with --browser)\n')
    }
    return 2
  }

  return persistStaticToken(name, token, ctx)
}

/**
 * Store an already-read static token to the 0600 store and print the
 * confirmation, with a nudge when the target isn't configured. Shared by the
 * `--token-file`/piped static path and the `--no-browser`-with-a-piped-token
 * peek.
 *
 * @param {string} name
 * @param {string} token a non-empty, trimmed token
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function persistStaticToken(name, token, ctx) {
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  await writeToken(stateDir, name, token)
  ctx.stdout.write(`stored query-scoped token for '${name}' (mode 0600)\n`)

  // A friendly nudge if the target isn't configured: the token still
  // stores (an env override may use it), but a typo here is common.
  const remotes = await readConfiguredRemotes(ctx)
  if (!remotes[name]) {
    ctx.stderr.write(`note: '${name}' is not a configured target - add it with 'hyp remote add ${name} <url>'\n`)
  }
  return 0
}

/**
 * The browser authorization-code path (LLP 0046 D1/D6/D7). Derives the
 * identity base from the configured target URL's origin, runs the loopback
 * flow, and stores the resulting OIDC session.
 *
 * @param {string} name
 * @param {{ org?: string, noBrowser: boolean }} opts
 * @param {CommandRunContext} ctx
 * @param {typeof loginWithBrowser} login
 * @returns {Promise<number>}
 */
async function runBrowserLogin(name, { org, noBrowser }, ctx, login) {
  const remotes = await readConfiguredRemotes(ctx)
  const entry = remotes[name]
  if (!entry) {
    ctx.stderr.write(`hyp remote login: '${name}' is not a configured target - add it first with 'hyp remote add ${name} <url>'\n`)
    ctx.stderr.write("  (or pass a static token with --token-file <path>)\n")
    return 2
  }
  const identityBase = deriveIdentityBase(entry.url)
  if (!identityBase) {
    ctx.stderr.write(`hyp remote login: target '${name}' has an invalid url (${entry.url})\n`)
    return 2
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir
  try {
    const session = await login({
      identityBase,
      org,
      noBrowser,
      print: (line) => ctx.stderr.write(`${line}\n`),
    })
    await writeSession(stateDir, name, session)
    ctx.stdout.write(`logged in to '${name}' as org '${session.org}' (session stored, mode 0600)\n`)
    return 0
  } catch (err) {
    const callbackError = /** @type {any} */ (err)?.callbackError
    ctx.stderr.write(`hyp remote login: ${explainLoginError(callbackError, err)}\n`)
    // A server-surfaced callback error (org selection, membership) is already
    // actionable. A local failure - most importantly a timeout, which is what a
    // headless box hits when the opener silently fails - is not, so point at the
    // headless escape hatches rather than leaving the user stuck (LLP 0046 D8).
    if (!callbackError) {
      ctx.stderr.write("  (on a machine with no browser, pass a static token with --token-file <path> or pipe it on stdin; --no-browser prints the URL to open elsewhere)\n")
    }
    return 1
  }
}

/**
 * Translate a server-surfaced callback `error` (D7) into a clear message. The
 * client never sees the user's org list, so `org_selection_required` instructs
 * a re-run with `--org` rather than enumerating.
 *
 * @param {string | undefined} callbackError
 * @param {unknown} err
 * @returns {string}
 * @ref LLP 0046#d7 [implements]: org selector errors explained; never enumerate the user's orgs
 */
function explainLoginError(callbackError, err) {
  switch (callbackError) {
    case 'access_denied':
      return 'login was denied at the provider'
    case 'no_membership':
      return 'this account is not a member of any org on this server - ask an admin to invite you'
    case 'org_selection_required':
      return 'this account has more than one org - re-run with --org <name> to choose one'
    case 'org_not_permitted':
      return 'the selected org is not permitted for this account - check the --org name'
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

/**
 * `hyp remote list`: targets + token status (`stored` / `env` / `missing`),
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
    ctx.stdout.write("no remote targets configured - add one with 'hyp remote add <name> <url>'\n")
    return 0
  }
  for (const name of names) {
    ctx.stdout.write(`  ${name}\t${remotes[name].url}\ttoken: ${tokenStatus(name)}\n`)
  }
  return 0
}

/**
 * `hyp remote remove <name>`: drop the target from config + its stored token.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runRemoteRemove(argv, ctx) {
  const name = positionals(argv)[0]
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
