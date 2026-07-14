# LLP 0105: query results honor the caller's usage class

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Usage-Policy, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0015, LLP 0034, LLP 0049, LLP 0050, LLP 0066, LLP 0070, LLP 0100, LLP 0106

> `local-only` rows are filtered out of query, graph, and MCP results when
> the **querying context** is itself a synced one. The invariant: content may
> only surface in a context at least as non-exported as the content itself.
> Extends [LLP 0070](./0070-local-only-export-seam.decision.md)'s "stays
> locally queryable": queryable from private contexts, filtered elsewhere.
>
> @ref LLP 0070 [constrained-by] - the export seam still withholds; this closes the second-order path around it.
> @ref LLP 0049#requirements [constrained-by] - R4's one-shared-resolver rule: the caller-class check is the same resolver, applied at a third seam.

## Context: the transcript leak

[LLP 0070](./0070-local-only-export-seam.decision.md) deliberately keeps the
local query path unfiltered, and that is still right in isolation. But a
query often runs *inside a captured session*: a user in `~/work/repo`
(synced) invokes the `hypaware-query` skill, and rows from `~/side-project`
(`local-only`) come back **as tool results in the transcript**. That
transcript is itself a captured exchange whose `cwd` is the synced folder,
so at the next export tick the `local-only` content ships to the org server
inside someone else's session. The export seam never sees it coming; the
rows it withholds are not the rows that leaked. Graph queries have the same
hole wherever node or edge properties carry content.

## Decision

**Every content-bearing read surface consults the shared resolver twice: once
per row (the data's class) and once for the caller (the querying context's
class), and excludes `local-only` rows unless the caller's context is itself
non-exported.**

- **The test is "is this transcript exported?", not class equality** {#test}:
  a caller whose `cwd` resolves to `local-only` sees everything (its
  transcript never leaves the machine); so does one in an `ignore`d directory
  (its transcript is never even recorded). A caller resolving to `full` gets
  `local-only` rows excluded. On the restrictiveness lattice: include iff
  caller class >= row class.
- **Coverage** {#surfaces}: `hyp query`, `hyp graph`, and the kernel-intrinsic
  MCP host ([LLP 0034](./0034-mcp-endpoint-from-base.decision.md) family),
  funneled through one filter at the shared query read path, never
  reimplemented per command ([LLP 0049 R4](./0049-hypignore-usage-policy.spec.md#requirements)
  spirit; the export seam did the same,
  [LLP 0070 §resolver](./0070-local-only-export-seam.decision.md#resolver)).
- **Unknown caller excludes** {#unknown}: when no caller `cwd` is derivable
  (an MCP request that carries none), `local-only` rows are excluded. This is
  the mechanical backstop, not the intended UX: the classification hook
  ([LLP 0106](./0106-session-start-classification-hook.decision.md)) exists
  so interactive contexts are always classified, and the MCP plumbing should
  carry the caller's `cwd` so the case stays rare. The opposite polarity
  would let the one failure this decision exists to prevent happen silently.
- **Explicit override** {#override}: `--include-local-only` on the query
  verbs, for the human at a bare terminal who wants their own data regardless
  of which directory they are standing in. Informed consent: the help text
  names the transcript-capture consequence, and the bundled skills never pass
  it.

## Scope honesty {#scope}

This governs HypAware's own read surfaces. An agent `Read`ing a `local-only`
*file* into a synced transcript, or a user pasting one, is outside any
mechanism this project can offer; the docs and the privacy skill say so
rather than implying otherwise.

## Open question for the design doc {#graph-provenance}

Graph projection tables aggregate across sessions; nodes and edges may lack
per-row `cwd` provenance today. Filtering them correctly needs either
propagated provenance columns in the projection or suppression of
content-bearing properties on mixed-provenance rows. Which, and at what
projection cost, is a design-doc question; the invariant above is the
constraint it must satisfy.

## Consequences

- A synced-context transcript can no longer contain `local-only` content via
  hyp surfaces, so the export seam's guarantee becomes end-to-end rather
  than first-order.
- Queries from private contexts lose nothing; the common case (querying your
  own work in the directory you are working in) is unchanged.
- Result counts can differ between contexts for the same query. `hyp query`
  should say when rows were withheld (a count, never the content), keeping
  the never-silent ethos.
