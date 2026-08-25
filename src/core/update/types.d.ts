/** State persisted at `<stateRoot>/self-update.json` between checks. */
export interface SelfUpdateState {
  /** ISO timestamp of the last registry probe. */
  checked_at?: string
  /** Latest version the registry reported on the last probe. */
  latest_version?: string
  /** True when `latest_version` is newer than the installed version. */
  available?: boolean
  /** Probe or apply failure recorded for `hyp status`; absent when healthy. */
  error?: string
  /**
   * Cached effective `auto_update` config flag, written by the booted
   * daemon so the import-light pre-boot lane never parses config layers.
   */
  auto_update?: boolean
  /** Record of the most recent apply attempt. */
  last_apply?: {
    at: string
    from: string
    to: string
    ok: boolean
    error?: string
  }
}

/** Where the running code came from; only a global npm install may apply. */
export type SelfInstallProvenance = 'npx' | 'checkout' | 'global-candidate'

/** Outcome of one self-update pass. */
export interface SelfUpdatePassResult {
  action: 'none' | 'skipped' | 'checked' | 'updated'
  reason?: string
  latest?: string
}
