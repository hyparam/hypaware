// @ts-check

// The shared grep-search surface (resolved as `hypaware/core/search`).
// The client and the server both import these: one column allowlist, one
// matcher, one hit shape, so a query that finds nothing here would find
// nothing there for the same reason (LLP 0264 #shared).

export { SCAN_COLUMNS, SEARCHABLE_COLUMNS } from './searchable_columns.js'
export {
  MAX_MATCH_COLUMNS,
  MAX_QUERY_LENGTH,
  SNIPPET_AFTER,
  SNIPPET_BEFORE,
  compileMatcher,
  makeSnippet,
} from './matcher.js'
