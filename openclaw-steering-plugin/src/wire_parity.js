// Wire parity for the `hypaware-anthropic` shadow provider.
//
// OpenClaw's own Anthropic request shaping lives in
// `extensions/anthropic/stream-wrappers.ts` and is owner-scoped: it runs only
// for the provider literally named `anthropic`. A steered turn runs on
// `hypaware-anthropic`, so none of it runs, and a capture layer that changes
// the wire it captures undermines its own record. This module is the mirror
// LLP 0148 requires, kept pure (no `openclaw/plugin-sdk/*`, no `pi-ai`) so it
// is testable without an OpenClaw host.
//
// @ref LLP 0148#decision [implements]: the shadow provider's own
// `wrapStreamFn` mirrors OpenClaw's Anthropic request shaping, rather than the
// gateway growing an injection seam.
//
// Verified against the shipped OpenClaw bundle
// (`dist/extensions/anthropic/stream-wrappers.js`, openclaw 2026-07-30) and
// against `@mariozechner/pi-ai@0.73.1` (`dist/providers/anthropic.js`), which
// is the library that actually issues the request underneath. Three facts from
// that reading shape this file, and each is load-bearing:
//
// 1. **pi-ai adds the betas itself.** `createClient` pushes
//    `fine-grained-tool-streaming-2025-05-14` / `interleaved-thinking-2025-05-14`
//    from its own flags, and prepends `claude-code-20250219` /
//    `oauth-2025-04-20` whenever the key looks like an OAuth token
//    (`apiKey.includes('sk-ant-oat')`). This resolves LLP 0148's open question
//    and LLP 0161 Section 10's first item: the mirror shrinks. OpenClaw only
//    installs its own beta wrapper when the user configured `anthropicBeta` or
//    opted into `context1m`, so `shouldMirrorAnthropicBetas` mirrors that
//    installation condition too. Mirroring unconditionally would be a parity
//    change in the other direction: pi-ai deliberately omits the interleaved
//    beta on adaptive-thinking models, and an unconditional merge would put it
//    back on the wire for a turn that would not have carried it unsteered.
// 2. **The merge must be a union, not an append.** pi-ai merges
//    `options.headers` over its own defaults with `Object.assign`, so any
//    `anthropic-beta` this mirror sets *replaces* pi-ai's computed value
//    outright. The union below therefore has to carry the full set, and being
//    a `Set` keyed by header name it stays idempotent: merging the same inputs
//    twice is a no-op, so a future OpenClaw or pi-ai release that starts
//    setting one of these itself cannot produce a duplicate (LLP 0157 R4).
// 3. **`service_tier` is a payload field, not a header**, and OpenClaw gates it
//    on `provider === 'anthropic'` *and* a public Anthropic endpoint. Both
//    gates fail for a shadow provider pointed at a loopback gateway, which is
//    exactly the "refuses to act unless the base URL is public" loss LLP 0148
//    names. See `createAnthropicServiceTierWrapper` below for why this mirror
//    inverts the endpoint gate rather than copying it.

/**
 * @import { ProviderWrapStreamFnContext, StreamFn, StreamOptions, WireModel } from './types.js'
 */

/**
 * OpenClaw's `OPENCLAW_DEFAULT_ANTHROPIC_BETAS`.
 * @type {readonly string[]}
 */
export const ANTHROPIC_DEFAULT_BETAS = Object.freeze([
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
])

/**
 * OpenClaw's `OPENCLAW_OAUTH_ANTHROPIC_BETAS`: the OAuth-only additions come
 * first and the defaults still apply, so this is a superset, never a swap.
 * @type {readonly string[]}
 */
export const ANTHROPIC_OAUTH_BETAS = Object.freeze([
  'claude-code-20250219',
  'oauth-2025-04-20',
  ...ANTHROPIC_DEFAULT_BETAS,
])

/**
 * The `context-1m` opt-in beta. LLP 0157's verified header list names it as
 * "per the user's opt-in, excluded under OAuth", but the shipped OpenClaw
 * calls it `ANTHROPIC_CONTEXT_1M_BETA_LEGACY` and strips it from every emitted
 * set unconditionally (both from configured betas and from the merged list) -
 * 1M context is GA on the model families listed below, so the beta header is
 * no longer the opt-in switch. Parity means matching what OpenClaw actually
 * puts on the wire, so this mirror strips it too. The opt-in itself is not
 * ignored: `extraParams.context1m` still decides whether the mirror runs at
 * all, exactly as it decides whether OpenClaw's own wrapper is installed.
 */
