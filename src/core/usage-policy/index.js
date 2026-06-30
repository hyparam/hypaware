// @ts-check

// Public API for the `.hypignore` folder-scoped usage policy (LLP 0049/0050/0052).
// The shared, cwd-agnostic matcher lives in core; the Claude/Codex adapters
// import it exactly as they import `src/core/observability`.
export { parseHypignore } from './format.js'
export { createUsagePolicyResolver } from './matcher.js'
