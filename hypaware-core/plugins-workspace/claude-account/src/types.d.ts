export type ClaudeAccountMode = 'org_key' | 'subscription'

/**
 * Value provided under the `hypaware.anthropic-credential` capability.
 * Consumers (the Desktop profile renderer) read the fleet-resolved mode
 * and the argv tail that, appended to the `hyp` binary, forms the
 * credential-helper command line.
 */
export interface AnthropicCredentialCapability {
  mode: ClaudeAccountMode
  helperCommandArgs: string[]
}

/** Persisted record for a subscription sign-in. Timestamps are unix seconds. */
export interface SubscriptionOauthRecord {
  kind: 'subscription_oauth'
  access_token: string
  refresh_token: string
  expires_at: number
  obtained_at: number
  scopes?: string[]
}

/**
 * What the credential command prints to stdout, per Desktop's helper
 * contract: a single JSON object, nothing else.
 */
export interface HelperCredential {
  token: string
  headers: Record<string, string>
  ttlSec: number
}

/** Result of a token-endpoint exchange or refresh. */
export interface OauthTokenGrant {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
}
