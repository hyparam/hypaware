# LLP 0616: Graph rows carry their source folders

**Type:** Spec
**Status:** Draft
**Systems:** Graph, Query, Usage-Policy, Plugins
**Author:** HypForge
**Date:** 2026-11-18
**Extends:** LLP 0105, LLP 0428
**Related:** LLP 0029, LLP 0049, LLP 0305, LLP 0388, LLP 0430, LLP 0431, LLP 0564

> A graph node or edge is shown to a caller only when every folder that
> contributed to it is one the caller may see. Rows that cannot say where
> they came from stay suppressed, as they are today.

## Problem {#problem}

[LLP 0105 #graph-provenance](./0105-query-seam-local-only-visibility.decision.md#graph-provenance)
left graph filtering as a design question. The shipped answer is the
fallback it named: graph tables have no `cwd`, so every content column
(`natural_key`, `label`, `props`, `source_keys`) is suppressed for any caller
below `ignore`. On a machine with no `local-only` folder at all, `hyp graph`
and `hyp query` over `graph_nodes` / `graph_edges` therefore show no names
(issue #3028: 24,034 nodes, 72,102 suppressed rows). The filter is correct
but useless for the common case. [LLP 0428 #visibility](./0428-graph-evidence-links.spec.md#visibility)
says making mixed-source labels shareable "requires a separate lineage
design". This is that design.

This change makes a privacy filter show more than it does today. Every rule
below is written to fail closed: where provenance is missing, partial or
mixed, the row stays suppressed.

## Provenance column {#column}

Each of `graph_nodes` and `graph_edges` gains one nullable column,
`source_cwds`: a JSON array of the distinct folder paths whose source rows
contributed to the written row, sorted, as recorded in the source rows'
`cwd`. It stores folders, not a verdict. A folder's class can change after
the row is written (a `.hypignore` is added, a folder is marked
`local-only`), and a stored verdict would go stale in the unsafe direction.
Classifying at read time means a folder that becomes `local-only` hides its
rows on the next query.

Three states:

- **`null`: unknown.** Rows written before this change, and any row with a
  contribution whose provenance cannot be stated (below). Suppressed, as today.
- **`[]`: folderless.** Every contribution came from a source whose rows any
  caller can already read raw. Visible.
- **A list.** Visible to a caller only when no listed folder's class outranks
  the caller (the LLP 0105 rank: `ignore` over `local-only` over `full`).

`source_cwds` is itself declared a content column. A folder path is
information: a `local-only` folder's name must not reach a syncing caller
through the column that exists to hide it. On a visible row it shows only
folders whose raw `cwd` the caller could already read.

## What a contribution carries {#contribution}

A graph row inherits, per contribution, the visibility the raw seam already
gives the source row it came from. Nothing here is more permissive than
reading the source table directly.

- **A source row with a `cwd`** (`ai_gateway_messages`) contributes that folder.
- **A source row in a `cwd` dataset with a null `cwd`** contributes nothing
  (`[]`). The raw seam passes such rows to every caller today, so the graph
  reveals nothing the table does not.
- **A source dataset with no `cwd` and no `localOnlyContentColumns`**
  (`github_events`, `linear_events`) contributes `[]`. Those rows are readable
  raw by every caller, and the GitHub inventory already admits only repos
  evidenced by export-eligible sessions ([LLP 0360 #inventory](./0360-github-source-is-bundled.decision.md#inventory)).
- **A source dataset that declares `localOnlyContentColumns`**
  (`enrichment_committed`) contributes unknown. Its own content is suppressed raw, so anything
  derived from it is too.
- **A projection rule whose output does not carry `cwd`** (a raw-SQL rule that
  aggregates it away) contributes unknown. A contract opts a rule in by
  selecting `cwd`; leaving it out is safe, not silent.

## Merge {#merge}

When the projection merges several contributions into one id (the
order-independent `mergeRow`, [LLP 0428 #claim-evidence](./0428-graph-evidence-links.spec.md#claim-evidence)),
`source_cwds` is the union of the contributions. Unknown absorbs: the union
of unknown with anything is unknown. The union is commutative and
idempotent, so merge order stays irrelevant.

A mixed row is one whose folders differ in class. Its rank is the highest
rank among its folders, so a row touched by both a `local-only` and a
syncing folder is suppressed for the syncing caller. Structure (ids, types,
`first_seen`, edge endpoints) stays visible, as it is today. Suppression is
not withholding: traversal keeps working, only names are hidden.

The column describes the written content, not every source that has ever
mentioned the id:

- **Default projection** stays append-only and skips existing ids
  ([LLP 0428 #refresh](./0428-graph-evidence-links.spec.md#refresh)). A skipped
  id is not rewritten, so its content and its `source_cwds` both still reflect
  the contributions at its first write. No rewrite is needed.
- **Incremental evidence** ([LLP 0564 #incremental-evidence](./0564-skill-evidence-updates.spec.md#incremental-evidence))
  adds to a committed row. Its new `source_cwds` is the union of the committed
  value and the new contributions. It never shrinks.
- **Any write that keeps part of the committed content** unions with the
  committed `source_cwds`. Only a write that re-derives the whole row from
  current sources may replace it.

Retention or purge can never make a row more visible: no path removes a
folder from a row that keeps content derived from it.

## Rows written before this change {#old-rows}

Old rows read the new column as null ([LLP 0029 #in-place-evolution](./0029-additive-cache-schema-evolution.decision.md#in-place-evolution))
and stay suppressed. Nothing rewrites them automatically: LLP 0428 #refresh
rules out version-triggered mutation.

`hyp graph project --refresh` re-derives matching rows of the same projector
from current sources, and a re-derived row gets its true `source_cwds`. A row
whose source rows were retained away is not re-derived and stays null. That
is the safe failure: a row only becomes visible when its full provenance is
read again.

**Open for review:** whether that is enough, or whether the notice below
should be the only prompt. Two alternatives were set aside:

1. An automatic refresh on upgrade. It is the version-triggered mutation LLP
   0428 refuses, and it rewrites a large table without the user asking.
2. An in-place backfill that reads provenance from current sources without
   re-deriving content. It cannot tell whether every contributor is still
   present, so it could mark a row visible while it holds content from a
   retained-away `local-only` session. Rejected.

## Read path {#read}

The shared visibility wrapper (`withLocalOnlyVisibility`) gains one case for
datasets that declare a provenance column alongside their content columns.
For each row it reads `source_cwds` and computes a verdict:

- null: suppress;
- otherwise the highest class rank among the listed folders, compared with
  the caller's rank: suppress when it outranks, else pass content through.

The verdict is memoized per distinct `source_cwds` string for the query, and
each folder resolves through the per-`cwd` memo the wrapper already keeps.
There is no join and no per-row lookup into another table. Most rows hold a
single folder, so the number of distinct strings stays near the number of
folders on the machine.

The native batch path ([LLP 0431 #native-suppression](./0431-frontier-scoped-graph-reads.spec.md#native-suppression),
[LLP 0388 #batch-filter](./0388-native-visibility-filtering.spec.md#batch-filter))
reads the `source_cwds` vector once per batch and builds a row mask. A batch
with no suppressed row passes its content vectors through unchanged. A batch
with every row suppressed keeps the constant-null vectors it emits today. A
mixed batch wraps each content vector lazily so masked rows read null without
decoding the others. All other LLP 0431 rules hold: the predicate residual is
kept when content is demanded, LIMIT/OFFSET and exact counts are not
forwarded, and suppressed fields are nullable. The wrapper forces
`source_cwds` into the scan when content is demanded, as it forces `cwd`, and
strips it when the caller did not ask for it.

A caller at `ignore`, or one passing `--include-local-only`, is unchanged: the
wrapper is skipped.

## Notice {#notice}

The suppression notice splits its count in two:

- rows hidden because a contributing folder is `local-only` (no action);
- rows with no recorded provenance, naming `hyp graph project --refresh` as
  the way to re-derive them.

The `usage_policy.query_withhold` log keeps counts only, never paths.

## Export and server {#export}

The graph tables keep declaring `localOnlyContentColumns`, so the central
sink keeps withholding them ([LLP 0305 #eligibility](./0305-open-dataset-central-forwarding.decision.md#eligibility)).
This change affects only the local read path. It does not make graph rows
exportable.

hypaware-server reuses the graph code with org-scoped partitions. The new
column reaches it, so the server suite runs against the client change before
it lands, and that run checks how server-side graph rows read with the
column present.

## Schema change {#schema}

One nullable column per graph table, added through LLP 0029 additive
evolution. No config key and no new dataset. The partition label
(`graph_v1`) and the partition declaration are unchanged.

[LLP 0430](./0430-manual-acceptance-procedures-are-retired.decision.md)
retired the written `durable_cache_upgrade` procedure. The repair runs the
check it described as a recorded step instead: the last release and the
candidate in one disposable `HYP_HOME`, with graph row counts before and
after, old rows reading null and suppressed, new and refreshed rows carrying
`source_cwds`, and a refresh failure leaving rows as they were.

## Cost {#cost}

- **Write:** the projection already holds every contribution in its merge
  maps. The union adds one small sorted set per id, bounded by the distinct
  folders that touched it.
- **Storage:** one JSON string per row, mostly a single path. Dictionary
  encoding keeps repeated values small.
- **Read:** one extra column per batch when content is demanded, and one
  memo hit per row. No new index, cache or runtime dependency.

## Tests {#tests}

1. A machine with no `local-only` folder reads names on nodes and edges
   projected after the change.
2. A node from a `local-only` folder stays suppressed for a syncing caller,
   and `source_cwds` does not leak the folder.
3. A mixed node (a `local-only` and a syncing folder) stays suppressed for the
   syncing caller.
4. Old rows (null `source_cwds`) stay suppressed; after `--refresh` the
   re-derived rows read correctly and the others stay suppressed.
5. `--include-local-only` output is unchanged.
6. An unknown contribution (an `enrichment_committed`-derived row, a rule
   without `cwd`) stays suppressed, and absorbs on merge.
7. A folder reclassified to `local-only` after projection hides its rows on
   the next query.
8. The native batch path and the row path agree on all of the above.

## Rating {#rating}

Not LOW. It changes what a privacy filter shows, and it changes a cache
schema. It needs a merge word.
