// Shared types for the `.hypignore` folder-scoped usage policy.
// See LLP 0049 (spec), LLP 0050 (enforcement decision), LLP 0052 (design).

// V1 shipped `ignore`; `local-only` was reserved (LLP 0051) and is now
// implemented (LLP 0070/0080) via both the `.hypignore` dotfile token and the
// machine-local list (LLP 0071); `full` is the implicit default when nothing
// governs (LLP 0049 #classes).
export type UsageClass = 'ignore' | 'local-only' | 'full'

// The result of parsing a single `.hypignore` body. `declared` is the raw
// token read before the fail-safe; `warn` is present only when the declared
// token was unknown/unimplemented and was clamped to `ignore`.
export interface ParseResult {
  class: UsageClass
  declared: string | null
  warn?: string
}

// The result of resolving a `cwd` against the shared usage-policy resolver
// (LLP 0050/0070): the nearest governing `.hypignore`, and — when the
// resolver was constructed with `localOnlyListPath` — the machine-local
// `local-only` list (LLP 0071), whichever verdict is more restrictive.
// `class` is the resolved, implemented class (`full` when nothing governs);
// `governedBy` is the absolute path of the governing source (a `.hypignore`
// file, the `local-only` list file, or null when nothing governs); `declared`
// is the raw token before fail-safe (`'local-only'` for a list-governed
// result; null when nothing governs or the file was empty/comment-only);
// `warn` is carried from the `.hypignore` parse and is present only on a
// fail-safe clamp, so adapters can warn on it (R3).
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
// Superseded by `LocalOnlyListFileV2` (LLP 0103): a bare `dirs` array
// migrates on read as all-`local-only` entries, exactly what it meant here.
export interface LocalOnlyListFile {
  version: 1
  dirs: string[]
}

// A single class-per-entry record in the machine-local list (LLP 0103):
// `dir` is normalized absolute; `class` is the explicit usage class the user
// (or a review flow) assigned this directory, independent of any `.hypignore`
// dotfile. An explicit `full` entry is not the same as "unlisted" — it
// records "asked; syncs" so the classification hook (LLP 0106) can tell
// "answered" from "never asked".
export interface LocalOnlyEntry {
  dir: string
  class: UsageClass
}

// Version-2 on-disk shape of the machine-local list (LLP 0103): the
// class-per-entry store that replaces the version-1 bare `dirs` array.
export interface LocalOnlyListFileV2 {
  version: 2
  entries: LocalOnlyEntry[]
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
