// @ts-check

// Public API for the `.hypignore` folder-scoped usage policy (LLP 0049/0050/0052).
// The shared, cwd-agnostic matcher lives in core; the Claude/Codex adapters
// import it exactly as they import `src/core/observability`.
export { parseHypignore } from './format.js'
export { createUsagePolicyResolver } from './matcher.js'
// Repo-root resolution for the `hyp ignore` CLI (LLP 0049 #cli): place a
// single repo-wide `.hypignore` at the git toplevel.
export { findRepoRoot } from './repo_root.js'
