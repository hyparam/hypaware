// @ts-check

import os from 'node:os'

import { readObservabilityEnv } from '../../../../src/core/observability/index.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { createOpenclawAttach } from './attach.js'
import { createOpenclawBackfillProvider } from './backfill.js'
import { OPENCLAW_CONFIG_SECTION, validateOpenclawConfig } from './config.js'
import { anthropicUpstreamPreset, createOpenclawExchangeProjector, openaiUpstreamPreset } from './projector.js'
import { createOpenclawSettlementEnricher } from './settle.js'

/**
 * @import { AiGatewayCapability, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/openclaw'
const CLIENT_NAME = 'openclaw'
const UPSTREAM_NAME = 'anthropic'
const OPENAI_UPSTREAM_NAME = 'openai'

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
 * Anthropic upstream preset, the header-gated OpenClaw exchange projector,
 * the flush-time settlement enricher that upgrades the projector's
 * fallback-identity rows to the session file's native identity, and the
 * session-transcript backfill provider, and registers the `openclaw`
 * client so `hyp attach openclaw` / `hyp detach openclaw` / `hyp clients
 * openclaw` keep resolving it.
 *
 * Routing is a HypAware-side settings write again (LLP 0168/0169 reverse
 * LLP 0152's steering-plugin premise): `attach()` writes the two
 * `models.providers` entries of LLP 0167#override-entries into
 * `openclaw.json`. The effect itself lives in `attach.js` so the
 * refuse-then-write ordering is testable without an activation around it;
 * this function only wires it in. The reversal is the single core disk-driven
 * undo (LLP 0045 Part 3), which stays inert until the manifest registers the
 * `json_path` attach probe that drives it.
 *
 * `attach()` emits a `client.attach` span tagged with `hyp_plugin`,
 * `client_name`, `status`, and `restored=false` (create-only, so there is
 * never anything to restore). No skills ship in v1 (`skill_dir` is declared
 * in the manifest for the follow-up).
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements]: adapter requires the ai-gateway capability; registers client + upstream preset
 * @ref LLP 0169#decision [implements]: the attach surface returns, so
 *   gateway.registerClient() carries a real settings write again and the
 *   LLP 0044 attach-on-join loop covers OpenClaw like Claude and Codex.
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

  const openaiPreset = openaiUpstreamPreset()
  if (openaiPreset.name !== OPENAI_UPSTREAM_NAME) {
    throw new Error(`@hypaware/openclaw: unexpected upstream preset name ${openaiPreset.name}`)
  }
  // NOT the same reasoning as the anthropic preset above: Codex's `openai`
  // registration declares no `match()`, so the two copies are not
  // interchangeable and whichever registers last DOES change routing. Both
  // now sit at the default priority 0, so only the steering rung differs.
  // See `openaiUpstreamPreset`'s "KNOWN DIVERGENCE" note.
  // @ref LLP 0161#upstream-presets [implements]: registers the openai upstream preset itself iff not already present, so an OpenClaw-only install still routes steered OpenAI-shaped traffic
  gateway.registerUpstreamPreset(openaiPreset)

  gateway.registerExchangeProjector(createOpenclawExchangeProjector())

  // Flush-time settlement: upgrade the fallback-identity rows the projector
  // emitted (OpenClaw's wire carries no session or message id, LLP 0144) to
  // the session JSONL's native identity, so a later `hyp backfill openclaw`
  // dedupes against them instead of double-importing every turn. It also
  // carries this client's ONLY `.hypignore` seam: live proxy rows capture no
  // cwd, so the session header's cwd is resolved here or nowhere.
  // @ref LLP 0159#decision [implements]: route agreement rides native-identity
  //   settlement, and the header-cwd usage-policy drop rides the same seam.
  //
  // The local-only list lives at the SHARED state root
  // (`readObservabilityEnv(ctx.env).stateDir`), the same path the export and
  // query seams read, NOT the per-plugin `ctx.paths.stateDir` where the file
  // never exists (the same trap the Claude adapter documents).
  gateway.registerSettlementEnricher(
    createOpenclawSettlementEnricher({
      homeDir: ctx.env.HOME ?? os.homedir(),
      env: ctx.env,
      clientName: CLIENT_NAME,
      localOnlyListPath: localOnlyListPath(readObservabilityEnv(ctx.env).stateDir),
    })
  )

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
      env: ctx.env,
      clientName: CLIENT_NAME,
      pluginName: PLUGIN_NAME,
      localOnlyListPath: localOnlyListPath(readObservabilityEnv(ctx.env).stateDir),
    })
  )

  // The registered `attach()` returns `Promise<void>` by the kernel contract,
  // so the effect's `{status}` outcome is dropped here on purpose. Nothing
  // upstream reads it: both callers (`hyp attach`'s router and the
  // reconciler's `perform()`) derive success from "did it throw" plus the
  // one-line JSON the effect writes to `attachCtx.stdout`. Swallowing the
  // value is therefore exactly LLP 0169's join-safety clause in practice - a
  // refusal reaches the user as its own reported failure line and leaves the
  // join standing, instead of throwing through the reconciler.
  const openclawAttach = createOpenclawAttach({
    homeDir: ctx.env.HOME ?? os.homedir(),
    env: ctx.env,
  })

  gateway.registerClient({
    name: CLIENT_NAME,
    defaultUpstream: UPSTREAM_NAME,
    async attach(attachCtx) {
      await openclawAttach.attach(attachCtx)
    },
  })
}
