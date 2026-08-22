/**
 * Types for the sandbox's mock `launchctl` / `security` / `systemctl`
 * (`shim.js`). Dev tooling only: none of this ships in the package.
 */

/** What one intercepted call returns to the caller. */
export interface ShimResult {
  /** Process exit code. */
  code: number
  /** Text to write to stdout. */
  out?: string
  /** Text to write to stderr. */
  err?: string
  /** Short human note, recorded in `calls.jsonl` and shown by `hyp-sandbox calls`. */
  note?: string
}

/** One bootstrapped LaunchAgent in the mock launchd domain. */
export interface SandboxService {
  label: string
  plist: string
  /** The supervisor's pid, or null when the mock recorded the bootstrap without spawning. */
  pid: number | null
  loadedAt: string
  /** True when a KeepAlive supervisor is watching the program. */
  supervised?: boolean
}

/** The mock launchd domain: bootstrapped services plus the user environment. */
export interface SandboxLaunchdState {
  services: Record<string, SandboxService>
  env: Record<string, string>
}

/** One certificate trusted in the mock login keychain. */
export interface SandboxCert {
  /** Common name, read with `openssl` when it is available. */
  cn: string | null
  path: string
  sha256: string
  keychain: string
  trusted: boolean
  addedAt: string
}

/** The mock login keychain. */
export interface SandboxKeychainState {
  certs: SandboxCert[]
}

/** One systemd user unit in the mock. */
export interface SandboxUnit {
  enabled: boolean
  active: boolean
  changedAt: string
}

/** The mock systemd user manager. */
export interface SandboxSystemdState {
  units: Record<string, SandboxUnit>
}
