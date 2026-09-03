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
   * ISO timestamp of the first failure in the current unbroken run of
   * them. Bounds how long a probe failure may stay out of the status
   * line; cleared by the next successful probe.
   */
  error_since?: string
  /**
   * Cached effective `auto_update` config flag, written by the booted
   * daemon so the import-light pre-boot lane never parses config layers.
   */
  auto_update?: boolean
  /**
   * Version the daemon loaded at boot, written beside `auto_update`. The
   * global root can move ahead of it without a restart; the pass compares
   * both so a stale daemon still gets its restart.
   */
  running_version?: string
  /**
   * A version that was installed and could not run here (its entrypoint
   * failed preflight, or boots on it kept failing). Never installed again;
   * cleared by a probe that finds something newer.
   */
  held_version?: string
  /**
   * Consecutive boots on `last_apply.to` that never reached the kernel,
   * counted by the pre-boot lane and reset to 0 by a daemon whose kernel
   * came up.
   */
  boot_failures?: number
  /** Record of the most recent apply attempt. */
  last_apply?: {
    at: string
    from: string
    to: string
    ok: boolean
    error?: string
    /** Tail of npm's stderr (or the preflight failure) when `ok` is false. */
    detail?: string
    /** True once `from` was reinstalled over a `to` that could not run. */
    rolled_back?: boolean
    rolled_back_at?: string
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
