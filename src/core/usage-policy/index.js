// @ts-check

// Public API for the `.hypignore` folder-scoped usage policy (LLP 0049/0050/0052).
// The shared, cwd-agnostic matcher lives in core; the Claude/Codex adapters
// import it exactly as they import `src/core/observability`.
export { parseHypignore } from './format.js'
export { createUsagePolicyResolver, isEqualOrDescendant } from './matcher.js'
// The terminal capture-seam drop sentinel (LLP 0050): an adapter projector
// returns it for an `.hypignore`-ignored exchange, and the gateway dispatcher
// stops on it (never falls through to a later projector) and logs it as a drop.
export { USAGE_POLICY_DROP, isUsagePolicyDrop } from './drop.js'
// Repo-root resolution for the `hyp ignore` CLI (LLP 0049 #cli): place a
// single repo-wide `.hypignore` at the git toplevel.
export { findRepoRoot } from './repo_root.js'
// The machine-local `local-only` directory list (LLP 0071): a single
// `HYP_HOME`-state JSON file, distinct from the committable `.hypignore`
// dotfile. Read by the export-seam resolver and `hyp status`, written by the
// login picker and the `hyp ignore --local-only` durable authoring command.
export {
  localOnlyListPath,
  readLocalOnlyDirs,
  writeLocalOnlyDirs,
  LocalOnlyListUnreadableError,
  LOCAL_ONLY_LIST_UNREADABLE_ERROR_KIND,
} from './local_only.js'
