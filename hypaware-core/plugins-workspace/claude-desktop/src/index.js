// @ts-check

import fs from 'node:fs'

import { CLAUDE_DESKTOP_CONFIG_SECTION, validateClaudeDesktopConfig } from './config.js'
import {
  DEFAULT_BUNDLE_ID,
  DEFAULT_MODELS,
  buildManagedProfile,
  renderManagedPreferencesPlist,
  resolveGatewayBaseUrl,
} from './profile.js'

/**
 * @import { PluginActivationContext, CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from '../../claude-account/src/types.js'
 * @import { ProfileInputs } from './types.js'
 */

export const PLUGIN_NAME = '@hypaware/claude-desktop'

/**
 * Side-effect-free config-section export so the kernel apply path can
 * validate this plugin's block before activation.
 *
 * @type {{ section: string, validate: typeof validateClaudeDesktopConfig }}
 */
export const configSection = {
  section: CLAUDE_DESKTOP_CONFIG_SECTION,
  validate: validateClaudeDesktopConfig,
}

/**
 * Activate `@hypaware/claude-desktop`.
 *
 * Desktop is deliberately not a `contributes.client`: the LLP 0044
 * attach-on-join loop requires a reversible settings-file write and
 * Desktop has no writable settings file. The adapter's whole surface
 * is rendering the org-managed profile an MDM distributes.
 *
 * @ref LLP 0115#no-attach-on-join [implements]: explicit render commands instead of an attach probe
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CLAUDE_DESKTOP_CONFIG_SECTION,
    validate: validateClaudeDesktopConfig,
  })

  // The profile is meaningless without a local gateway to point at;
  // requiring the capability makes that dependency loud at activation.
  ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')

  /** @type {AnthropicCredentialCapability} */
  const credential = ctx.requireCapability('hypaware.anthropic-credential', '^1.0.0')

  const sectionConfig = /** @type {Record<string, unknown>} */ (ctx.config ?? {})

  ctx.commands.register({
    name: 'claude-desktop profile',
    plugin: PLUGIN_NAME,
    summary: 'Render the managed 3P-inference profile for Claude Desktop',
    usage: 'hyp claude-desktop profile [--plist] [--out <path>]',
    help: 'Prints the managed third-party-inference payload (JSON by default, a managed-preferences '
      + 'plist dict with --plist) for MDM distribution. The payload carries no secret: the credential '
      + 'stays behind the claude-account helper command.',
    run: async (argv, cmdCtx) => runProfile(argv, cmdCtx, sectionConfig, credential),
  })

  ctx.commands.register({
    name: 'claude-desktop status',
    plugin: PLUGIN_NAME,
    summary: 'Show the resolved Desktop profile inputs (endpoint, mode, helper)',
    usage: 'hyp claude-desktop status',
    run: async (argv, cmdCtx) => runStatus(cmdCtx, sectionConfig, credential),
  })

  ctx.log.info('claude-desktop activated', { credential_mode: credential.mode })
}

/**
 * @param {Record<string, unknown>} sectionConfig
 * @param {AnthropicCredentialCapability} credential
 * @param {CommandRunContext} cmdCtx
 * @returns {ProfileInputs}
 */
function resolveInputs(sectionConfig, credential, cmdCtx) {
  const models = Array.isArray(sectionConfig.models)
    ? /** @type {string[]} */ (sectionConfig.models)
    : [...DEFAULT_MODELS]
  const helperPath = typeof sectionConfig.helper_path === 'string' && sectionConfig.helper_path.length > 0
    ? sectionConfig.helper_path
    : defaultHelperPath()
  const bundleId = typeof sectionConfig.bundle_id === 'string' && sectionConfig.bundle_id.length > 0
    ? sectionConfig.bundle_id
    : DEFAULT_BUNDLE_ID
  return {
    baseUrl: resolveGatewayBaseUrl({ hypConfig: cmdCtx.config, sectionConfig }),
    // An org key presents under the x-api-key scheme; a subscription
    // bearer rides `bearer` plus the helper-supplied beta header.
    authScheme: credential.mode === 'org_key' ? 'x-api-key' : 'bearer',
    models,
    helperPath,
    helperArgs: [...credential.helperCommandArgs],
    bundleId,
  }
}

/**
 * The helper must be an absolute executable path: Desktop runs it
 * outside any shell profile, so `hyp` on PATH is not a given. Default
 * to the entry script of the running CLI, overridable via
 * `claude_desktop.helper_path`.
 *
 * @returns {string}
 */
function defaultHelperPath() {
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    try {
      return fs.realpathSync(entry)
    } catch {
      return entry
    }
  }
  return 'hyp'
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @param {Record<string, unknown>} sectionConfig
 * @param {AnthropicCredentialCapability} credential
 * @returns {Promise<number>}
 */
async function runProfile(argv, cmdCtx, sectionConfig, credential) {
  const wantPlist = argv.includes('--plist')
  const outIndex = argv.indexOf('--out')
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined
  if (outIndex >= 0 && !outPath) {
    cmdCtx.stderr.write('claude-desktop profile: --out requires a path\n')
    return 1
  }
  try {
    const inputs = resolveInputs(sectionConfig, credential, cmdCtx)
    const profile = buildManagedProfile(inputs)
    const rendered = wantPlist
      ? renderManagedPreferencesPlist(profile)
      : `${JSON.stringify(profile, null, 2)}\n`
    if (outPath) {
      fs.writeFileSync(outPath, rendered)
      cmdCtx.stdout.write(`wrote ${wantPlist ? 'plist' : 'json'} profile for ${inputs.bundleId} to ${outPath}\n`)
    } else {
      cmdCtx.stdout.write(rendered)
    }
    return 0
  } catch (err) {
    cmdCtx.stderr.write(`claude-desktop profile: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * @param {CommandRunContext} cmdCtx
 * @param {Record<string, unknown>} sectionConfig
 * @param {AnthropicCredentialCapability} credential
 * @returns {Promise<number>}
 */
async function runStatus(cmdCtx, sectionConfig, credential) {
  try {
    const inputs = resolveInputs(sectionConfig, credential, cmdCtx)
    cmdCtx.stdout.write(`endpoint: ${inputs.baseUrl}\n`)
    cmdCtx.stdout.write(`credential mode: ${credential.mode} (scheme ${inputs.authScheme})\n`)
    cmdCtx.stdout.write(`helper: ${inputs.helperPath} ${inputs.helperArgs.join(' ')}\n`)
    cmdCtx.stdout.write(`models: ${inputs.models.join(', ')}\n`)
    cmdCtx.stdout.write(`bundle id: ${inputs.bundleId}\n`)
    cmdCtx.stdout.write("credential state: see 'hyp claude-account status'\n")
    return 0
  } catch (err) {
    cmdCtx.stderr.write(`claude-desktop status: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
