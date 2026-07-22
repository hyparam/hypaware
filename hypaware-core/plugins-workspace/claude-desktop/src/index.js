// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { CLAUDE_DESKTOP_CONFIG_SECTION, validateClaudeDesktopConfig } from './config.js'
import {
  DEFAULT_BUNDLE_ID,
  DEFAULT_MODELS,
  buildManagedProfile,
  renderCredentialHelperScript,
  renderManagedPreferencesPlist,
  resolveGatewayBaseUrl,
} from './profile.js'

/**
 * @import { PluginActivationContext, CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from '../../claude-account/src/types.js'
 * @import { ProfileInputs } from './types.js'
 */

export const PLUGIN_NAME = '@hypaware/claude-desktop'

/** Basename of the generated credential-helper wrapper under the state dir. */
export const HELPER_BASENAME = 'credential-helper.sh'

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
 * Corrects LLP 0115's "no writable settings file" premise: the live-test
 * findings in LLP 0133 identify the managed-preferences plist
 * (`/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`) as a
 * real local surface, so the manifest now also declares `contributes.client`
 * and `contributes.picker` (LLP 0130) for the `hyp init` wizard's `needs_setup`
 * row. This does not reinstate generic attach-on-join (LLP 0044): the plugin
 * registers no runtime `ctx.clients` adapter, so the generic reconciler's
 * `desired()` (`action_attach.js`) stays inert for `claude-desktop` and the
 * plist is placed only via the explicit `claude-desktop install` command,
 * attended, with its own sudo prompt and idempotent re-run (LLP 0131).
 *
 * @ref LLP 0133#attribution [constrained-by]: the client descriptor and picker row exist for wizard/attach-status plumbing, but captured rows still land under client_name "claude" with entrypoint "claude-desktop-3p"; query and hyp status surfaces key off entrypoint, not this descriptor's name
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
  const stateDir = ctx.paths.stateDir

  ctx.commands.register({
    name: 'claude-desktop profile',
    plugin: PLUGIN_NAME,
    summary: 'Render the managed 3P-inference profile for Claude Desktop',
    usage: 'hyp claude-desktop profile [--plist] [--out <path>]',
    help: 'Prints the managed third-party-inference payload (JSON by default, a managed-preferences '
      + 'plist dict with --plist) for MDM distribution. The payload carries no secret: it references '
      + "the credential wrapper by absolute path. Run 'hyp claude-desktop install-helper' first so the "
      + 'wrapper exists on disk.',
    run: async (argv, cmdCtx) => runProfile(argv, cmdCtx, sectionConfig, credential, stateDir),
  })

  ctx.commands.register({
    name: 'claude-desktop install-helper',
    plugin: PLUGIN_NAME,
    summary: 'Write the no-arg credential wrapper the Desktop profile points at',
    usage: 'hyp claude-desktop install-helper [--path <path>]',
    help: 'Generates the executable wrapper that runs `hyp claude-account credential` with no '
      + 'arguments (Desktop runs the helper with no argv). Writes it under the plugin state dir by '
      + 'default, marked executable, outside any TCC-protected directory.',
    run: async (argv, cmdCtx) => runInstallHelper(argv, cmdCtx, sectionConfig, credential, stateDir),
  })

  ctx.commands.register({
    name: 'claude-desktop status',
    plugin: PLUGIN_NAME,
    summary: 'Show the resolved Desktop profile inputs (endpoint, mode, helper)',
    usage: 'hyp claude-desktop status',
    run: async (argv, cmdCtx) => runStatus(cmdCtx, sectionConfig, credential, stateDir),
  })

  // `claude-desktop install` and `claude-desktop verify` are the picker's
  // `configure_command` and the post-wizard verify hint (LLP 0135, LLP
  // 0133#one-surface). Registered here as stubs so the manifest's
  // `contributes.picker` row is immediately usable by the generic pick and
  // configure phases; T13 replaces these bodies with the real login/helper/
  // residue/plist/restart sequence in `src/install.js` and `src/verify.js`.
  ctx.commands.register({
    name: 'claude-desktop install',
    plugin: PLUGIN_NAME,
    summary: 'Configure Claude Desktop end to end: login, helper write, residue clear, managed plist write, restart prompt',
    usage: 'hyp claude-desktop install [--print-commands]',
    help: 'Not yet implemented (tracked in a follow-up task). Will run the credential login chain '
      + '(LLP 0117), write the credential helper (LLP 0116), back up and clear stale Claude-3p dialog '
      + 'residue, write the managed-preferences plist via an inline sudo prompt (LLP 0133#solo-sudo), '
      + 'and prompt for a Desktop restart. --print-commands will print the privileged commands without '
      + 'running them.',
    run: async (argv, cmdCtx) => runInstallStub(argv, cmdCtx),
  })

  ctx.commands.register({
    name: 'claude-desktop verify',
    plugin: PLUGIN_NAME,
    summary: 'Verify the Desktop plist install and print the in-app capture-check hint',
    usage: 'hyp claude-desktop verify',
    help: 'Not yet implemented (tracked in a follow-up task). Will check the automatic half (plist '
      + 'present, residue cleared) into the exit code and print the in-app half (send a message, '
      + 'confirm capture) as a hint only, never a blocking wizard step (LLP 0131#verify-is-a-hint).',
    run: async (argv, cmdCtx) => runVerifyStub(argv, cmdCtx),
  })

  ctx.log.info('claude-desktop activated', { credential_mode: credential.mode })
}

/**
 * Stub for `claude-desktop install`. Registers the command and its
 * `hyp init` picker wiring now; the real login/helper/residue/plist/
 * restart sequence lands in a follow-up task's `src/install.js`.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @returns {Promise<number>}
 */
