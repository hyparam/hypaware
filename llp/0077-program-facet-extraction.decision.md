# LLP 0077: Program facet = validity-gated `basename(argv[0])` of the first command

**Type:** decision
**Status:** Accepted
**Systems:** Plugins
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0073, LLP 0023, LLP 0032

> [Issue #230](https://github.com/hyparam/hypaware/issues/230): `Bash` and
> `exec_command` funnel everything into two undifferentiated `Tool` nodes,
> while the meaningful facet lives in `tool_args` and is discarded. This
> decision settles **which** facet becomes the `Program` node key and how its
> cardinality is bounded.

## Decision

The `Program` natural key is **`basename(argv[0])` of the first command,
lowercased and validity-gated**, extracted from `Bash`'s `tool_args.command`
and `exec_command`'s `tool_args.cmd` (fixture-pinned wire shape; fallback
`command`). Extraction (specified operationally in
[LLP 0073 §program-derivation](./0073-graph-skill-tool-nodes.design.md#program-derivation))
is a pure function of the row: first-connector cut → env-assignment skip →
known-wrapper unwrap (`sudo`, `env`, `timeout`, …) → `shell -c` unwrap
(depth-capped; Codex wraps everything in `bash -lc`) → basename → lowercase →
gate `/^[a-z0-9][a-z0-9._+-]{0,63}$/`, rejecting all-numeric tokens. Any
failure mints **nothing** — fall back rather than mis-key (LLP 0032's
discipline applied to a new facet).

## Why this facet {#why-basename}

The issue's own measurement is the argument: 1,568 Codex `exec_command` calls
→ **1,433 distinct raw command strings** (essentially unique, unbounded — not
a node) but only **29 distinct programs** by `argv[0]` — bounded by installed
binaries, and exactly the "was it a VCS action / a file read / a `hyp` query"
signal the reports want. Normalization (basename + lowercase) is what makes
`/opt/homebrew/bin/duckdb` and `duckdb` converge on one content-addressed
node; the validity gate is what keeps mis-parses (quoted fragments, paths,
substitutions) from minting unbounded garbage — the gate, not a threshold, is
the cardinality bound, so extraction stays a pure per-row function
(LLP 0073 §boundedness-contract).

## Rejected alternatives {#rejected}

- **Node per raw command** — 1,433 one-off nodes and growing; breaks the
  graph's small-and-joinable premise. Raw strings stay in
  `ai_gateway_messages` for drill-in.
- **Subcommand keys (`git commit`, `hyp query`) in V1** — more useful but only
  bounded for *known dispatchers*; blindly taking `argv[1]` re-explodes on
  `sed -n '1,240p' <file>`. Deferred (§deferred), not rejected forever.
- **Per-pipeline-stage extraction** (`a | b` mints both) — a contract rule's
  `toRow` emits at most one row per source row; multi-emit needs a
  `toRow → rows[]` engine extension, which LLP 0023's ownership split makes a
  deliberate central change, not something to smuggle into a connector. Also
  deferred. First-command-only matches the issue's measured facet, and
  pipeline tails are dominated by filters (`grep`, `head`, `sed`) that add
  little.

## Deferred: subcommand level {#deferred}

A second facet level for a **static whitelist of known dispatchers** (`git`,
`hyp`, `npm`, `gh`, …) — keyed like `git commit` — stays bounded and is the
natural next slice once Program nodes prove out. It requires its own choices
(node type vs key prefix; whitelist home; interaction with `dispatch_source`)
and, if modeled as a second node per call, the same `toRow → rows[]` engine
extension above. Mint a new request when wanted; do not extend the V1 key.
