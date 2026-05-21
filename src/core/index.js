// @ts-check

// Top-level kernel barrel. Behavior is added incrementally in
// Phases 1-9; the observability layer was the first real subsystem and
// the Phase 6 config layer joined it after schema + cross-plugin
// validation landed.

export * from './observability/index.js'
export { createConfigRegistry, defaultConfigPath, loadConfigFile, parseConfigShape, CONFIG_BASENAME } from './config/schema.js'
export { validateConfig, firstPartyPluginMetadata, mergeInstalledManifestsIntoKnown, isCronExpression, CAP_ENCODER, CAP_BLOB_STORE, CAP_HTTP_ENDPOINT } from './config/validate.js'