async function runInstallStub(argv, cmdCtx) {
  cmdCtx.stderr.write('claude-desktop install: not yet implemented\n')
  return 1
}

/**
 * Stub for `claude-desktop verify`. The real two-tier verify (automatic
 * plist/residue check plus a printed in-app hint) lands in a follow-up
 * task's `src/verify.js`.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @returns {Promise<number>}
 */
async function runVerifyStub(argv, cmdCtx) {
  cmdCtx.stderr.write('claude-desktop verify: not yet implemented\n')
  return 1
}

/**
 * Absolute path of the `hyp` executable to embed in the wrapper.
 * Desktop runs the wrapper outside any shell profile, so a bare `hyp`
 * on PATH is not a given; resolve the running CLI's entry script.
 *
 * @returns {string}
 */
function resolveHypBin() {
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
 * Resolve the wrapper's absolute path: `claude_desktop.helper_path`
 * override, else `<stateDir>/credential-helper.sh`.
 *
 * @param {Record<string, unknown>} sectionConfig
 * @param {string} stateDir
 * @returns {string}
 */
function resolveHelperPath(sectionConfig, stateDir) {
  const override = sectionConfig.helper_path
  if (typeof override === 'string' && override.length > 0) return override
  return path.join(stateDir, HELPER_BASENAME)
}

/**
 * @param {Record<string, unknown>} sectionConfig
 * @param {AnthropicCredentialCapability} credential
 * @param {CommandRunContext} cmdCtx
 * @param {string} stateDir
 * @returns {ProfileInputs}
 */
function resolveInputs(sectionConfig, credential, cmdCtx, stateDir) {
  const models = Array.isArray(sectionConfig.models)
    ? /** @type {string[]} */ (sectionConfig.models)
    : [...DEFAULT_MODELS]
  const bundleId = typeof sectionConfig.bundle_id === 'string' && sectionConfig.bundle_id.length > 0
    ? sectionConfig.bundle_id
    : DEFAULT_BUNDLE_ID
  return {
    baseUrl: resolveGatewayBaseUrl({ hypConfig: cmdCtx.config, sectionConfig }),
    // An org key presents under the x-api-key scheme; a subscription
    // bearer rides `bearer` plus the helper-supplied beta header.
    authScheme: credential.mode === 'org_key' ? 'x-api-key' : 'bearer',
    models,
    helperPath: resolveHelperPath(sectionConfig, stateDir),
    bundleId,
  }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @param {Record<string, unknown>} sectionConfig
 * @param {AnthropicCredentialCapability} credential
 * @param {string} stateDir
 * @returns {Promise<number>}
 */
async function runInstallHelper(argv, cmdCtx, sectionConfig, credential, stateDir) {
  const pathIndex = argv.indexOf('--path')
  if (pathIndex >= 0 && !argv[pathIndex + 1]) {
    cmdCtx.stderr.write('claude-desktop install-helper: --path requires a value\n')
    return 1
  }
  const helperPath = pathIndex >= 0
    ? /** @type {string} */ (argv[pathIndex + 1])
    : resolveHelperPath(sectionConfig, stateDir)
  try {
    const script = renderCredentialHelperScript({
      nodeBin: process.execPath,
      hypBin: resolveHypBin(),
      args: [...credential.helperCommandArgs],
      env: cmdCtx.env,
    })
    fs.mkdirSync(path.dirname(helperPath), { recursive: true })
    fs.writeFileSync(helperPath, script, { mode: 0o755 })
    fs.chmodSync(helperPath, 0o755)
    cmdCtx.stdout.write(`wrote credential wrapper to ${helperPath}\n`)
    cmdCtx.stdout.write("point the Desktop profile's inferenceCredentialHelper at this path\n")
    return 0
  } catch (err) {
    cmdCtx.stderr.write(`claude-desktop install-helper: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @param {Record<string, unknown>} sectionConfig
 * @param {AnthropicCredentialCapability} credential
 * @param {string} stateDir
 * @returns {Promise<number>}
 */
async function runProfile(argv, cmdCtx, sectionConfig, credential, stateDir) {
  const wantPlist = argv.includes('--plist')
  const outIndex = argv.indexOf('--out')
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined
  if (outIndex >= 0 && !outPath) {
    cmdCtx.stderr.write('claude-desktop profile: --out requires a path\n')
    return 1
  }
  try {
    const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
    if (!fs.existsSync(inputs.helperPath)) {
      cmdCtx.stderr.write(
        `claude-desktop profile: warning: credential wrapper ${inputs.helperPath} does not exist yet; `
        + "run 'hyp claude-desktop install-helper'\n",
      )
    }
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
 * @param {string} stateDir
 * @returns {Promise<number>}
 */
async function runStatus(cmdCtx, sectionConfig, credential, stateDir) {
  try {
    const inputs = resolveInputs(sectionConfig, credential, cmdCtx, stateDir)
    const helperExists = fs.existsSync(inputs.helperPath)
    cmdCtx.stdout.write(`endpoint: ${inputs.baseUrl}\n`)
    cmdCtx.stdout.write(`credential mode: ${credential.mode} (scheme ${inputs.authScheme})\n`)
    cmdCtx.stdout.write(`helper: ${inputs.helperPath} (${helperExists ? 'installed' : 'NOT installed'})\n`)
    cmdCtx.stdout.write(`models: ${inputs.models.join(', ')}\n`)
    cmdCtx.stdout.write(`bundle id: ${inputs.bundleId}\n`)
    cmdCtx.stdout.write("credential state: see 'hyp claude-account status'\n")
    return helperExists ? 0 : 1
  } catch (err) {
    cmdCtx.stderr.write(`claude-desktop status: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
