// Type contracts for `hyp plugin doctor` / `hyp plugin new`.
//
// The doctor mirrors the advisory shape of `diagnoseV1Config`
// (src/core/config/validate.js): each finding is a structured record
// with a stable `kind`, a `location` pointer, a human `message`, and a
// list of `repair` hints. Agents consume the JSON form; humans read the
// rendered ✓/✗/⚠ lines.

export type DiagnosticSeverity = 'error' | 'warn'

/**
 * Stable identifiers for each check. Kept as a closed union so the
 * troubleshooting section of docs/PLUGIN_AUTHORING.md can document one
 * fix per kind and tests can assert on them.
 */
export type PluginDiagnosticKind =
  | 'manifest_invalid'
  | 'entrypoint_missing'
  | 'semver_invalid'
  | 'name_convention'
  | 'contributes_malformed'
  | 'entrypoint_import_failed'
  | 'activate_missing'
  | 'activate_threw'
  | 'contribution_not_registered'
  | 'contribution_undeclared'
  | 'capability_unresolved'
  | 'capability_unprovided'

export interface PluginDiagnostic {
  kind: PluginDiagnosticKind
  severity: DiagnosticSeverity
  /** Where the problem lives: a manifest pointer, a file path, or a contribution id. */
  location: string
  message: string
  /** Ordered, copy-pasteable fixes (commands, code snippets, doc anchors). */
  repair: string[]
}

export interface DoctorReport {
  /** True when there are no `error`-severity diagnostics (warnings are allowed). */
  ok: boolean
  /** Manifest name when it could be parsed; absent when the manifest itself failed. */
  pluginName?: string
  rootDir: string
  diagnostics: PluginDiagnostic[]
  errorCount: number
  warnCount: number
}

/** Normalized snapshot of what a dry-run `activate()` actually registered. */
export interface RegisteredSnapshot {
  sources: string[]
  sinks: string[]
  datasets: string[]
  commands: string[]
  skills: string[]
  init_presets: string[]
  capabilities: string[]
}

export interface DryRunResult {
  /** True when the entrypoint imported and `activate()` resolved without throwing. */
  ok: boolean
  /** Set when import or activate threw, or when `activate` was not a function. */
  error?: { kind: 'entrypoint_import_failed' | 'activate_missing' | 'activate_threw'; message: string }
  /** Always present (empty when the dry run never reached activation). */
  registered: RegisteredSnapshot
}

export type ScaffoldKind = 'source' | 'sink' | 'dataset'

export interface ScaffoldResult {
  pluginName: string
  slug: string
  pluginDir: string
  files: string[]
}
