// @ts-check

import os from 'node:os'

import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { OPENCLAW_CONFIG_SECTION, validateOpenclawConfig } from './config.js'
import { attach, defaultSettingsPath } from './settings.js'
import { anthropicUpstreamPreset, createOpenclawExchangeProjector } from './projector.js'

/**
 * @import { AiGatewayCapability, AiGatewayClientAttachContext, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/openclaw'
const CLIENT_NAME = 'openclaw'
const UPSTREAM_NAME = 'anthropic'

/**
 * The plugin's `config_sections` validator, surfaced as a side-effect-free
 * export so the kernel apply path can validate this plugin's `config` block
 * (the `attach` policy) *before* the plugin is ever activated (e.g. a
 * central config that first introduces `@hypaware/openclaw`). It is the
 * same registration `activate()` hands `ctx.configRegistry.registerSection`;
 * importing this module never runs `activate()`, so discovery is safe.
 *
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: the plugin owns + exposes its own config validator
 * @type {{ section: string, validate: typeof validateOpenclawConfig }}
 */
export const configSection = { section: OPENCLAW_CONFIG_SECTION, validate: validateOpenclawConfig }

/**
 * Activate the `@hypaware/openclaw` adapter plugin.
 *
 * Resolves the `hypaware.ai-gateway@^2.0.0` capability, registers the
 * Anthropic upstream preset and the header-gated OpenClaw exchange
 * projector, and wires `attach()` against `~/.openclaw/openclaw.json`.
 *
 * `attach()` emits a `client.attach` span tagged with `hyp_plugin`,
 * `client_name`, `status`, and `restored=true|false`. The reversing
 * detach is the single core disk-driven undo (LLP 0045 Part 3, `json_path`
 * format), not a per-adapter hook. No skills ship in v1
 * (`skill_dir` is declared in the manifest for the follow-up).
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements]: adapter requires the ai-gateway capability; registers client + upstream preset
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: OPENCLAW_CONFIG_SECTION,
    validate: validateOpenclawConfig,
  })

  /** @type {AiGatewayCapability} */
  const gateway = ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')

  const upstreamPreset = anthropicUpstreamPreset()
  if (upstreamPreset.name !== UPSTREAM_NAME) {
    throw new Error(`@hypaware/openclaw: unexpected upstream preset name ${upstreamPreset.name}`)
  }
  // The Claude plugin may or may not be active, and the gateway API
  // exposes no has/list for presets: registerUpstreamPreset() is a
  // last-write-wins Map.set keyed on the preset name. Registering
  // unconditionally is therefore exactly "register iff not already
  // present": both plugins contribute the identical `anthropic` preset,
  // so whichever registers last changes nothing.
  // @ref LLP 0109#gateway-capture [implements]: registers the anthropic upstream preset itself iff not already present
  gateway.registerUpstreamPreset(upstreamPreset)

  gateway.registerExchangeProjector(createOpenclawExchangeProjector())

  const logger = getLogger('plugin.openclaw')

  gateway.registerClient({
    name: CLIENT_NAME,
    defaultUpstream: UPSTREAM_NAME,
    /** @param {AiGatewayClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const homeDir = ctx.env.HOME ?? os.homedir()
      const settingsPath = defaultSettingsPath(ctx.env, homeDir)

      return withSpan(
        'client.attach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.attach',
          client_name: CLIENT_NAME,
          hyp_client: CLIENT_NAME,
          dry_run: attachCtx.dryRun === true,
        },
        async (span) => {
          try {
            const result = await attach({
              endpoint: attachCtx.endpoint,
              stdout: attachCtx.stdout,
              stderr: attachCtx.stderr,
              dryRun: attachCtx.dryRun,
              json: attachCtx.json,
              env: ctx.env,
              homeDir,
              version: ctx.plugin.version,
              settingsPath,
            })
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            if (!attachCtx.dryRun) {
              logger.info('client.attach.write', {
                hyp_plugin: PLUGIN_NAME,
                hyp_client: CLIENT_NAME,
                settings_path: result.settingsPath,
                action: result.action,
                changed: result.changed === true,
              })
            }
          } catch (err) {
            span.setAttribute('status', 'failed')
            span.setAttribute('restored', false)
            throw err
          }
        },
        { component: 'plugin.openclaw' }
      )
    },
  })
}
