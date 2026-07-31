// Minimal ambient shapes for the slice of OpenClaw's own plugin SDK this
// package touches (`openclaw/plugin-sdk/plugin-entry`,
// `openclaw/plugin-sdk/provider-auth-runtime`). This is OpenClaw API
// surface, not HypAware's - see LLP 0161#package-layout - so it is typed
// locally in this package rather than pulled from
// `hypaware-plugin-kernel-types.d.ts`, which describes the unrelated
// HypAware kernel plugin contract this package never implements.

export interface ProviderCatalogEntry {
  baseUrl: string
  api: string
}

export interface ProviderCatalogRunResult {
  providers: Record<string, ProviderCatalogEntry>
}

/**
 * The model descriptor `pi-ai` hands a `StreamFn`. Only the two fields the
 * wire-parity mirror branches on are typed here.
 */
export interface WireModel {
  id?: string
  api?: string
  provider?: string
  baseUrl?: string
}

/**
 * The slice of `pi-ai`'s `StreamOptions` the mirror reads or replaces.
 * `headers` is documented there as "merged with provider defaults; can
 * override default headers", and `onPayload` as the hook for "inspecting or
 * replacing provider payloads before sending".
 */
export interface StreamOptions {
  apiKey?: string
  headers?: Record<string, string>
  onPayload?: (payload: unknown, model: WireModel) => unknown
  [key: string]: unknown
}

export type StreamFn = (model: WireModel, context: unknown, options?: StreamOptions) => unknown

/** `ProviderWrapStreamFnContext`, narrowed to what the mirror reads. */
export interface ProviderWrapStreamFnContext {
  provider: string
  modelId?: string
  model?: WireModel
  extraParams?: Record<string, unknown>
  streamFn?: StreamFn
}

/** OpenClaw's `ResolvedProviderAuth`, the return of `resolveApiKeyForProvider`. */
export interface ResolvedProviderAuth {
  apiKey?: string
  profileId?: string
  source?: string
  mode?: 'api-key' | 'oauth' | 'token' | 'aws-sdk' | string
}

/** OpenClaw's `ProviderPrepareRuntimeAuthContext`. */
export interface ProviderPrepareRuntimeAuthContext {
  provider: string
  modelId?: string
  model?: WireModel
  apiKey?: string
  authMode?: string
  profileId?: string
  agentDir?: string
  workspaceDir?: string
  config?: unknown
  env?: NodeJS.ProcessEnv
}

/** OpenClaw's `ProviderPreparedRuntimeAuth`. */
export interface ProviderPreparedRuntimeAuth {
  apiKey: string
  baseUrl?: string
  expiresAt?: number
}

/** OpenClaw's `ProviderSyntheticAuthResult`. */
export interface ProviderSyntheticAuthResult {
  apiKey: string
  source: string
  mode: 'api-key' | 'oauth' | 'token'
}

export interface RegisterProviderOptions {
  id: string
  label?: string
  catalog: {
    order?: string
    run(): Promise<ProviderCatalogRunResult>
  }
  prepareRuntimeAuth?: (
    ctx: ProviderPrepareRuntimeAuthContext,
  ) => Promise<ProviderPreparedRuntimeAuth | undefined> | ProviderPreparedRuntimeAuth | undefined
  resolveSyntheticAuth?: (ctx: { provider: string }) => ProviderSyntheticAuthResult | undefined
  wrapStreamFn?: (ctx: ProviderWrapStreamFnContext) => StreamFn | undefined
}

export interface BeforeModelResolveEvent {
  provider: string
  api: string
}

export interface BeforeModelResolveCtx {
  sessionKey?: string
  agentId?: string
  agentDir?: string
  workspaceDir?: string
}

export interface BeforeModelResolveResult {
  providerOverride?: string
  modelOverride?: string
  requestMeta?: Record<string, string>
}

/**
 * One pass-through warning record the ledger rate-limits and emits.
 * `operation`, `status`, and `detail` default to the LLP 0149 pass-through
 * ledger's own values; they are per-record so the credential and wire-parity
 * hooks (LLP 0161#credentials-and-wire), which are degraded capture rather
 * than an uncaptured turn, can share the one rate limiter.
 */
export interface UncapturedTurn {
  provider: string
  cause: string
  session?: string
  operation?: string
  status?: string
  detail?: string
}

export interface OpenclawPluginApi {
  registerProvider(opts: RegisterProviderOptions): void
  on(
    hookName: 'before_model_resolve',
    handler: (
      event: BeforeModelResolveEvent,
      ctx: BeforeModelResolveCtx,
    ) => Promise<BeforeModelResolveResult | undefined> | BeforeModelResolveResult | undefined,
    opts?: Record<string, unknown>,
  ): void
}
