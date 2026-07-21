/**
 * The managed third-party-inference payload rendered for Claude
 * Desktop. Key names and value enums are the app bundle's own
 * `inference*` config schema (verified against the bundle, v1.x).
 * `inferenceCredentialHelper` is a single string: an absolute path to
 * an executable Desktop runs with no arguments (LLP 0116), which is why
 * the plugin generates a wrapper rather than referencing a command line.
 */
export interface DesktopManagedProfile {
  inferenceProvider: 'gateway'
  inferenceGatewayBaseUrl: string
  inferenceGatewayAuthScheme: 'bearer' | 'x-api-key'
  inferenceModels: string[]
  inferenceCredentialKind: 'helper-script'
  inferenceCredentialHelper: string
}

/** Inputs the renderer resolves before building the profile. */
export interface ProfileInputs {
  baseUrl: string
  authScheme: 'bearer' | 'x-api-key'
  models: string[]
  helperPath: string
  bundleId: string
}
