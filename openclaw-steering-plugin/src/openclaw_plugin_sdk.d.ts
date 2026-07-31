// Ambient declarations for the two `openclaw/plugin-sdk/*` subpaths
// `src/index.js` imports. `openclaw` is the host process that installs this
// package, not a dependency of it, so those specifiers never resolve inside
// this repo - which left `index.js`, the entrypoint that registers both
// shadow providers and wires the steering hook, as the one source file the
// typecheck graph could not reach (every other file in the package is
// pulled in through the root test shim, `test/plugins/
// openclaw-steering-plugin.test.js`). Declaring the two modules here puts
// it back under `npm run typecheck`. Like `types.d.ts`, this asserts
// OpenClaw's API surface rather than importing it, because OpenClaw is the
// host, not a HypAware dependency (LLP 0161#package-layout).
//
// Two constraints shape the form below. The file must stay a script - no
// top-level `import` or `export` - or the blocks are read as augmentations
// of modules that do not exist. And an ambient module body may not import
// through a relative specifier (TS2439), so neither block can reference
// `./types.js`: `definePluginEntry` therefore takes its `register` callback
// loosely and `index.js` annotates the parameter itself, and the auth
// record is restated structurally here. Keep that restatement in step with
// `ResolvedProviderAuth` in `types.d.ts`; it is the same OpenClaw record.

declare module 'openclaw/plugin-sdk/plugin-entry' {
  export function definePluginEntry(entry: {
    id: string
    name: string
    description?: string
    register(api: any): void | Promise<void>
  }): unknown
}

declare module 'openclaw/plugin-sdk/provider-auth-runtime' {
  /**
   * Resolves to a record, never a bare key, so an unwrapped `apiKey` of
   * `undefined` is what "no credential for this provider" looks like.
   */
  export function resolveApiKeyForProvider(params: {
    provider: string
    cfg?: unknown
    agentDir?: string
    workspaceDir?: string
  }): Promise<{ apiKey?: string, profileId?: string, source?: string, mode?: string }>
}
