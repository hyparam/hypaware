/**
 * The grep-search wire shapes, shared with the server so the local verb
 * and `--remote` answer in the same shape (LLP 0264 #shared).
 */

/** One matching message row, projected to locators plus bounded snippets. */
export interface GrepSearchHit {
  date: string
  sessionId: string
  agentId: string | null
  conversationId: string | null
  partId: string | null
  messageId: string | null
  messageCreatedAt: string | null
  matches: { column: string; snippet: string }[]
}

/**
 * `truncated`: the limit cut the answer (more matches exist; narrow with
 * `from`/`to` or a tighter query). `exhausted`: every candidate file was
 * walked to completion.
 */
export interface GrepSearchResult {
  hits: GrepSearchHit[]
  truncated: boolean
  exhausted: boolean
}

/**
 * A compiled grep query: `hypQuery` feeds hypgrep's index pruning,
 * `test`/`locate` run per string cell (locate finds the snippet window),
 * `rowTest` is the whole-row predicate the scan paths share.
 */
export interface GrepSearchMatcher {
  hypQuery: string | RegExp
  test(value: string): boolean
  locate(value: string): { index: number; length: number }
  rowTest(row: Record<string, unknown>): boolean
}