export const ANTHROPIC_CONTEXT_1M_BETA = 'context-1m-2025-08-07'

/** OpenClaw's `ANTHROPIC_GA_1M_MODEL_PREFIXES`. */
const ANTHROPIC_GA_1M_MODEL_PREFIXES = Object.freeze([
  'claude-opus-4-8',
  'claude-opus-4.8',
  'claude-opus-4-6',
  'claude-opus-4.6',
  'claude-opus-4-7',
  'claude-opus-4.7',
  'claude-sonnet-4-6',
  'claude-sonnet-4.6',
])

/**
 * OpenClaw resolves these two families through `resolveClaudeFable5ModelIdentity`
 * / `resolveClaudeSonnet5ModelIdentity`, which normalize cloud ids and
 * deployment metadata before matching. Those helpers are OpenClaw internals
 * with no plugin-SDK export, so the mirror carries their id regexes.
 */
const CLAUDE_FABLE_5_MODEL_RE = /(?:^|-)claude-fable-5(?=$|[^a-z0-9])/
const CLAUDE_SONNET_5_MODEL_RE = /(?:^|-)claude-sonnet-5(?=$|[^a-z0-9])/

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * OpenClaw's `isAnthropicOAuthApiKey`, and the same predicate pi-ai uses to
 * decide Bearer auth and the OAuth beta set. The borrowed credential
 * (LLP 0145) is what reaches this, so a subscription-auth OpenClaw user is
 * recognized as OAuth on the steered path exactly as on the unsteered one.
 *
 * @param {unknown} apiKey
 * @returns {boolean}
 */
export function isAnthropicOAuthApiKey(apiKey) {
  return typeof apiKey === 'string' && apiKey.includes('sk-ant-oat')
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseHeaderList(value) {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * The idempotent merge (LLP 0157 R4): the header *name* is matched
 * case-insensitively so an existing spelling is extended rather than
 * shadowed by a second key, and the values are unioned through a `Set` so
 * merging the same inputs twice changes nothing.
 *
 * @param {Record<string, string> | undefined} headers
 * @param {string} name
 * @param {readonly string[]} values
 * @returns {Record<string, string>}
 */
export function mergeHeaderList(headers, name, values) {
  const merged = { ...headers }
  const wanted = normalizeLower(name)
  const existingKey = Object.keys(merged).find((key) => normalizeLower(key) === wanted)
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : []
  merged[existingKey ?? name] = [...new Set([...existing, ...values])].join(',')
  return merged
}

/**
 * OpenClaw's `mergeAnthropicBetaHeader`.
 *
 * @param {Record<string, string> | undefined} headers
 * @param {readonly string[]} betas
 * @returns {Record<string, string>}
 */
export function mergeAnthropicBetaHeader(headers, betas) {
  return mergeHeaderList(headers, 'anthropic-beta', betas)
}

/**
 * True when the model's `extraParams` carry a non-blank `anthropicBeta`,
 * mirroring OpenClaw's `hasConfiguredAnthropicBeta`. Distinct from
 * `resolveConfiguredAnthropicBetas` returning a value: a user who configured
 * only `context-1m` has a configured beta whose resolved list is empty, and
 * OpenClaw still installs its wrapper for them.
 *
 * @param {Record<string, unknown> | undefined} extraParams
 * @returns {boolean}
 */
export function hasConfiguredAnthropicBeta(extraParams) {
  const configured = extraParams?.anthropicBeta
  if (typeof configured === 'string') return configured.trim().length > 0
  if (!Array.isArray(configured)) return false
  return configured.some((beta) => typeof beta === 'string' && beta.trim().length > 0)
}

/**
 * OpenClaw's `resolveAnthropicBetas`: read `extraParams.anthropicBeta` as
 * either a comma list or an array of comma lists, dropping the legacy
 * `context-1m` entry.
 *
 * @param {Record<string, unknown> | undefined} extraParams
 * @returns {string[] | undefined}
 */
export function resolveConfiguredAnthropicBetas(extraParams) {
  /** @type {Set<string>} */
  const betas = new Set()
  const configured = extraParams?.anthropicBeta
  if (typeof configured === 'string' && configured.trim()) {
    for (const beta of parseHeaderList(configured)) betas.add(beta)
  } else if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      for (const beta of parseHeaderList(entry)) betas.add(beta)
    }
  }
  betas.delete(ANTHROPIC_CONTEXT_1M_BETA)
  return betas.size > 0 ? [...betas] : undefined
}

