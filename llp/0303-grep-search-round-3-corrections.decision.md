# LLP 0303: The grep search stack after review round 3

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache, CLI, MCP
**Author:** neutral
**Date:** 2026-08-24
**Extends:** LLP 0302 (#residuals), LLP 0264 (#shared), LLP 0265 (T6)
**Extended-by:** [LLP 0304](./0304-grep-search-round-4-corrections.decision.md) (#scratch-sweep moves out of the build pass, because gating it on missing coverage made it unreachable in the case it was written for; #memory-bound holds on the scan tier only, and the indexed tier's raw bound is named honestly)
**Related:** LLP 0199 (the neediest-first maintenance walk), LLP 0293 (#one-contract: exit 2 is the usage code), LLP 0105 (local-only visibility); hypaware-server LLP 0178 / PR #364 (merged)

> [LLP 0302](./0302-grep-search-integration-divergences.decision.md) recorded
> what the shipped `hyp query grep` does differently from the design, and left
> a `#residuals` list. This records the round that closed most of that list,
> the two rules the closing changed, and the one open question it answered with
> evidence rather than a patch.

## Truncation and walk completion are two facts {#completeness-signals}

`executeGrepSearch` returned `exhausted: exhausted && !truncated`, folding two
independent facts into one field. The shipped `hypaware-query` skill teaches
them as separate, and they call for different things: a wider `--limit` reaches
the matches the limit cut, and **nothing** reaches the files a walk never
opened. Folded, a search that both filled its limit and aborted mid-walk
reported only "raise `--limit`", advice that cannot recover the unread files,
and the verb's renderer compounded it by choosing between the two notices with
an `else if`. An MCP caller reading `exhausted` lost the same distinction.

So, without changing the mirrored `GrepSearchResult` shape:

- `exhausted` is the walk-completion fact alone. `truncated` is the limit fact
  alone. Both can be true.
- The renderer prints each notice for its own fact, never one instead of the
  other.
- The day-descending early break does **not** clear `exhausted`. It stops the
  walk only once the buffer holds hits strictly newer than every file left, so
  the answer it produced is the answer a complete walk would have produced.
  Reporting it as unexhausted would have fired "results may be incomplete" on
  every ordinary capped search, which is the one place that line must not
  appear. What the caller learns from a break is `truncated`, which carries
  advice a caller can act on.

`GrepSearchResult`'s own doc comment already described the unfolded meaning, so
this is the code catching up to the interface rather than a new contract. The
server computes its own `exhausted`; the field name, type and doc are the
shared part, and aligning the server's computation with the doc is a follow-up,
not a gate (nothing renders both answers side by side).

## An unusable query is a usage refusal at every surface {#query-refusal-exit}

LLP 0302 `#usage-exit` moved the day-flag refusals to exit 2 and left one
behind: an invalid `--regex` pattern, and a pattern past `MAX_QUERY_LENGTH`,
still exited 1. Both are the caller's argument mistake in exactly the sense
[LLP 0293 #one-contract](./0293-core-command-argument-validation.decision.md#one-contract)
settles, so `hyp query grep '(' --regex` answering 1 tells a script that retries
on 1 and reports on 2 to retry a typo forever.

It stayed because the refusal is raised inside `matcher.js`, which
[LLP 0264 #shared](./0264-grep-search-mirrors-the-server.decision.md#shared)
makes a module the server imports too, and a shared module must not import a
CLI error class.

The seam is a refusal **kind**, not a refusal code. `matcher.js` raises
`GrepQueryError` for a query the search cannot use, and each surface maps that
kind into its own vocabulary: the verb translates it to `VerbUsageError` (exit
2 with the usage line), and a serving surface can map the same kind to 400
rather than 500. Which refusals belong to the caller is part of what "the same
query means the same thing on every tier" has to cover, so the kind belongs in
the shared module even though the code does not.

## The memory bound needs the reader, not only the split {#memory-bound}

> **Extended-by:** [LLP 0304 #indexed-tier-residency](./0304-grep-search-round-4-corrections.decision.md#indexed-tier-residency).
> The bound below holds on the scan tier. On the indexed tier `parquetFind`
> wraps the buffer in hyparquet's memoizing `cachedAsyncBuffer`, so the raw
> residency there is the union of the candidate ranges, not one row group.

The brute scan was changed to read one row group at a time, which bounds the
DECODED rows. It does not bound the raw bytes: the cache's own
`resolver.reader` is `fs.readFileSync` of the whole file, so a 128 MiB
`target_file_bytes` data file was fully resident behind a walk that read it a
row group at a time, and the read itself blocked the event loop.

Both tiers now open the source data file through hyparquet's
`asyncBufferFromFile`, which fetches per slice. The projection's own byte
ranges are then all that is ever read: strictly less IO than the whole file,
none of it synchronous, and the module's stated bound (one row group, plus the
index on the indexed tier) is true rather than aspirational.

The **sidecar** deliberately stays on the resident reader. It is the pruning
structure, read in many small random ranges by hypgrep's `queryIndex`, and a
fraction of the size of the file it indexes; the 128 MiB file the bound is
about is the source.

## The build pass gets a share of the tick, not its tail {#build-share}

LLP 0302 `#build-site` budgeted the build pass by handing it the maintenance
tick's own deadline. That bounds the tick but not the **walk**: partitions are
visited neediest-first
([LLP 0199 #neediest-first](./0199-maintenance-compaction-convergence.decision.md#neediest-first)),
so the busiest grep partition is visited first, arrives at a freshly compacted
generation with zero coverage, and can spend the tick's whole remaining tail
indexing it. Every partition behind it then gets no snapshot expiry and no
compaction, that tick and every tick after, because the busy partition keeps
taking writes. Nothing else in the loop has that shape: compaction is gated on
a due verdict, so a healthy partition costs nearly nothing.

The pass is capped at a fraction of the tick's budget per partition
(`GREP_INDEX_TICK_SHARE`). Coverage still advances on a busy cache because the
pass always attempts its first missing file, which is the same guarantee
`maintainCache` gives itself by always working one partition.

Two reporting rules fall out of the same pass:

- `sidecarsFailed` counts work this pass attempted and lost. A **quarantined**
  file is skipped without a build, so it is counted separately
  (`sidecarsQuarantined`); folding the two made a partition holding one
  poisoned file report a fresh failure on every later tick.
- A quarantined file keeps the caller's coverage gate permanently short, so the
  pass short-circuits on a directory read when every missing sidecar is
  quarantined, rather than paying a metadata load per tick for the life of the
  generation to rediscover there is nothing to do.

## Publish scratch is swept, past a grace window {#scratch-sweep}

> **Extended-by:** [LLP 0304 #scratch-sweep-site](./0304-grep-search-round-4-corrections.decision.md#scratch-sweep-site).
> The sweep belongs to the maintenance caller, not to the build pass: gated on
> missing coverage it never ran again once the crashed build's sidecar was
> republished, which happens inside the grace window.

The sidecar publish is write-then-rename and its failure path unlinks its own
scratch, but a SIGKILL between the two (a shut-down daemon, an OOM kill) leaves
an index-sized file behind. Nothing removed it: the scratch name is outside
`.parquet` precisely so it joins no data-file count, which also means
`measureDataDir` does not bill its bytes and `hyp cache status` under-reports
the partition, and the scratch token is random, so each crash leaks a new file
rather than reusing one.

The build pass sweeps them, but only past a grace window. A build takes
seconds, and two writers over one cache (the daemon's tick and a hand-run
`hyp`) is the case the random token exists for, so an in-flight scratch must
never be pulled out from under its writer.

## Only a top-level column is indexable {#indexable-columns}

The index worker matched schema leaves by `element.name`, which is a leaf's own
name inside its parent, not its path from the root. Correct for today's flat
`ai_gateway_messages`, and a silent tier disagreement the moment a struct
carries a field called `model` or `cwd`: hypgrep would be handed a
`textColumns` entry naming something other than the top-level column
`SCAN_COLUMNS` projects and `rowTest` tests, so the index would prune to one
column while the scan tier tested another. Only depth-one string leaves are
indexable, which is exactly the set the read side can project.

## Unrestricted local `--regex` is reachable only from this machine {#regex-reachability}

LLP 0302 left `--regex` ungated locally, and the review that raised it made the
severity conditional: catastrophic backtracking is unbounded (V8 cannot
interrupt a running regex, so no deadline or abort signal reaches it), and
`grep_search` is registered on every host, so the question is whether a client
host's `grep_search` is reachable by anyone but the person at the terminal.

**It is not, at this head.** The kernel's only MCP transport is stdio
(`src/core/commands/mcp.js`), which refuses `--http` outright as a follow-up,
and stdio is local-user trust: the caller is the same person who could run
`hyp query grep` at the terminal, or any other command. So an unbounded regex
wedges a process its own author started, which is self-inflicted in the same
way an unbounded `hyp query sql` is. A server restricts regex mode to the
operator, and that asymmetry is correct rather than an oversight.

This is therefore **accepted by design, with a tripwire**, not a defect and not
an open question. The tripwire is precise, because the condition that flips it
is one line of future work: `grep_search` is `authClass: 'read'`, and
`createMcpServer` exposes read-class verbs to a query-scoped caller on a
non-stdio transport. **The change that lands an HTTP transport on a client host
is the change that must gate `--regex`**, by auth class or by moving the match
into the killable worker-thread seam the index build already uses. Neither is a
line in a verb, which is why neither was written speculatively here.

## What this does not settle {#residuals}

> **Extended-by:** [LLP 0304 #residuals](./0304-grep-search-round-4-corrections.decision.md#residuals).
> The dereferenced-data-file entry below is corrected there: the
> all-quarantined short-circuit does not cover it, so it still costs a full
> metadata load per tick rather than a directory read.

- **The server's `exhausted`.** `#completeness-signals` aligns the client with
  the field's documented meaning. Whether the server's own computation agrees
  is out of tree, and nothing renders both answers together, so it is a
  follow-up rather than a gate.
- **The server's import swap** onto this repo's shared allowlist and matcher
  modules, carried forward from LLP 0302 `#residuals`. `GrepQueryError` joins
  the set of shared names that swap has to pick up.
- **A data file dereferenced without a rewrite**, carried forward unchanged
  from LLP 0302 `#residuals`. It now costs a directory read per tick rather
  than a metadata load, because `#build-share`'s short-circuit runs first.
