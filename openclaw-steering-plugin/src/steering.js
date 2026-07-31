// This module is the pure decision core of the OpenClaw steering plugin. It
// has no dependency on `openclaw/plugin-sdk/*` on purpose, so it is testable
// standalone (LLP 0162 T1) without an OpenClaw host to run inside of.

/**
 * The one real provider `before_model_resolve` ever substitutes a shadow
 * for, per API shape (LLP 0144#decision): `hypaware-anthropic` covers
 * `anthropic-messages`, `hypaware-openai` covers `openai-completions`.
 *
 * @ref LLP 0144#decision [implements]: one shadow provider per API shape,
 * not per vendor.
 * @type {Readonly<Record<string, string>>}
 */
export const SHADOW_FOR_SHAPE = Object.freeze({
  'anthropic-messages': 'hypaware-anthropic',
  'openai-completions': 'hypaware-openai',
})

/**
 * The literal provider id each shape's shadow stands in for. A candidate
 * whose declared `api` matches a shape but whose `provider` is not this
 * value is never steered directly to that shadow (LLP 0161#steering-precedence:
 * the gateway's upstream presets have a static `base_url` per preset, so
 * steering anything else would silently redirect it to the wrong vendor).
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CANONICAL_PROVIDER_FOR_SHAPE = Object.freeze({
  'anthropic-messages': 'anthropic',
  'openai-completions': 'openai',
})

/**
 * Host-signed and per-user-URL provider families that are deferred rather
 * than steered, even though they share a shape with a canonical provider
 * (LLP 0146#decision). This is a declared list, not a heuristic: a provider
 * is steered unless it is named here.
 *
 * - `amazon-bedrock`, `anthropic-vertex`: signing is scoped to the request
 *   host, so a retargeted `baseUrl` likely breaks it (LLP 0146 Context).
 * - `google`, `google-vertex`, `google-gemini-cli`: LLP 0146's "the Google
 *   providers" family, named here by OpenClaw's own provider ids; verify
 *   this trio against a live OpenClaw install before relying on it, and if
 *   OpenClaw ships another Google-family id later, add it as its own short
 *   decision LLP citing LLP 0146/0161, not a silent diff here
 *   (LLP 0161 Section 11).
 * - `cloudflare-ai-gateway`, `vercel-ai-gateway`: deferred for a mechanical
 *   reason, not a signing one - their real base URL is per-user, so no
 *   static gateway preset can represent them (LLP 0146 Open questions).
 *
 * @ref LLP 0146#decision [implements]: the declared deferred-family list.
 * @type {ReadonlySet<string>}
 */
export const DEFERRED_SET = new Set([
  'amazon-bedrock',
  'anthropic-vertex',
  'google',
  'google-vertex',
  'google-gemini-cli',
  'cloudflare-ai-gateway',
  'vercel-ai-gateway',
])

/**
 * The three named pass-through warning causes (LLP 0157 R5, LLP 0149#decision).
 * `resolveSteering` never returns a fourth.
 */
export const WARNING_CAUSES = Object.freeze({
  NO_CREDENTIAL: 'no_credential',
  NO_PRESET: 'no_preset',
  DEFERRED: 'deferred',
})

/**
 * @param {{ provider: string }} candidate
 * @param {string} cause
 * @returns {{ steer: false, cause: string, provider: string }}
 */
function warn(candidate, cause) {
  return { steer: false, cause, provider: candidate.provider }
}

/**
 * Wraps `openclaw/plugin-sdk/provider-auth-runtime`'s `resolveApiKeyForProvider`
 * (LLP 0145#decision) so "no credential available" is a value `resolveSteering`
 * can branch on, rather than an exception it would have to catch inline. A
 * throw (profile store unavailable, provider unknown to OpenClaw's auth
 * runtime, etc.) is treated the same as "no credential": the turn passes
 * through and warns, it never fails the user's turn (LLP 0157 R5).
 *
 * @param {string} provider
 * @param {{ resolveCredential(provider: string): Promise<string|undefined|null>|string|undefined|null }} ctx
 * @returns {Promise<string|undefined>}
 */
export async function tryResolveApiKeyForProvider(provider, ctx) {
  try {
    const credential = await ctx.resolveCredential(provider)
    return credential || undefined
  } catch {
    return undefined
  }
}

/**
 * The four-branch steering precedence (LLP 0161#steering-precedence),
 * terminal at each check:
 *
 * 1. no shadow covers this candidate's `api` shape at all -> `no_preset`
 * 2. the candidate's `provider` is not the shape's one canonical vendor:
 *    - a named deferred family (LLP 0146) -> `deferred`
 *    - anything else (an unrecognized vendor sharing the shape) -> `no_preset`
 * 3. the shadowed provider's credential cannot be resolved -> `no_credential`
 * 4. otherwise: steer, carrying the real provider as `x-hypaware-upstream`
 *    request metadata (LLP 0161#upstream-header) so the gateway and the
 *    projector can both recover true upstream identity.
 *
 * @ref LLP 0157#requirements [implements]: R2, R3, R5, R6 collapse into this
 * one algorithm, not four independent checks.
 *
 * @param {{ provider: string, api: string }} candidate
 * @param {{ resolveCredential(provider: string): Promise<string|undefined|null>|string|undefined|null }} ctx
 * @returns {Promise<
 *   | { steer: true, providerOverride: string, requestMeta: { 'x-hypaware-upstream': string } }
 *   | { steer: false, cause: string, provider: string }
 * >}
 */
export async function resolveSteering(candidate, ctx) {
  const shape = candidate.api
  const shadow = SHADOW_FOR_SHAPE[shape]

  if (shadow === undefined) {
    return warn(candidate, WARNING_CAUSES.NO_PRESET)
  }

  const canonicalProvider = CANONICAL_PROVIDER_FOR_SHAPE[shape]
  if (candidate.provider !== canonicalProvider) {
    if (DEFERRED_SET.has(candidate.provider)) {
      return warn(candidate, WARNING_CAUSES.DEFERRED)
    }
    return warn(candidate, WARNING_CAUSES.NO_PRESET)
  }

  const credential = await tryResolveApiKeyForProvider(candidate.provider, ctx)
  if (credential === undefined) {
    return warn(candidate, WARNING_CAUSES.NO_CREDENTIAL)
  }

  return {
    steer: true,
    providerOverride: shadow,
    requestMeta: { 'x-hypaware-upstream': candidate.provider },
  }
}
