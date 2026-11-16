# LLP 0607: History replay for all clients

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI, Usage-Policy
**Author:** Brendan / Claude
**Date:** 2026-11-16
**Related:** LLP 0040, LLP 0101, LLP 0188, LLP 0345

> Extends [LLP 0345](./0345-explicit-client-history-replay.decision.md) at
> `#command`. The named form `hyp sync --history <client>` is unchanged; this
> adds an explicit keyword that covers every syncing client in one attended
> run.

## Context

LLP 0345 modeled one lifecycle: a client moves from `local-only` to `sync`, and
its retained rows are contributed deliberately. The replay is per client
because the policy it follows is per client.

A second lifecycle has the same need at a wider scope. A machine that leaves
one organization and joins another keeps its sink watermarks, which are keyed
by sink instance and partition, not by server or organization. The new
organization therefore receives only rows captured after the switch, and every
client's retained history is behind a cursor that already passed it. Nothing
in the join path rewinds those cursors, and LLP 0345 already rejected a rewind
as a user surface.

The supported repair is the named replay, once per client. That is a shell
loop over names the user has to look up first, for an operation whose safety
argument (the server's org-scoped `part_id` index) never depended on the
client boundary.

## Decision

### `all` is an explicit keyword {#keyword}

`hyp sync --history all` replays retained history for every client. The
keyword is typed, never implied: a bare or empty `--history` stays the usage
error LLP 0345's implementation made it, because a dropped or mistyped
argument must not buy the largest action the flag has.

The cost is that a client literally named `all` cannot be replayed by name.
No shipped client uses that name.

### One plan, one confirmation, per-client replay {#command}

The command previews every client, prints a single plan with one row count per
client, and asks once. After confirmation it runs the same per-client replay
the named form runs, through the same optional sink methods. The replay
methods do not change, and each client's rows still pass the shared export
privacy seam.

A client that is still `local-only` is skipped and named in the plan rather
than refused. The named form refuses because the user asked for exactly that
client; under `all` one opted-out client should not block the others, and
skipping it is the conservative direction.

The first-sync review window is treated as in LLP 0345: `all` neither
bypasses nor clears it.

A failed client does not stop the rest. Each replay is independent and
row-idempotent on the server, so the command reports the failure, exits
non-zero, and is safe to rerun.

### The plan names the organization {#org-in-plan}

Each destination that leaves the machine is shown as `(org <org>, leaves this
machine)`, read through one optional sink method from the credential the sink
already holds, with no request before the confirmation; when it cannot be
read the line says `org unknown` and the command still reaches the prompt.

### The client list is the retained partitions {#clients}

The clients `all` covers are the `source` values of the retained
`ai_gateway_messages` partitions, the same attribution the named form selects
by. Listing them reads partition directories, not rows, so the extra cost of
`all` over the per-client loop is one directory listing. Each client's preview
and replay still scans only that client's partition.

Scope is otherwise LLP 0345's: only `ai_gateway_messages` is replayed. OTEL
signals, derived tables, and other open datasets are not.

## Consequences

- Moving a machine to a new organization has a single supported command for
  contributing retained AI-gateway history.
- `--history <client>` behavior and output are unchanged.
- No watermark is read, rewound, or advanced by either form.

## Alternatives considered

- **Treat a bare `--history` as all clients.** Rejected: it inverts the
  mistyped-name guard, and the flag is a string, so `--history --yes` would be
  ambiguous.
- **Accept a client list in the sink contract.** Rejected for this slice: the
  per-client methods already scan one partition each, so a list buys nothing
  that a CLI loop does not.
- **Rewind or clear watermarks when a machine joins a new organization.**
  Rejected here for LLP 0345's reasons, and because it would turn a join into
  a silent historical upload.