/**
 * OpenClaw's `isAnthropic1MModel`.
 *
 * @param {string | undefined} modelId
 * @returns {boolean}
 */
export function isAnthropic1MModel(modelId) {
  const normalized = normalizeLower(modelId)
  if (CLAUDE_FABLE_5_MODEL_RE.test(normalized) || CLAUDE_SONNET_5_MODEL_RE.test(normalized)) return true
  return ANTHROPIC_GA_1M_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * OpenClaw's `needsAnthropicBetaWrapper`. Mirroring the *installation*
 * condition, not just the merged set, is what keeps parity honest in both
 * directions: when it is false, pi-ai's own beta computation is exactly what
 * an unsteered turn would have produced, and touching the header would change
 * the wire rather than preserve it.
 *
 * @param {Record<string, unknown> | undefined} extraParams
 * @param {string | undefined} modelId
 * @returns {boolean}
 */
export function shouldMirrorAnthropicBetas(extraParams, modelId) {
  if (resolveConfiguredAnthropicBetas(extraParams) !== undefined) return true
  if (hasConfiguredAnthropicBeta(extraParams)) return true
  return extraParams?.context1m === true && isAnthropic1MModel(modelId)
}

/**
 * OpenClaw's `createAnthropicBetaHeadersWrapper`.
 *
 * @param {StreamFn} baseStreamFn
 * @param {readonly string[]} betas
 * @returns {StreamFn}
 */
export function createAnthropicBetaHeadersWrapper(baseStreamFn, betas) {
  return (model, context, options) => {
    const effective = betas.filter((beta) => beta !== ANTHROPIC_CONTEXT_1M_BETA)
    const base = isAnthropicOAuthApiKey(options?.apiKey) ? ANTHROPIC_OAUTH_BETAS : ANTHROPIC_DEFAULT_BETAS
    const all = [...new Set([...base, ...effective])]
    return baseStreamFn(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, all),
    })
  }
}

/**
 * OpenClaw's `streamWithPayloadPatch`, built on `pi-ai`'s public `onPayload`
 * hook ("inspecting or replacing provider payloads before sending") rather
 * than any OpenClaw internal, so the mirror needs no private import.
 *
 * @param {StreamFn} underlying
 * @param {WireModel} model
 * @param {unknown} context
 * @param {StreamOptions | undefined} options
 * @param {(payload: Record<string, unknown>) => void} patchPayload
 */
function streamWithPayloadPatch(underlying, model, context, options, patchPayload) {
  const originalOnPayload = options?.onPayload
  return underlying(model, context, {
    ...options,
    onPayload: (payload, forModel) => {
      if (payload && typeof payload === 'object') patchPayload(/** @type {Record<string, unknown>} */ (payload))
      return originalOnPayload?.(payload, forModel)
    },
  })
}

/**
 * OpenClaw's `normalizeAnthropicServiceTier`.
 *
 * @param {unknown} value
 * @returns {'auto' | 'standard_only' | undefined}
 */
export function normalizeAnthropicServiceTier(value) {
  const normalized = normalizeLower(value)
  if (normalized === 'auto' || normalized === 'standard_only') return normalized
  return undefined
}

/**
 * OpenClaw's `resolveAnthropicServiceTier`, minus the invalid-value warning
 * (this package has no OpenClaw subsystem logger; the pass-through ledger is
 * the plugin's only emission surface and an invalid tier is not an uncaptured
 * turn).
 *
 * @param {Record<string, unknown> | undefined} extraParams
 * @returns {'auto' | 'standard_only' | undefined}
 */
export function resolveAnthropicServiceTier(extraParams) {
  return normalizeAnthropicServiceTier(extraParams?.serviceTier ?? extraParams?.service_tier)
}

