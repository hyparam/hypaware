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
// (LLP 0050/0070): the nearest governing `.hypignore`, and, when the
// resolver was constructed with `localOnlyListPath`, the machine-local
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
  /**
   * Cheap stable digest of the resolver's mutable machine-local input (the
   * LLP 0071/0103 list file), for consumers that must notice a policy change
   * without re-reading history (LLP 0367 #policy-fingerprint). Optional so a
   * hand-built test resolver without it behaves as a constant policy.
   *
   * Not pure: reading the bytes is also how the resolver notices that its
   * memoized verdicts predate them, so this call drops the ones they have
   * outlived. A consumer that will act on `resolve`'s verdicts must therefore
   * call this first, or it can stamp a digest over verdicts computed under
   * the policy that digest already replaced (hyparam/hypaware#1317).
   */
  fingerprint?(): string
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
// dotfile. An explicit `full` entry is not the same as "unlisted": it
// records "asked; syncs" so the classification hook (LLP 0106) can tell
// "answered" from "never asked".
export interface LocalOnlyEntry {
  dir: string
  class: UsageClass
}

// A machine-local list entry paired with every spelling of its declared `dir`
// that the gate compares through, and the case-sensitivity verdict for the
// volume that directory lives on. Computed once per list parse per TTL window,
// so resolving many `cwd`s in one window canonicalizes and folds each entry
// once rather than once per `cwd`.
//
// The two spelling sets are what the matcher's two passes compare against.
// `declaredSpellings` is the single spelling the user declared, unfolded: the
// rule the matcher applied before either widening existed. `widenedSpellings`
// is `canonicalSpellings(dir)` (as-given plus symlink-resolved, LLP 0050
// §canonicalization), folded when `folded` is set (LLP 0050 §normalization).
//
// `folded` is true for the gate's scopes and false for the one-shot CLI
// helpers', because unconditional NFC folding is sound only where widening is
// free, which is the gate and not a deletion or disclosure predicate.
// `caseInsensitive` is false on every non-darwin host, on any volume whose probe
// was undetermined, and on every unfolded scope; it is carried because the `cwd`
// side has to be folded through the *same* verdict for the comparison to mean
// anything.
export interface ListScope {
  entry: LocalOnlyEntry
  folded: boolean
  caseInsensitive: boolean
  declaredSpellings: string[]
  widenedSpellings: string[]
}

// Version-2 on-disk shape of the machine-local list (LLP 0103): the
// class-per-entry store that replaces the version-1 bare `dirs` array.
export interface LocalOnlyListFileV2 {
  version: 2
  entries: LocalOnlyEntry[]
}

// A single record in the machine-local per-client sync opt-out list
// (`<stateDir>/usage-policy/client-sync.json`, LLP 0188). `source` is a
// picker source id (the same id space the withhold seam matches row
// attribution against); `class` is fixed to `local-only` today and exists
// for shape symmetry with `LocalOnlyEntry`. On an enrolled machine every
// configured source syncs by default; a listed source is withheld at the
// export seam unless it classifies `central` (org-configured sources cannot
// be opted out, LLP 0188 #locked).
export interface ClientSyncEntry {
  source: string
  class: 'local-only'
}

// The machine-local answer to "should a session opened in an unclassified
// folder be asked to classify it?" (LLP 0200, extending LLP 0106). `sync` is
// the default (LLP 0200 #default): the user has answered that question
// standing, unclassified folders keep the implicit `full` default (they
// sync), and the hook stays quiet. `ask` is the opt-in half and is LLP 0106
// as it shipped: one session-start question per new folder. Only the ask is
// gated either way - `.hypignore` dotfiles, machine-local entries, and the
// export seam are untouched by it (LLP 0200 #suppression).
export type FolderAskMode = 'ask' | 'sync'

// On-disk shape of the machine-local folder-ask preference
// (`<stateDir>/usage-policy/folder-ask.json`, LLP 0200). File absence means
// `sync`, the product default, so a machine that never set it is never asked.
export interface FolderAskFile {
  version: 1
  mode: FolderAskMode
}

// Version-1 on-disk shape of the machine-local client-sync list (LLP 0188).
// File absence is meaningful (the upgrade-migration marker) and is NOT the
// same as an empty `entries` list; see `readClientSyncEntries`.
export interface ClientSyncListFile {
  version: 1
  entries: ClientSyncEntry[]
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
