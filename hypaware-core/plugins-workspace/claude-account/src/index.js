// @ts-check

import readline from 'node:readline/promises'

import { CLAUDE_ACCOUNT_CONFIG_SECTION, resolveMode, validateClaudeAccountConfig } from './config.js'
import { resolveCredential } from './credential.js'
import {
  buildAuthorizeUrl,
  createAuthorizationAttempt,
  exchangeAuthorizationCode,
  parsePastedAuthorization,
} from './oauth.js'
import {
  clearStoredCredential,
  credentialFilePath,
  readStoredCredential,
  tokenFingerprint,
  withCredentialLock,
  writeStoredCredential,
} from './store.js'

/**
 * @import { PluginActivationContext, CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from './types.js'
 */

export const PLUGIN_NAME = '@hypaware/claude-account'

/** Capability name consumers (the Desktop profile renderer) require. */
export const CREDENTIAL_CAPABILITY = 'hypaware.anthropic-credential'

/**
 * Argv tail that, appended to the `hyp` binary, forms the credential
 * helper command line Desktop's managed profile points at.
 */
export const HELPER_COMMAND_ARGS = Object.freeze(['claude-account', 'credential'])

/**
 * Side-effect-free config-section export so the kernel apply path can
 * validate this plugin's block before the plugin is ever activated.
 *
 * @type {{ section: string, validate: typeof validateClaudeAccountConfig }}
 */
export const configSection = {
  section: CLAUDE_ACCOUNT_CONFIG_SECTION,
  validate: validateClaudeAccountConfig,
}

/**
 * Activate `@hypaware/claude-account`: the single owner of the
 * Anthropic credential for clients that cannot hold their own.
 *
 * @ref LLP 0117#credential-plugin [implements]: one owner for provisioning, storage, refresh, and the helper surface
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CLAUDE_ACCOUNT_CONFIG_SECTION,
    validate: validateClaudeAccountConfig,
  })

  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const mode = resolveMode(config)
  const stateDir = ctx.paths.stateDir

  /** @type {AnthropicCredentialCapability} */
  const capability = {
    mode,
    helperCommandArgs: [...HELPER_COMMAND_ARGS],
  }
  ctx.provideCapability(CREDENTIAL_CAPABILITY, '1.0.0', capability)

  ctx.commands.register({
    name: 'claude-account credential',
    plugin: PLUGIN_NAME,
    summary: 'Print the resolved Anthropic credential (Desktop helper contract)',
    usage: 'hyp claude-account credential',
    help: 'Prints a single JSON object { token, headers, ttlSec } to stdout and nothing else. '
      + 'This is the helper command the Claude Desktop managed profile invokes; diagnostics go to stderr.',
    run: async (argv, cmdCtx) => runCredential(cmdCtx, config, stateDir),
  })

  ctx.commands.register({
    name: 'claude-account login',
    plugin: PLUGIN_NAME,
    summary: 'Sign in with your Claude account (subscription mode)',
    usage: 'hyp claude-account login',
    run: async (argv, cmdCtx) => runLogin(cmdCtx, mode, stateDir),
  })

  ctx.commands.register({
    name: 'claude-account logout',
    plugin: PLUGIN_NAME,
    summary: 'Forget the stored subscription credential',
    usage: 'hyp claude-account logout',
    run: async (argv, cmdCtx) => runLogout(cmdCtx, stateDir),
  })

  ctx.commands.register({
    name: 'claude-account status',
    plugin: PLUGIN_NAME,
    summary: 'Show credential mode and sign-in state',
    usage: 'hyp claude-account status',
    run: async (argv, cmdCtx) => runStatus(cmdCtx, config, mode, stateDir),
  })

  ctx.log.info('claude-account activated', { mode })
}

/**
 * The stdout of this command is a secret consumed verbatim by Desktop:
 * exactly one JSON line on success, nothing on failure.
 *
 * @ref LLP 0116#helper-contract [constrained-by]: print ONLY the credential to stdout; failures exit nonzero with an empty stdout
 * @param {CommandRunContext} cmdCtx
 * @param {Record<string, unknown>} config
 * @param {string} stateDir
 * @returns {Promise<number>}
 */