const FAST_MODE_FALSE = Object.freeze(['off', 'false', 'no', '0', 'disable', 'disabled', 'normal'])
const FAST_MODE_TRUE = Object.freeze(['on', 'true', 'yes', '1', 'enable', 'enabled', 'fast'])

/**
 * OpenClaw's `normalizeFastMode`.
 *
 * @param {unknown} raw
 * @returns {boolean | 'auto' | undefined}
 */
export function normalizeFastMode(raw) {
  if (typeof raw === 'boolean') return raw
  if (!raw) return undefined
  const key = normalizeLower(raw)
  if (FAST_MODE_FALSE.includes(key)) return false
  if (FAST_MODE_TRUE.includes(key)) return true
  if (key === 'auto' || key === 'automatic') return 'auto'
  return undefined
}

/**
 * OpenClaw's `resolveAnthropicFastMode`: `auto` means "leave it to the
 * server", which is why it collapses to `undefined` rather than to a tier.
 *
 * @param {Record<string, unknown> | undefined} extraParams
 * @returns {boolean | undefined}
 */
export function resolveAnthropicFastMode(extraParams) {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode
  const normalized = normalizeFastMode(typeof raw === 'function' ? raw() : raw)
  return normalized === 'auto' ? undefined : normalized
}

/**
 * OpenClaw's `resolveAnthropicFastServiceTier`.
 *
 * @param {boolean} enabled
 * @returns {'auto' | 'standard_only'}
 */
export function resolveAnthropicFastServiceTier(enabled) {
  return enabled ? 'auto' : 'standard_only'
}

/**
 * OpenClaw's `createAnthropicServiceTierWrapper`, with one deliberate
 * inversion. OpenClaw gates the payload patch on
 * `allowsAnthropicServiceTier`, which is
 * `provider === 'anthropic' && api === 'anthropic-messages' && endpointClass
 * is default|anthropic-public`. Copying that gate verbatim would make this
 * mirror a no-op forever: the provider is `hypaware-anthropic` and the base
 * URL is a loopback gateway, so both halves fail by construction. The gate
 * exists to keep `service_tier` off requests bound for an endpoint that does
 * not understand it, and here the true forward target *is* the public
 * Anthropic API - the gateway's `anthropic` upstream preset carries a static
 * `base_url` of `https://api.anthropic.com` and no per-request retarget
 * (LLP 0161#steering-precedence), which is the same fact that makes steering
 * safe at all. So the mirror keeps the two conditions it can still evaluate
 * honestly (the shape, and the OAuth / Sonnet 5 carve-outs) and treats the
 * endpoint as public.
 *
 * @param {StreamFn} baseStreamFn
 * @param {'auto' | 'standard_only'} serviceTier
 * @returns {StreamFn}
 */
export function createAnthropicServiceTierWrapper(baseStreamFn, serviceTier) {
  return (model, context, options) => {
    if (isAnthropicOAuthApiKey(options?.apiKey)) return baseStreamFn(model, context, options)
    if (CLAUDE_SONNET_5_MODEL_RE.test(normalizeLower(model?.id))) return baseStreamFn(model, context, options)
    if (normalizeLower(model?.api) !== 'anthropic-messages') return baseStreamFn(model, context, options)
    return streamWithPayloadPatch(baseStreamFn, model, context, options, (payload) => {
      if (payload.service_tier === undefined) payload.service_tier = serviceTier
    })
  }
}

/**
 * OpenClaw's `createAnthropicFastModeWrapper`: the setting is read per call
 * (it can be toggled mid-session), and an unresolvable value leaves the
 * payload alone rather than picking a tier.
 *
 * @param {StreamFn} baseStreamFn
 * @param {() => boolean | undefined} enabled
 * @returns {StreamFn}
 */
export function createAnthropicFastModeWrapper(baseStreamFn, enabled) {
  return (model, context, options) => {
    const resolved = enabled()
    if (resolved === undefined) return baseStreamFn(model, context, options)
    return createAnthropicServiceTierWrapper(baseStreamFn, resolveAnthropicFastServiceTier(resolved))(
      model,
      context,
      options,
    )
  }
}

