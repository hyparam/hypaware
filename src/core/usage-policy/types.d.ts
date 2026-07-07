// Shared types for the `.hypignore` folder-scoped usage policy.
// See LLP 0049 (spec), LLP 0050 (enforcement decision), LLP 0052 (design).

// V1 ships `ignore`; `local-only` is reserved (LLP 0051) and `full` is the
// implicit default when nothing governs (LLP 0049 #classes).
export type UsageClass = 'ignore' | 'local-only' | 'full'

// The result of parsing a single `.hypignore` body. `declared` is the raw
// token read before the fail-safe; `warn` is present only when the declared
// token was unknown/unimplemented and was clamped to `ignore`.
export interface ParseResult {
  class: UsageClass
  declared: string | null
  warn?: string
}

// The result of resolving a `cwd` against the nearest governing `.hypignore`.
// `class` is the resolved, implemented class (`full` when nothing governs);
// `governedBy` is the absolute path of the nearest governing file, or null;
// `declared` is the raw token before fail-safe (null when nothing governs or
// the file was empty/comment-only); `warn` is carried from the parse and is
// present only on a fail-safe clamp, so adapters can warn on it (R3).
export interface ResolveResult {
  class: UsageClass
  governedBy: string | null
  declared: string | null
  warn?: string
}

export interface UsagePolicyResolver {
  resolve(cwd: string): ResolveResult
  isIgnored(cwd: string): boolean
}

// On-disk shape of the machine-local `local-only` directory list
// (`<stateDir>/usage-policy/local-only.json`, LLP 0071). `dirs` is a
// normalized (absolute, deduplicated, sorted) set of directory paths; a
// listed path need not exist on disk or be a git repo (LLP 0069 R4).
export interface LocalOnlyListFile {
  version: 1
  dirs: string[]
}

// Terminal sentinel an adapter's exchange projector returns to express an
// intentional `.hypignore` usage-policy drop (the exchange must never be
// recorded). Distinct from a bare `undefined` "this projector declined" return
// so the gateway dispatcher stops the projector walk on it and logs it as a
// privacy drop, not a `no_projector_match` miss (LLP 0050). Compared by
// reference identity against the `USAGE_POLICY_DROP` singleton.
export interface UsagePolicyDrop {
  readonly usagePolicyDrop: true
}
