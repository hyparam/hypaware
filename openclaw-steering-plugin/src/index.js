// `@hypaware/openclaw-steering-plugin` - an OpenClaw-installed plugin, not a
// HypAware kernel plugin. It never calls `ctx.requireCapability` or any
// `PluginActivationContext` method; its only coupling to the HypAware repo
// is the `x-hypaware-upstream` header contract this file writes and
// `@hypaware/openclaw`'s projector reads (LLP 0161#upstream-header).
//
// @ref LLP 0161#package-layout [implements]: a new top-level package,
// sibling to `hypaware-core/` and `src/`, with its own package.json and its
// own OpenClaw-native plugin manifest (`openclaw.plugin.json`), because it
// is an npm package OpenClaw installs, not a relative-import HypAware
// kernel plugin.
//
// OpenClaw's own plugin entry/manifest shape (`definePluginEntry` from
// `openclaw/plugin-sdk/plugin-entry`, the `id`/`name`/`description`/
// `register(api)` fields, `api.registerProvider({ id, catalog: { run } })`,
// `api.on('before_model_resolve', handler)`) is verified against OpenClaw's
// published plugin docs (docs.openclaw.ai/plugins/sdk-entrypoints,
// /plugins/sdk-provider-plugins, /plugins/hooks, /plugins/manifest;
// 2026-07-30), the same way LLP 0157/0161 verified
// `extensions/anthropic/stream-wrappers.ts` and
// `openclaw/plugin-sdk/provider-auth-runtime` against the openclaw repo
// before relying on them. Two residual open items, worth confirming against
// a live OpenClaw install before this plugin ships: the exact field names
// `before_model_resolve`'s `event` argument carries for the candidate's
// resolved `provider`/`api` (the docs state only "the current prompt and
// attachment metadata", not a field list), and whether the hook's return
// value supports a metadata channel beyond `providerOverride`/
// `modelOverride` for carrying `x-hypaware-upstream` (LLP 0161#steering-plugin
// states the hook returns both; the docs page examined here names only the
// two override fields explicitly).

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { resolveApiKeyForProvider } from 'openclaw/plugin-sdk/provider-auth-runtime'

import { resolveGatewayEndpoint } from './gateway_endpoint.js'
import { resolveSteering } from './steering.js'
import { createWarningLedger } from './warning_ledger.js'

/**
 * @import { OpenclawPluginApi } from './types.js'
 */

/** Must match the `id` in `openclaw.plugin.json` (OpenClaw plugin-manifest requirement). */
export const PLUGIN_ID = 'hypaware-openclaw-steering'

export const SHADOW_ANTHROPIC_PROVIDER_ID = 'hypaware-anthropic'
export const SHADOW_OPENAI_PROVIDER_ID = 'hypaware-openai'

/**
 * Registers both shadow providers (LLP 0144#decision) with `baseUrl` at the
 * local HypAware AI gateway, and the `before_model_resolve` steering hook
 * (LLP 0161#steering-precedence). No apiKey is supplied here: credential
 * borrowing rides `prepareRuntimeAuth` on the registered provider object
 * (LLP 0161#credentials-and-wire, LLP 0145#decision), which is a separate
 * task (LLP 0162 T2) layered onto this same registration.
 *
 * @ref LLP 0157#steering-plugin [implements]: the two shadow providers are
 * registered programmatically with `baseUrl` at the local gateway, never
 * writing to the user's `openclaw.json`.
 *
 * @param {OpenclawPluginApi} api
 */
function registerShadowProviders(api, baseUrl) {
  api.registerProvider({
    id: SHADOW_ANTHROPIC_PROVIDER_ID,
    label: 'HypAware capture (Anthropic)',
    catalog: {
      order: 'simple',
      async run() {
        return {
          providers: {
            [SHADOW_ANTHROPIC_PROVIDER_ID]: { baseUrl, api: 'anthropic-messages' },
          },
        }
      },
    },
  })

  api.registerProvider({
    id: SHADOW_OPENAI_PROVIDER_ID,
    label: 'HypAware capture (OpenAI)',
    catalog: {
      order: 'simple',
      async run() {
        return {
          providers: {
            [SHADOW_OPENAI_PROVIDER_ID]: { baseUrl, api: 'openai-completions' },
          },
        }
      },
    },
  })
}

/**
 * Registers the `before_model_resolve` steering hook. Re-fires per
 * candidate the hook is asked about - primary, fallbacks, per-agent
 * overrides, the extra model slots (LLP 0152 Context) - so returning a
 * decision per call, rather than caching one, is what makes coverage total
 * (LLP 0157 R2).
 *
 * @ref LLP 0161#steering-precedence [implements]: `resolveSteering`'s
 * four-branch precedence wired to OpenClaw's own hook contract.
 *
 * @param {OpenclawPluginApi} api
 * @param {ReturnType<typeof createWarningLedger>} ledger
 */
function registerSteeringHook(api, ledger) {
  api.on('before_model_resolve', async (event, ctx) => {
    const candidate = { provider: event.provider, api: event.api }

    const result = await resolveSteering(candidate, {
      resolveCredential: (provider) =>
        resolveApiKeyForProvider({ provider, sessionKey: ctx?.sessionKey, agentId: ctx?.agentId }),
    })

    if (result.steer) {
      return { providerOverride: result.providerOverride, requestMeta: result.requestMeta }
    }

    ledger.warn({ provider: result.provider, cause: result.cause, session: ctx?.sessionKey })
    // No decision: the candidate passes through on its original provider,
    // unmodified (LLP 0157 R5). The user's turn never fails because of
    // capture.
    return undefined
  })
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'HypAware OpenClaw Steering',
  description:
    'Registers the hypaware-anthropic and hypaware-openai shadow providers and steers every steerable OpenClaw model call to them, so OpenClaw conversations are captured through the local HypAware AI gateway without editing openclaw.json.',
  register(api) {
    const baseUrl = resolveGatewayEndpoint()
    const ledger = createWarningLedger()

    registerShadowProviders(api, baseUrl)
    registerSteeringHook(api, ledger)
  },
})
