/**
 * The managed third-party-inference payload rendered for Claude
 * Desktop. Key names mirror the app bundle's `inference*` config
 * surface; the credential-helper key group was probed as
 * `inferenceCredentialHelper*` and its exact spelling must be verified
 * against a real MDM push in the first fleet pilot (LLP 0115).
 */
export interface DesktopManagedProfile {
  inferenceProvider: 'gateway'
  inferenceGatewayBaseUrl: string
  inferenceGatewayAuthScheme: 'bearer' | 'x-api-key'
  inferenceModels: string[]
  inferenceCredentialKind: 'helper'
  inferenceCredentialHelperPath: string
  inferenceCredentialHelperArgs: string[]
}

/** Inputs the renderer resolves before building the profile. */
export interface ProfileInputs {
  baseUrl: string
  authScheme: 'bearer' | 'x-api-key'
  models: string[]
  helperPath: string
  helperArgs: string[]
  bundleId: string
}
