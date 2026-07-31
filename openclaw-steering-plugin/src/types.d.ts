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

export interface RegisterProviderOptions {
  id: string
  label?: string
  catalog: {
    order?: string
    run(): Promise<ProviderCatalogRunResult>
  }
}

export interface BeforeModelResolveEvent {
  provider: string
  api: string
}

export interface BeforeModelResolveCtx {
  sessionKey?: string
  agentId?: string
}

export interface BeforeModelResolveResult {
  providerOverride?: string
  modelOverride?: string
  requestMeta?: Record<string, string>
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
