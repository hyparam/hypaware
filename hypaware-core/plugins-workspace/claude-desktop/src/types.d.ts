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

/**
 * Outcome of a single `claude-desktop install` step. `skipped` covers both
 * "not applicable" (org_key mode needs no sign-in) and "already done"
 * (idempotent re-check found nothing to do); `install.js` narrates the two
 * differently but both count as non-failing for the overall exit code.
 */
export interface InstallStepOutcome {
  step: string
  status: 'done' | 'skipped' | 'failed'
  detail?: string
}

/** Full `claude-desktop install` run: every step's outcome plus the verdict. */
export interface InstallResult {
  steps: InstallStepOutcome[]
  ok: boolean
}

/**
 * Automatic half of the two-tier verify (LLP 0131#verify-is-a-hint). The
 * in-app half (send a message, confirm capture) is a printed hint only and
 * carries no structured result.
 */
export interface VerifyResult {
  plistPresent: boolean
  plistUpToDate: boolean
  residueCleared: boolean
  helper: HelperCheck
  helperPath: string
  ok: boolean
}

/**
 * Whether the generated credential wrapper still works. `stale: false` is not
 * a claim of health for a wrapper this plugin did not write: an unrecognised
 * file is left alone rather than judged (`checkHelperScript`).
 */
export interface HelperCheck {
  present: boolean
  stale: boolean
  /** Which baked path rotted and how, ready to print. Set only when stale. */
  detail?: string
}
