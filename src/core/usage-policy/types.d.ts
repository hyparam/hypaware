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
// the file was empty/comment-only).
export interface ResolveResult {
  class: UsageClass
  governedBy: string | null
  declared: string | null
}

export interface UsagePolicyResolver {
  resolve(cwd: string): ResolveResult
  isIgnored(cwd: string): boolean
}