async function runCredential(cmdCtx, config, stateDir) {
  try {
    const credential = await resolveCredential({ config, env: cmdCtx.env, stateDir })
    cmdCtx.stdout.write(`${JSON.stringify(credential)}\n`)
    return 0
  } catch (err) {
    cmdCtx.stderr.write(`claude-account credential: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * @param {CommandRunContext} cmdCtx
 * @param {'org_key' | 'subscription'} mode
 * @param {string} stateDir
 * @returns {Promise<number>}
 */
async function runLogin(cmdCtx, mode, stateDir) {
  if (mode === 'org_key') {
    cmdCtx.stderr.write('claude-account login: this fleet uses org_key mode; no sign-in is needed\n')
    return 1
  }
  if (!cmdCtx.stdin) {
    cmdCtx.stderr.write('claude-account login: needs an interactive terminal\n')
    return 1
  }
  const attempt = createAuthorizationAttempt()
  const url = buildAuthorizeUrl(attempt)
  cmdCtx.stdout.write('Sign in with your Claude account.\n\n')
  cmdCtx.stdout.write(`Open this URL in your browser:\n\n  ${url}\n\n`)
  cmdCtx.stdout.write('After authorizing, the page shows a code. Paste it below.\n')

  const rl = readline.createInterface({ input: cmdCtx.stdin, output: cmdCtx.stdout })
  try {
    const pasted = await rl.question('Code: ')
    const { code, state } = parsePastedAuthorization(pasted)
    const record = await exchangeAuthorizationCode({ code, state, attempt })
    const filePath = credentialFilePath(stateDir)
    await withCredentialLock(filePath, async () => {
      writeStoredCredential(filePath, record)
    })
    const expires = new Date(record.expires_at * 1000).toISOString()
    cmdCtx.stdout.write(`Signed in (token ${tokenFingerprint(record.access_token)}, expires ${expires}).\n`)
    return 0
  } catch (err) {
    cmdCtx.stderr.write(`claude-account login: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    rl.close()
  }
}

/**
 * @param {CommandRunContext} cmdCtx
 * @param {string} stateDir
 * @returns {Promise<number>}
 */
async function runLogout(cmdCtx, stateDir) {
  const filePath = credentialFilePath(stateDir)
  await withCredentialLock(filePath, async () => {
    clearStoredCredential(filePath)
  })
  cmdCtx.stdout.write('Signed out; stored credential removed.\n')
  return 0
}

/**
 * @param {CommandRunContext} cmdCtx
 * @param {Record<string, unknown>} config
 * @param {'org_key' | 'subscription'} mode
 * @param {string} stateDir
 * @returns {Promise<number>}
 */
async function runStatus(cmdCtx, config, mode, stateDir) {
  cmdCtx.stdout.write(`mode: ${mode}\n`)
  if (mode === 'org_key') {
    const envName = typeof config.api_key_env === 'string' ? config.api_key_env : undefined
    if (typeof config.api_key === 'string' && config.api_key.length > 0) {
      cmdCtx.stdout.write(`org key: configured (${tokenFingerprint(config.api_key)})\n`)
    } else if (envName) {
      const set = typeof cmdCtx.env[envName] === 'string' && cmdCtx.env[envName].length > 0
      cmdCtx.stdout.write(`org key: from $${envName} (${set ? 'set' : 'NOT SET'})\n`)
      if (!set) return 1
    } else {
      cmdCtx.stdout.write('org key: NOT CONFIGURED (set claude_account.api_key or api_key_env)\n')
      return 1
    }
    return 0
  }
  /** @type {ReturnType<typeof readStoredCredential>} */
  let record
  try {
    record = readStoredCredential(credentialFilePath(stateDir))
  } catch (err) {
    cmdCtx.stderr.write(`claude-account status: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (!record) {
    cmdCtx.stdout.write("signed in: no (run 'hyp claude-account login')\n")
    return 1
  }
  const expires = new Date(record.expires_at * 1000).toISOString()
  cmdCtx.stdout.write(`signed in: yes (token ${tokenFingerprint(record.access_token)}, expires ${expires})\n`)
  return 0
}
