// Credential borrowing for the two shadow providers.
//
// A `hypaware-*` provider has no credential of its own and must never acquire
// one: LLP 0145 rejects both "require a vendor env var" and "read OpenClaw's
// credential storage from outside its process", leaving exactly one route -
// resolve the *shadowed* provider's credential in-process, through OpenClaw's
// own public `resolveApiKeyForProvider`, and hand it back for that one
// request. This module is the pure half of that, with the SDK call injected so
// it is testable without an OpenClaw host.
//
// Nothing here writes the borrowed credential anywhere. There is no cache, no
// module-level variable holding it, and no return path other than the value
// OpenClaw asked for: the credential exists only for the duration of the call
// that resolved it (LLP 0145#decision, LLP 0157 R3).
//
// @ref LLP 0145#decision [implements]: the shadow provider borrows the
// shadowed provider's credential inside `prepareRuntimeAuth`, so refresh and
// expiry ride OpenClaw's generic background-refresh path instead of being
// pinned at catalog-build time.

import { CANONICAL_PROVIDER_FOR_SHAPE, SHADOW_FOR_SHAPE } from './steering.js'

/**
 * @import { ProviderPrepareRuntimeAuthContext, ProviderPreparedRuntimeAuth, ProviderSyntheticAuthResult, ResolvedProviderAuth } from './types.js'
 */

/**
 * Which real provider each shadow stands in for, derived from the two maps
 * `resolveSteering` already branches on rather than restated, so a third API
 * shape can never be added to steering without also being borrowable here.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REAL_PROVIDER_FOR_SHADOW = Object.freeze(
  Object.fromEntries(
    Object.entries(SHADOW_FOR_SHAPE).map(([shape, shadow]) => [shadow, CANONICAL_PROVIDER_FOR_SHAPE[shape]]),
  ),
)

/**
 * The placeholder credential `resolveSyntheticAuth` hands OpenClaw for a
 * `hypaware-*` provider. It is not a secret and never reaches the wire: the
 * only thing it does is get the runtime past the `MissingProviderAuthError`
 * that `applyApiKeyInfo` throws for a provider with no resolvable credential,
 * which is raised *before* `prepareRuntimeAuth` runs (verified against
 * openclaw's `src/agents/embedded-agent-runner/run/auth-controller.ts`,
 * 2026-07-30). Without it the borrow below would never be reached, and every
 * steered turn would fail on the shadow provider's empty credential. LM
 * Studio's bundled plugin uses the same seam with `custom-local`.
 */
export const SYNTHETIC_AUTH_MARKER = 'hypaware-borrowed'

/**
 * How long a prepared OAuth borrow is declared good for.
 *
 * OpenClaw only schedules a background re-preparation when the prepared auth
 * carries an `expiresAt`; without one, the borrowed token is pinned for the
 * whole run and a long turn can outlive it. OpenClaw's public
 * `resolveApiKeyForProvider` returns `{ apiKey, profileId, source, mode }` and
 * no expiry, so this value is not a claim about when the token dies - it is a
 * *re-resolution deadline*, chosen so OpenClaw comes back and asks again,
 * at which point `resolveApiKeyForProvider`'s own OAuth branch refreshes
 * under lock if needed. It must stay comfortably above OpenClaw's
 * `RUNTIME_AUTH_REFRESH_MARGIN_MS` (5 minutes), since the refresh is scheduled
 * at `expiresAt - margin` and clamped to a 5-second floor: a TTL at or below
 * the margin would busy-loop.
 */
export const BORROWED_OAUTH_REVALIDATE_MS = 15 * 60 * 1000

/**
 * Reduces OpenClaw's `ResolvedProviderAuth` to "is there a usable credential,
 * and is it an OAuth one". A resolver that returns a bare string (or a
 * `MissingProviderAuthError` shaped result with no `apiKey`) is handled too,
 * because `resolveSteering`'s credential probe and this borrow share one
 * injected resolver and must agree on what "no credential" means.
 *
 * @param {ResolvedProviderAuth | string | undefined | null} resolved
 * @returns {{ apiKey: string, mode?: string, profileId?: string, source?: string } | undefined}
 */
export function normalizeBorrowedCredential(resolved) {
  if (typeof resolved === 'string') {
    return resolved.trim() ? { apiKey: resolved } : undefined
  }
  if (!resolved || typeof resolved !== 'object') return undefined
  const apiKey = typeof resolved.apiKey === 'string' ? resolved.apiKey.trim() : ''
  if (!apiKey) return undefined
  return { apiKey, mode: resolved.mode, profileId: resolved.profileId, source: resolved.source }
}

/**
 * `resolveSyntheticAuth` for the shadow providers. Returns a placeholder only
 * for a provider this plugin owns, so it can never affect another provider's
 * auth resolution.
 *
 * @param {{ provider: string }} ctx
 * @returns {ProviderSyntheticAuthResult | undefined}
 */
export function resolveShadowSyntheticAuth(ctx) {
  if (REAL_PROVIDER_FOR_SHADOW[ctx.provider] === undefined) return undefined
  return {
    apiKey: SYNTHETIC_AUTH_MARKER,
    source: 'hypaware-openclaw-steering (borrowed at request time)',
    mode: 'api-key',
  }
}

/**
 * Builds the `prepareRuntimeAuth` hook shared by both shadow providers.
 *
 * Per call, it re-resolves the shadowed provider's credential and returns it
 * together with the gateway `baseUrl` - the belt-and-braces endpoint override
 * LLP 0152's Consequences name, so a request cannot escape the gateway even if
 * the catalog entry is stale. It returns `undefined` (rather than throwing)
 * when nothing can be borrowed: `resolveSteering` already refused to steer
 * that provider, so reaching here means the credential disappeared between the
 * steering decision and the request, and a pass-through failure is the honest
 * outcome. Capture must never fail a user's turn on its own account
 * (LLP 0157 R5).
 *
 * @ref LLP 0161#credentials-and-wire [implements]: `{ apiKey, baseUrl,
 * expiresAt? }` per request, never persisted, re-resolved every call.
 *
 * @param {{
 *   baseUrl: string,
 *   resolveCredential(params: { provider: string, context: ProviderPrepareRuntimeAuthContext }): Promise<ResolvedProviderAuth | string | undefined | null> | ResolvedProviderAuth | string | undefined | null,
 *   now?: () => number,
 *   revalidateMs?: number,
 *   onError?: (info: { provider: string, error: unknown }) => void,
 * }} opts
 * @returns {(ctx: ProviderPrepareRuntimeAuthContext) => Promise<ProviderPreparedRuntimeAuth | undefined>}
 */
export function createPrepareRuntimeAuth(opts) {
  const now = opts.now ?? Date.now
  const revalidateMs = opts.revalidateMs ?? BORROWED_OAUTH_REVALIDATE_MS

  return async function prepareRuntimeAuth(ctx) {
    const realProvider = REAL_PROVIDER_FOR_SHADOW[ctx.provider]
    if (realProvider === undefined) return undefined

    let resolved
    try {
      resolved = await opts.resolveCredential({ provider: realProvider, context: ctx })
    } catch (error) {
      opts.onError?.({ provider: realProvider, error })
      return undefined
    }

    const borrowed = normalizeBorrowedCredential(resolved)
    if (borrowed === undefined) return undefined

    /** @type {ProviderPreparedRuntimeAuth} */
    const prepared = { apiKey: borrowed.apiKey, baseUrl: opts.baseUrl }
    if (borrowed.mode === 'oauth') {
      prepared.expiresAt = now() + revalidateMs
    }
    return prepared
  }
}
