// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { CLAUDE_DESKTOP_CONFIG_SECTION, validateClaudeDesktopConfig } from './config.js'
import { resolveHelperPath, resolveHypBin, resolveInputs } from './inputs.js'
import {
  buildManagedProfile,
  renderCredentialHelperScript,
  renderManagedPreferencesPlist,
} from './profile.js'
import { runInstall } from './install.js'
import { runVerify } from './verify.js'

/**
 * @import { PluginActivationContext, CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from '../../claude-account/src/types.js'
 */

// Re-exported for existing/external callers that imported the wrapper's
// basename off this module before it moved to inputs.js.
export { HELPER_BASENAME } from './inputs.js'

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
 * Corrects LLP 0115's "no writable settings file" premise: the live-test
 * findings in LLP 0133 identify the managed-preferences plist
 * (`/Library/Managed Preferences/com.anthropic.claudefordesktop.plist`) as a
 * real local surface, so the manifest also declares `contributes.client`
 * (for `skill_dir`/`agent_dir`) and `contributes.picker` (LLP 0130). That
 * picker row is a transcript-only choice (LLP 0358): onboarding composes the
 * scheduled Claude reader and this plugin's ownership declaration, but never
 * runs the sudo'd plist path below. This does not reinstate generic
 * attach-on-join (LLP 0044): the plugin registers no runtime `ctx.clients`
 * adapter, so the generic reconciler's `desired()` (`action_attach.js`) stays
 * inert for `claude-desktop` and the plist is placed only via the explicit
 * `claude-desktop install` command, attended, with its own sudo prompt and
 * idempotent re-run (LLP 0131).
 *
 * That surface being real does *not* make it core-reversible, so the client
 * descriptor deliberately carries **no `attach_probe`**: the plist is XML at
 * an absolute root-owned system path and holds no self-describing undo
 * record, none of which the core probe/undo (`json`/`toml`) can
 * read or replay. Its state surface is `claude-desktop verify` and its undo is
 * removing the plist with sudo, not `hyp detach` (#444).
 *
 * @ref LLP 0358#onboarding [implements]: activation and transcript ownership need no credential; legacy profile commands resolve that capability only when explicitly configured
 * @ref LLP 0115#no-attach-on-join [constrained-by]: no `attach_probe` - the LLP 0044 loop needs a reversible settings-file write, and the managed plist is not one; the probe that was declared here answered "not attached" over a $HOME-re-anchored path that never existed, and would have thrown MALFORMED_JSON over the real XML plist the moment that path was corrected (LLP 0135#no-probe)
 * @ref LLP 0133#attribution [constrained-by]: optional managed-profile traffic still lands under client_name "claude" with entrypoint "claude-desktop-3p"; scheduled transcript rows are reattributed to "claude-desktop" through the ownership declaration per LLP 0358
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

  // The credential belongs only to the optional managed-profile experiment.
  // A normal Desktop selection intentionally omits its provider, so plugin
  // activation and scheduled transcript ownership must survive its absence.
  // The fallback keeps older activation harnesses that expose only
  // `requireCapability` working while the real kernel uses `capabilities.has`.
  /** @returns {AnthropicCredentialCapability | undefined} */
  const resolveCredential = () => ctx.capabilities && typeof ctx.capabilities.has === 'function'
    ? (ctx.capabilities.has('hypaware.anthropic-credential', '^1.0.0')
        ? ctx.requireCapability('hypaware.anthropic-credential', '^1.0.0')
        : undefined)
    : ctx.requireCapability('hypaware.anthropic-credential', '^1.0.0')

  const sectionConfig = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const stateDir = ctx.paths.stateDir

  // The group has no bare command, so without this its `--help` opens on a
  // naked `usage:` line and never says what the subcommands are for (#1005).
  // @ref LLP 0214#d2 [implements]: a plugin group with no bare command keeps its voice in the group registry
  ctx.commands.registerGroup({
    name: 'client claude-desktop',
    plugin: PLUGIN_NAME,
    summary: 'Set up Claude Desktop capture on macOS',
    help: [
      'Claude Desktop delegates inference to its embedded CLI, so it is',
      'captured by pointing it at the local gateway through the org-managed',
      'third-party-inference profile. These subcommands render that profile,',
      'write the credential helper it names, install it, and verify it.',
      '',
      'Start with install, which walks the whole sequence; the rest exist for',
      'MDM distribution and for checking what a machine ended up with.',
    ].join('\n'),
  })

  ctx.commands.register({
    name: 'client claude-desktop profile',
    aliases: ['claude-desktop profile'],
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Render the managed 3P-inference profile for Claude Desktop',
    usage: 'hyp client claude-desktop profile [--plist] [--out <path>]',
    help: 'Prints the managed third-party-inference payload (JSON by default, a managed-preferences '
      + 'plist dict with --plist) for MDM distribution. The payload carries no secret: it references '
      + "the credential wrapper by absolute path. Run 'hyp client claude-desktop install-helper' first so the "
      + 'wrapper exists on disk.',
    run: async (argv, cmdCtx) => {
      const credential = resolveCredential()
      return credential
        ? runProfile(argv, cmdCtx, sectionConfig, credential, stateDir)
        : credentialUnavailable(cmdCtx)
    },
  })

  ctx.commands.register({
    name: 'client claude-desktop install-helper',
    aliases: ['claude-desktop install-helper'],
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Write the no-arg credential wrapper the Desktop profile points at',
    usage: 'hyp client claude-desktop install-helper [--path <path>]',
    help: 'Generates the executable wrapper that runs `hyp claude-account credential` with no '
      + 'arguments (Desktop runs the helper with no argv). Writes it under the plugin state dir by '
      + 'default, marked executable, outside any TCC-protected directory.',
    run: async (argv, cmdCtx) => {
      const credential = resolveCredential()
      return credential
        ? runInstallHelper(argv, cmdCtx, sectionConfig, credential, stateDir)
        : credentialUnavailable(cmdCtx)
    },
  })

  ctx.commands.register({
    name: 'client claude-desktop status',
    aliases: ['claude-desktop status'],
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Show the resolved Desktop profile inputs (endpoint, mode, helper)',
    usage: 'hyp client claude-desktop status',
    help: 'Prints what the profile WOULD be built from: the gateway endpoint, the credential mode '
      + 'and auth scheme, the wrapper path and whether it exists on disk, the advertised models, and '
      + 'the target bundle id. It reads config and disk only, changes nothing, and works on a non-Mac '
      + "admin box. It carries no secret: for sign-in state run 'hyp client claude-account status', "
      + "and for whether the install actually took, run 'hyp client claude-desktop verify' - this command answers "
      + 'what the inputs resolve to, not whether Desktop is configured. Exits nonzero when the '
      + 'credential wrapper is missing, and when the inputs do not resolve at all - an ephemeral '
      + "gateway listen (':0') has no stable port for a profile to point at.",
    run: async (_argv, cmdCtx) => {
      const credential = resolveCredential()
      return credential
        ? runStatus(cmdCtx, sectionConfig, credential, stateDir)
        : credentialUnavailable(cmdCtx)
    },
  })

  // `claude-desktop install` and `claude-desktop verify` are optional legacy
  // live-route controls (LLP 0135, LLP 0133#one-surface). The command bodies live in src/install.js and
  // src/verify.js; this registration just wires the resolved inputs
  // (sectionConfig, the credential capability, stateDir) through.
  ctx.commands.register({
    name: 'client claude-desktop install',
    aliases: ['claude-desktop install'],
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Configure Claude Desktop end to end: explain and confirm, login, helper write, residue clear, managed plist write, restart prompt',
    usage: 'hyp client claude-desktop install [--yes] [--print-commands]',
    help: 'Explains what it will change and asks once, defaulting to yes and naming the browser '
      + 'sign-in a yes may launch (LLP 0139#informed-consent as amended): unlike Claude Code and '
      + 'Codex, Desktop cannot present its own credential through a third-party '
      + 'endpoint, so attaching it makes this machine hold an Anthropic credential. Then runs the '
      + 'credential login chain (LLP 0117), writes the credential helper (LLP 0116), backs '
      + 'up and clears stale Claude-3p dialog residue, writes the managed-preferences plist via an '
      + 'inline sudo prompt (LLP 0133#solo-sudo), and prompts for a Desktop restart. Refuses up front '
      + 'on a non-macOS platform (LLP 0139) or if the effective gateway listen is ephemeral '
      + '(127.0.0.1:0, LLP 0114). Every step re-checks its '
      + 'own already-done state, so a bailed sudo prompt converges on re-run (LLP 0131#idempotent-rerun), '
      + 'and an already-configured machine is not re-prompted. --yes accepts the changes in advance; '
      + '--print-commands prints the privileged commands without running them.',
    run: async (argv, cmdCtx) => {
      const credential = resolveCredential()
      return credential
        ? runInstall(argv, cmdCtx, { sectionConfig, credential, stateDir })
        : credentialUnavailable(cmdCtx)
    },
  })

  ctx.commands.register({
    name: 'client claude-desktop verify',
    aliases: ['claude-desktop verify'],
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Verify the Desktop plist install and print the in-app capture-check hint',
    usage: 'hyp client claude-desktop verify',
    help: 'Checks the automatic half (managed plist present and up to date, dialog residue cleared) '
      + 'and sets the exit code from it. Also prints the in-app half as a hint only (send a message in '
      + 'Claude Desktop, confirm it was captured); that half is never checked automatically and never '
      + 'blocks (LLP 0131#verify-is-a-hint).',
    run: async (argv, cmdCtx) => {
      const credential = resolveCredential()
      return credential
        ? runVerify(argv, cmdCtx, { sectionConfig, credential, stateDir })
        : credentialUnavailable(cmdCtx)
    },
  })

  // No credential_mode here. Dropping the capability from `requires` also
  // dropped the only thing that ordered this plugin after
  // `@hypaware/claude-account`, so an activation-time probe would report
  // 'not_configured' on a machine where the credential is configured but
  // listed later. The commands resolve it when they run, which is the only
  // moment the answer is both needed and settled.
  ctx.log.info('claude-desktop activated', { capture_mode: 'scheduled_transcript' })
}

/**
 * The optional managed-profile commands are not the capture path. Keep their
 * missing dependency local to the invoked command instead of failing plugin
 * activation and disabling transcript ownership.
 *
 * @param {CommandRunContext} cmdCtx
 * @returns {number}
 */
function credentialUnavailable(cmdCtx) {
  cmdCtx.stderr.write(
    'claude-desktop: managed-profile commands require @hypaware/claude-account; '
    + 'scheduled transcript capture does not\n'
  )
  return 1
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
        + "run 'hyp client claude-desktop install-helper'\n",
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
    cmdCtx.stdout.write("credential state: see 'hyp client claude-account status'\n")
    return helperExists ? 0 : 1
  } catch (err) {
    cmdCtx.stderr.write(`claude-desktop status: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
