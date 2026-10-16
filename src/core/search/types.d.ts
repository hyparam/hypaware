/**
 * The grep-search wire shapes, shared with the server so the local verb
 * and `--remote` answer in the same shape (LLP 0264 #shared).
 */

/**
 * The caller-supplied search parameters, identical on every serving
 * surface: `hyp query grep` locally, the `grep_search` MCP tool, and the
 * same tool spoken to a server through `--remote`. Server-side wrappers
 * extend this with their own routing fields (`org`); those never ride
 * the wire from a client.
 */
export interface GrepSearchParams {
  query: string
  regex?: boolean
  sessionId?: string
  chainId?: string
  from?: string
  to?: string
  limit: number
}

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
 * Two INDEPENDENT completeness facts, never one collapsed into the other.
 *
 * `truncated`: the limit cut the answer (more matches exist; narrow with
 * `from`/`to` or a tighter query). `exhausted`: the walk covered
 * everything that could have changed the answer, so what came back is what
 * a complete search would have returned for this limit.
 *
 * A search can be both truncated and unexhausted, and the two then call for
 * different things: a wider limit reaches the matches the limit cut, and
 * nothing reaches the files an aborted walk never opened. A consumer that
 * reads only one of them tells its caller the wrong half.
 *
 * A walk that stops early having PROVED the remainder cannot enter the
 * answer (the client's day-descending break) is exhausted: no file it
 * skipped could have displaced a returned hit.
 */
export interface GrepSearchResult {
  hits: GrepSearchHit[]
  truncated: boolean
  exhausted: boolean
}

/**
 * The seam a host-supplied backend receives: everything `GrepSearchParams`
 * carries, plus the one local-only caller parameter that rides the seam.
 *
 * @ref LLP 0353#seam [implements]: the backend contract carries caller
 * intent only, never host wiring (no `storage`, `refresh`, `callerCwd`, or
 * `signal`)
 */
export interface GrepSearchBackendArgs extends GrepSearchParams {
  /**
   * Local-only results the caller asked to include. The local backend
   * honors it; a serving backend MUST refuse it explicitly, raising
   * `GrepQueryError`, when true, because with one shared schema it now
   * validates everywhere and a silent ignore would change its meaning
   * (LLP 0353#backend-contract).
   */
  includeLocalOnly?: boolean
}

/**
 * A host-supplied grep-search data plane (LLP 0314). `queryGrepVerb` calls
 * whichever backend `VerbOperationContext.search` resolves to instead of
 * assuming the local cache service, so a host owning a different data
 * plane answers `grep_search` without registering a second verb.
 *
 * A conforming backend (LLP 0353#backend-contract):
 * - Accepts `GrepSearchBackendArgs` and returns `GrepSearchResult`: the
 *   shared hit shape, hits sorted as LLP 0264 fixes them, and the two
 *   INDEPENDENT completeness facts `truncated` and `exhausted` with the
 *   meanings documented on `GrepSearchResult` above. Extra fields beyond
 *   the shared shape are permitted; the render treats each as optional.
 * - Searches exactly the columns the kernel's published
 *   `SEARCHABLE_COLUMNS` (`hypaware/core/search`) names. Coverage is
 *   asserted equal at wiring time by the host that builds the backend;
 *   the seam carries no `searchableColumns` override field, ever (LLP
 *   0353#summary-drift).
 * - Raises its own refusals (a gated `regex`, an unsupported
 *   `includeLocalOnly: true`, a malformed pattern, ...) as
 *   `GrepQueryError`, importable from `hypaware/core/search`. Any
 *   serving backend must explicitly refuse `includeLocalOnly: true` this
 *   way, since it has no local plane to honor it against. Anything else
 *   thrown is an ordinary failed search, not a usage refusal.
 * - Never throws for an empty answer: zero hits with `exhausted: true`
 *   is itself the answer, and the summary's coverage clause is what
 *   keeps that answer honest.
 */
export interface GrepSearchBackend {
  (args: GrepSearchBackendArgs): Promise<GrepSearchResult>
}

/**
 * A compiled grep query: `hypQuery` feeds hypgrep's index pruning,
 * `test`/`locate` run per cell (locate finds the snippet window),
 * `rowTest` is the whole-row predicate the scan paths share. The cell
 * entry points take `unknown` because a row cell is not always text, and
 * every one of them renders it the same way, so a cell `rowTest` accepted
 * cannot then miss here.
 */
export interface GrepSearchMatcher {
  hypQuery: string | RegExp
  test(value: unknown): boolean
  locate(value: unknown): { index: number; length: number }
  rowTest(row: Record<string, unknown>): boolean
}
