import type {
  PluginManifest,
  PluginSourceSpec,
  PluginLockEntry,
  PluginLockFile,
} from '../../../hypaware-plugin-kernel-types.d.ts'

export type ConfirmOutcome = 'confirmed' | 'auto_yes' | 'rejected' | 'non_tty_no_yes'

export interface ConfirmDecision {
  proceed: boolean
  outcome: ConfirmOutcome
}

/**
 * Snapshot of everything the prompt needs to make a trust decision.
 * Built up by `fetchGitSource` immediately before the artifact swap so
 * the user sees the actual commit and hashes that would land on disk.
 */
export interface StagedArtifact {
  manifest: PluginManifest
  source: PluginSourceSpec
  resolvedRef: string
  contentHash: string
  manifestHash: string
}

export type FetchErrorKind =
  | 'local_dir_missing'
  | 'local_dir_invalid'
  | 'manifest_invalid'
  | 'manifest_name_mismatch'
  | 'fetch_unsupported'
  | 'git_unavailable'
  | 'git_clone_failed'
  | 'git_checkout_failed'
  | 'git_ref_not_found'
  | 'git_subdir_missing'
  | 'git_subdir_unsupported'
  | 'entrypoint_invalid'
  | 'artifact_symlink_unsupported'
  | 'artifact_copy_failed'
  | 'lock_write_error'
  | 'remote_install_confirmation_required'
  | 'remote_install_rejected'

export interface FetchSuccess {
  ok: true
  manifest: PluginManifest
  installDir: string
  contentHash: string
  manifestHash: string
  resolvedRef?: string
  provenance?: { host?: string; owner?: string; repo?: string }
}

export interface FetchFailure {
  ok: false
  errorKind: FetchErrorKind
  message: string
}

export type FetchResult = FetchSuccess | FetchFailure

export type GitFetchErrorKind =
  | 'git_unavailable'
  | 'git_clone_failed'
  | 'git_checkout_failed'
  | 'git_ref_not_found'
  | 'git_subdir_missing'
  | 'git_subdir_unsupported'
  | 'manifest_invalid'
  | 'manifest_name_mismatch'
  | 'entrypoint_invalid'
  | 'artifact_symlink_unsupported'
  | 'artifact_copy_failed'
  | 'lock_write_error'
  | 'remote_install_confirmation_required'
  | 'remote_install_rejected'

export interface GitFetchSuccess {
  ok: true
  manifest: PluginManifest
  installDir: string
  contentHash: string
  manifestHash: string
  resolvedRef: string
  provenance: { host?: string; owner?: string; repo?: string }
}

export interface GitFetchFailure {
  ok: false
  errorKind: GitFetchErrorKind
  message: string
}

export type GitFetchResult = GitFetchSuccess | GitFetchFailure

export type BeforeCommitCallback = (
  staged: GitFetchStaged,
) => Promise<{ proceed: boolean; errorKind?: GitFetchErrorKind; message?: string }>

/**
 * Snapshot of a fetched-but-not-yet-installed artifact. Passed to the
 * `beforeCommit` callback so a CLI front-end can prompt the user (or
 * enforce `--yes`) immediately before the rename swap that places the
 * artifact into the kernel install root. Mirrors the public
 * `StagedArtifact` shape in `confirm.js` but kept structurally typed
 * to avoid the cross-module import for callers that just want hashes.
 */
export interface GitFetchStaged {
  manifest: PluginManifest
  resolvedRef: string
  contentHash: string
  manifestHash: string
  provenance: { host?: string; owner?: string; repo?: string }
}

export interface GitSourceParts {
  /** HTTPS-normalized clone URL (or untouched for non-GitHub sources) */
  gitUrl: string
  /** Ref parsed from a `#fragment`, if present */
  ref?: string
  /** GitHub owner segment (for telemetry / lock provenance) */
  owner?: string
  /** GitHub repo segment (for telemetry / lock provenance) */
  repo?: string
  /** URL host (for telemetry) */
  host?: string
}

export interface InstallSuccess {
  ok: true
  entry: PluginLockEntry
  lock: PluginLockFile
  confirmation?: ConfirmOutcome
}

export interface InstallFailure {
  ok: false
  errorKind: string
  message: string
  confirmation?: ConfirmOutcome
}

export type InstallResult = InstallSuccess | InstallFailure

export type ConfirmInstall = (staged: {
  manifest: PluginManifest
  source: PluginSourceSpec
  resolvedRef: string
  contentHash: string
  manifestHash: string
  previous?: PluginLockEntry
}) => Promise<{ proceed: boolean; outcome: ConfirmOutcome }>
