// @ts-check

import os from 'node:os'

import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { createOpenclawBackfillProvider } from './backfill.js'
import { OPENCLAW_CONFIG_SECTION, validateOpenclawConfig } from './config.js'
import { anthropicUpstreamPreset, createOpenclawExchangeProjector } from './projector.js'

/**
 * @import { AiGatewayCapability, AiGatewayClientAttachContext, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/openclaw'
const CLIENT_NAME = 'openclaw'
const UPSTREAM_NAME = 'anthropic'
const STEERING_PLUGIN_NAME = '@hypaware/openclaw-steering-plugin'

/**
 * Human-readable message `attach()` prints/logs: routing is owned by the
 * OpenClaw-side steering plugin, installed through OpenClaw's own plugin
 * manager, not by a HypAware-side settings write.
 */
const ROUTING_OWNED_BY_STEERING_PLUGIN_MESSAGE =
  `OpenClaw routing is owned by the '${STEERING_PLUGIN_NAME}' npm package, ` +
  `installed on the OpenClaw side (run 'openclaw plugins install ${STEERING_PLUGIN_NAME}'). ` +
  'This adapter no longer writes to openclaw.json; there is nothing for hyp attach to do here.'

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
 * projector, registers the session-transcript backfill provider, and
 * registers the `openclaw` client so `hyp attach openclaw` / `hyp detach
 * openclaw` / `hyp clients openclaw` keep resolving it.
 *
 * Routing is no longer a HypAware-side settings write (LLP 0152): OpenClaw
 * traffic is steered by the `@hypaware/openclaw-steering-plugin` npm
 * package the user installs on the OpenClaw side. `attach()` is therefore
 * an honest no-op: it writes nothing and only reports that routing lives
 * elsewhere. The manifest declares no `attach_probe` (R7), so the generic
 * attach-on-join reconciler already skips this client
 * (`if (!descriptor.attachProbe) continue`); this no-op only runs for the
 * manual `hyp attach openclaw` command, which resolves `getClient()`
 * directly and does not gate on `attachProbe`.
 *
 * `attach()` still emits a `client.attach` span tagged with `hyp_plugin`,
 * `client_name`, `status`, and `restored=false` (there is nothing to
 * restore). The reversing detach is the single core disk-driven undo
 * (LLP 0045 Part 3), which is likewise an honest no-op here since the
 * descriptor carries no `attach_probe`. No skills ship in v1 (`skill_dir`
 * is declared in the manifest for the follow-up).
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements]: adapter requires the ai-gateway capability; registers client + upstream preset
 * @ref LLP 0161#activate-and-client-registration [implements]: keeps
 *   gateway.registerClient() registered with an honest no-op attach() so
 *   the manual attach/detach/clients commands keep resolving 'openclaw',
 *   even though routing moved to the OpenClaw-side steering plugin.
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

  // Backfill provider: imports the OpenClaw session transcripts the gateway
  // never saw (history written before the steering plugin was installed, or
  // outside the proxy) into `ai_gateway_messages` via `hyp backfill openclaw`.
  // Registered imperatively at activation, the house pattern the Codex adapter
  // already follows, with the `backfill` policy (`on_join`, `window_days`)
  // declared and validated in this plugin's own config section above.
  // @ref LLP 0161#backfill-provider [implements]: registered via
  //   ctx.backfills.register(...) in activate(), mirroring Codex's placement
  // @ref LLP 0103 [implements]: thread the machine-local usage-policy list into
  //   the backfill gate so a `--private` (`ignore`) dir is skipped here too,
  //   never re-importing sessions live capture already dropped. The list lives
  //   at the SHARED state root, not the per-plugin `ctx.paths.stateDir` where
  //   the file never exists.
  ctx.backfills.register(
    createOpenclawBackfillProvider({
      homeDir: ctx.env.HOME ?? os.homedir(),
      clientName: CLIENT_NAME,
      pluginName: PLUGIN_NAME,
      localOnlyListPath: localOnlyListPath(readObservabilityEnv(ctx.env).stateDir),
    })
  )

  const logger = getLogger('plugin.openclaw')

  // @ref LLP 0143#decision [constrained-by]: no attach_probe means detach's
  // core disk-driven undo is already an honest no-op ({ changed: false });
  // this registerClient() keeps attach() registered (a decorative-marker
  // problem LLP 0143 warns against does not apply here, since attach()
  // never claims to have written anything) purely so the manual
  // attach/detach/clients commands keep resolving 'openclaw' by name.
  gateway.registerClient({
    name: CLIENT_NAME,
    defaultUpstream: UPSTREAM_NAME,
    /** @param {AiGatewayClientAttachContext} attachCtx */
    async attach(attachCtx) {
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
          span.setAttribute('status', 'ok')
          span.setAttribute('restored', false)
          span.setAttribute('routing_owned_by', STEERING_PLUGIN_NAME)
          if (attachCtx.json) {
            attachCtx.stdout.write(
              JSON.stringify({
                status: 'ok',
                action: 'attach',
                client: CLIENT_NAME,
                dry_run: attachCtx.dryRun === true,
                changed: false,
                routing_owned_by: STEERING_PLUGIN_NAME,
                message: ROUTING_OWNED_BY_STEERING_PLUGIN_MESSAGE,
              }) + '\n'
            )
          } else {
            attachCtx.stdout.write(`${ROUTING_OWNED_BY_STEERING_PLUGIN_MESSAGE}\n`)
          }
          logger.info('client.attach.noop', {
            hyp_plugin: PLUGIN_NAME,
            hyp_client: CLIENT_NAME,
            routing_owned_by: STEERING_PLUGIN_NAME,
            dry_run: attachCtx.dryRun === true,
          })
        },
        { component: 'plugin.openclaw' }
      )
    },
  })
}
