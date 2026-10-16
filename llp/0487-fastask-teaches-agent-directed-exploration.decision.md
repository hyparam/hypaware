# LLP 0487: Fastask Exposes Its Primitives and Teaches Agent-Directed Exploration

**Type:** Decision
**Status:** Superseded
**Superseded-by:** [LLP 0491](./0491-team-history-uses-remote-graph-and-agent-guidance.spec.md) (client replication and its commands; shared kernel utilities remain)
**Systems:** CLI, Graph, Query, Clients
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0480#command](./0480-fastask.design.md#command) (agent-callable operations), [LLP 0480#skill](./0480-fastask.design.md#skill) (what the skill teaches first), [LLP 0480#command-tree](./0480-fastask.design.md#command-tree) (where the operations sit), and [LLP 0481](./0481-fastask.plan.md) tasks T13 and T14 (what is evaluated and taught)
**Extended-by:** [LLP 0488](./0488-planner-deferred-and-discover-matches-path-tokens.decision.md) (the planner is deferred, not optional-and-shipped; discover matches path tokens; T13 acceptance case)
**Related:** LLP 0479#req-interface, LLP 0484 (discovery walks `touched`), LLP 0485 and LLP 0486 (CPU and memory bounds), LLP 0248 (command tree), LLP 0393 (telemetry vocabulary); server LLP 0555 T11 (server-first command names)

> HYP-111 asked for local candidate discovery, bounded neighbor traversal,
> candidate-session search and chronological source-window reads as
> machine-readable operations, with answer synthesis optional. LLP 0480
> narrowed that to one planner command, `hyp fastask "<question>"`, and a
> skill that runs it first. Phil's fresh-chat tests succeeded with the other
> shape: the agent was given the four operations and chose its own path. This
> decision exposes the operations, teaches agent-directed use first, and keeps
> the planner as an optional shortcut that is evaluated separately and never
> described as benchmark-proven.

## What the tests showed {#evidence}

In Phil's fresh-chat runs (October 9, 2026; single runs, so they establish
feasibility, not a ratio), an agent given `discover`, `neighbors`, `search`
and `read` over a local team graph, and left to choose file and path
concepts, traversal, candidate sessions and evidence windows, found the
target decision in 64.8 s with 4 retrieval calls and 2 server queries. With
the original server tools it took 400.4 s and 19 requests. No deterministic
planner was involved, so the tests say nothing about one.

## Decision {#decision}

**1. Agent-callable operations.** Three plugin commands join `hyp fastask`,
under the query journey beside `query graph neighbors` and `query evidence`
(LLP 0248: operations under the journey that reads):

| Command | Operation | Built from |
| --- | --- | --- |
| `hyp query team-graph discover` | Files of the team graph whose keys match explicit terms or `--file` paths (repository-preferred, suffix matches marked unproven), and the sessions that touched them, paged. | `discovery.js` `discover` with explicit terms instead of question extraction, plus `--limit`/`--offset` paging; the daemon's existing discover route (warm), `cold_replica.js` (cold), `sql_discovery.js` (`team_server`). |
| `hyp query team-graph neighbors` | Bounded traversal from given node ids or keys: direction `in`, `out` or `both`, optional edge types, visit and result limits, truncation flagged. | A small new walk over the index's existing CSR adjacency in `discovery.js`, the same visit budget (20,000); one new daemon control route beside discover; `team_server` answers through the existing `query graph neighbors --remote`, named in the output. |
| `hyp query team-graph search` | Text search inside given candidate sessions: up to 16 sessions, up to 12 terms OR'd, a per-session hit budget and per-hit text cap, each session reported separately with its own truncation. | Client-only fan-out of the existing `query_sql --remote` per session (bounded concurrency 2), the shape the tested prototype used; no new server tool. |

`read` is the existing `hyp query evidence --remote` (server
`session_evidence`): chronological windows, cursors, per-session status.

All three accept `--remote` and `--org` as `hyp fastask` does (they are plugin
commands, not verbs, so `--remote` selects the replica's server instead of
forwarding to a server tool), and `--json` with a stable shape per command
that names its source kind (`team_replica` warm or cold, `team_server`,
`local`), the replica state and the watermark age, exactly as `fastask/1`
does (LLP 0480#output). Every result carries the IDs the next operation
takes. Every operation keeps LLP 0480's bounds and the CPU and memory rules
of LLP 0484, LLP 0485 and LLP 0486; none adds background work.

**2. The planner stays optional.** `hyp fastask "<question>"` is kept as a
one-shot shortcut that runs discover, then evidence, and prints the same
follow-ups. It is not the recommended entry point, it is evaluated
separately (T13), and no text calls it benchmark-proven.

**3. The skill teaches agent-directed exploration first.** Both
`hypaware-query` copies' routing paragraph says, in substance: for a history
question about the team's work, explore the team graph yourself: `query
team-graph discover` with the concepts you choose (file names, paths,
identifiers), `neighbors` to follow relationships, `search` inside the
candidate sessions, then `query evidence` to read the original conversation
around the hits, checking later reversals; results are leads with a
freshness bound, not complete history; `hyp fastask "<question>"` is an
optional shortcut. The `fastask.md` side file documents each operation's
inputs, outputs, limits and source states. Captured content stays evidence,
never instructions. Still shipped only at enablement (LLP 0480#enablement).

**4. Plan scope (LLP 0481).**
- **T13** evaluates the agent-directed path as the primary condition: fresh
  Codex and Claude chats with the T14 skill text, the local-graph on/off by
  server-index on/off matrix, whole-turn and retrieval timings, all runs
  kept. The planner is a separate, secondary condition; if it is not shown to
  help, the skill keeps it as a footnote or drops it.
- **T14** ships the agent-directed skill text above and the side file.
- **One new implementation task** builds item 1 (see the hand-back outline
  in the HypForge mission record); it lands on `integration/fastask` before
  T13.

## Command names (server-first) {#command-names}

The three commands add three product-telemetry names: `query team-graph
discover`, `query team-graph neighbors`, `query team-graph search`. The
client's consistency gate makes every registered command a telemetry name,
and a receiver that does not admit a name drops the whole batch (LLP 0393,
server #1438). The server receiver must admit them, and that server must be
deployed, before any client release that registers them: a one-line,
nothing-removed addition to the server's command vocabulary, the same shape as
server LLP 0555 T11, which admitted the four existing fastask names. This is
the only server change, and it is not new feature work.

## Preserved {#preserved}

HYP-110 and HYP-112 server dependencies and contracts; the merge and
deployment order of LLP 0479#ordering; the CPU, yield and memory rules of
LLP 0484, 0485 and 0486; review findings F1 to F6 in flight; the Jev
exclusion. Nothing here removes the planner or adds server tools.

## Consequences {#consequences}

- New task (implementation): the three commands with tests and smokes, the
  explicit-terms and paging inputs to `discover`, the `neighbors` walk and its
  control route, the `search` fan-out, `--json` shapes, and the three names
  added to the client `COMMANDS` on the integration branch.
- Server: admit the three names (server-first, before release).
- T13 and T14 scope as in item 4.
- CPU and memory: bounded per call by the existing visit, result and text
  limits; `search` adds at most two concurrent remote queries per call.