/**
 * OpenClaw's `stripTrailingAssistantPrefillMessages` /
 * `stripTrailingAnthropicAssistantPrefillWhenThinking`: extended thinking
 * requires the conversation to end on a user turn, so a trailing assistant
 * prefill is an API error rather than a degraded response. A tool-use block
 * is not a prefill and stops the walk.
 *
 * @param {Record<string, unknown>} payload
 * @returns {number} how many trailing prefill messages were removed
 */
export function stripTrailingAnthropicAssistantPrefillWhenThinking(payload) {
  const thinking = payload.thinking
  if (!thinking || typeof thinking !== 'object') return 0
  if (/** @type {Record<string, unknown>} */ (thinking).type === 'disabled') return 0
  const messages = payload.messages
  if (!Array.isArray(messages)) return 0
  let stripped = 0
  while (messages.length > 0) {
    const last = messages[messages.length - 1]
    if (!last || typeof last !== 'object') break
    const message = /** @type {Record<string, unknown>} */ (last)
    if (message.role !== 'assistant' || hasAnthropicToolUse(message)) break
    messages.pop()
    stripped += 1
  }
  return stripped
}

/**
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
function hasAnthropicToolUse(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true
  const content = message.content
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false
    const type = /** @type {Record<string, unknown>} */ (block).type
    return type === 'tool_use' || type === 'toolCall'
  })
}

/**
 * OpenClaw's `createAnthropicThinkingPrefillWrapper`. Installed
 * unconditionally there, so unconditionally here.
 *
 * @param {StreamFn} baseStreamFn
 * @param {(stripped: number) => void} [onStripped]
 * @returns {StreamFn}
 */
export function createAnthropicThinkingPrefillWrapper(baseStreamFn, onStripped) {
  return (model, context, options) =>
    streamWithPayloadPatch(baseStreamFn, model, context, options, (payload) => {
      const stripped = stripTrailingAnthropicAssistantPrefillWhenThinking(payload)
      if (stripped > 0) onStripped?.(stripped)
    })
}

/**
 * The `wrapStreamFn` entry point for `hypaware-anthropic`, composing the same
 * wrappers in the same order as OpenClaw's `wrapAnthropicProviderStream`.
 *
 * Returns `undefined` when there is no base stream function to wrap. OpenClaw's
 * own wrappers fall back to `pi-ai`'s `streamSimple` here; this package refuses
 * to take a dependency on `pi-ai` to reproduce a default it would then have to
 * keep in step, so it declines to wrap instead. `onSkipped` makes that an
 * observable event rather than a silent parity gap, which is the only way
 * LLP 0148's "parity gaps are bugs, never accepted losses" rule can be
 * enforced after ship.
 *
 * @ref LLP 0157#steering-plugin [implements]: the concrete mirror (default
 * betas, OAuth additions, the context-1m opt-in, service_tier) verified
 * against `extensions/anthropic/stream-wrappers.ts`.
 *
 * @param {ProviderWrapStreamFnContext} ctx
 * @param {{ onSkipped?: (reason: string) => void, onPrefillStripped?: (stripped: number) => void }} [hooks]
 * @returns {StreamFn | undefined}
 */
export function wrapAnthropicShadowStream(ctx, hooks = {}) {
  const baseStreamFn = ctx.streamFn
  if (typeof baseStreamFn !== 'function') {
    hooks.onSkipped?.('no_base_stream_fn')
    return undefined
  }

  const extraParams = ctx.extraParams
  const modelId = ctx.modelId ?? ctx.model?.id

  let streamFn = baseStreamFn
  if (shouldMirrorAnthropicBetas(extraParams, modelId)) {
    streamFn = createAnthropicBetaHeadersWrapper(streamFn, resolveConfiguredAnthropicBetas(extraParams) ?? [])
  }

  const serviceTier = resolveAnthropicServiceTier(extraParams)
  if (serviceTier) {
    streamFn = createAnthropicServiceTierWrapper(streamFn, serviceTier)
  }

  if (extraParams !== undefined && (Object.hasOwn(extraParams, 'fastMode') || Object.hasOwn(extraParams, 'fast_mode'))) {
    streamFn = createAnthropicFastModeWrapper(streamFn, () => resolveAnthropicFastMode(extraParams))
  }

  return createAnthropicThinkingPrefillWrapper(streamFn, hooks.onPrefillStripped)
}
