# LLP 0345: Explicit client history replay to central

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI, Usage-Policy
**Author:** Phil / Codex
**Date:** 2026-08-31
**Related:** LLP 0040, LLP 0070, LLP 0101, LLP 0188, LLP 0324, LLP 0327

> Extends [LLP 0188](./0188-enrolled-default-sync-with-client-optout.decision.md)
> at `#no-retroactive-ship`. Returning a client to `sync` still changes only
> standing policy, but the CLI now points at an explicit, consent-gated
> historical replay for the retained rows the incremental cursor already
> passed.

## Context

`local-only` is drop-but-advance. The export cursor moves past a withheld row
so every scheduled tick does not rescan it, and removing the opt-out therefore
forwards only future rows. That is a sound incremental-export invariant, but it
leaves no supported path for a common lifecycle: record locally first, join a
team later, then deliberately contribute the retained history.

`hyp client history import` is not that path. It recovers rows missing from the
local cache by reading client transcript files. Rows withheld from central are
already in the cache, and the importer correctly deduplicates them by stable
part identity, so importing them again creates no new sequence for the sink to
observe.

Rewinding a sink watermark by hand is also the wrong product surface. It
changes undocumented plugin state, races the daemon, replays unrelated
datasets and clients, and makes the ordinary incremental cursor carry two
meanings. The replay is an exceptional, attended export and should be modeled
as one.

## Decision

### History replay is a separate, explicit sync mode {#command}

`hyp sync --history <client>` previews and, after confirmation, replays locally
retained history attributed to that client. It does not run the ordinary
incremental tick in the same invocation.

The client must already be in `sync` state. If it is still `local-only`, the
command refuses and names `hyp privacy client <client> sync`. The normal policy
transition remains small and reversible; its success output points at the
history command so the path is discoverable without making historical egress
the default.

`--dry-run` shows the replay without sending. `--yes` retains the ordinary
non-interactive confirmation bypass, except while the first-sync review window
is open, where the existing attended-release rule still wins. A replay never
silently clears that review window.

### Replay is an opt-in sink capability {#sink-capability}

The sink contract gains paired optional methods: one previews a client-history
replay and one executes it. A destination participates only when it implements
both. The command names destinations that cannot replay history rather than
pretending a generic cursor reset is safe for them.

The split is deliberate. Preview is read-only and cannot accidentally send;
execution is never called before consent. An implementation reports rows and
bytes actually sent, and a failure remains retryable by rerunning the same
command.

### Central replays attributed AI-gateway rows without moving its cursor {#central}

`@hypaware/central` implements the capability for `ai_gateway_messages`. It
scans retained rows from the beginning, keeps only rows whose `client_name`
equals the requested client, and sends them through the ordinary central wire
path and chunking limits. The shared export seam still applies directory
policy, so a directory that remains `local-only` is not exposed merely because
its client is replayed.

The replay neither rewinds nor advances the ordinary per-partition watermark.
Scheduled incremental export therefore remains race-safe: concurrent new rows
may arrive through either path, and the server's org-scoped
`ai_gateway_messages.part_id` index deduplicates them across batch IDs and
gateway identity churn. This server guarantee is why central can implement the
capability and blob destinations do not.

### Scope and failure direction are explicit {#scope}

The first implementation replays only `ai_gateway_messages`, the dataset with
the stable row identity and client attribution needed to make the operation
safe. It does not replay OTEL signals, derived graph tables, or arbitrary open
datasets. A source with no retained rows is a successful zero-row preview, not
evidence that another dataset was searched.

If client policy cannot be read, no replay occurs. If preview fails, no prompt
claims a count and no send occurs. If execution fails after some chunks land,
rerunning is safe because central deduplicates every part; the command reports
the partial failure instead of changing the incremental watermark to hide it.

## Consequences

- Moving from local-only capture to team history becomes a supported CLI path.
- Standing policy and one-time historical egress stay separate decisions.
- No cache rewrite, transcript re-import, daemon stop, or watermark surgery is
  needed.
- Existing `hyp privacy client <client> sync` automation keeps its future-only
  behavior and gains only a follow-up instruction.
- A future destination may implement the capability only after it can prove
  row-level replay idempotency and preserve the shared export privacy seam.

## Alternatives considered

- **Make `privacy client <client> sync` upload history by default.** Rejected:
  removing a standing opt-out must not silently turn retained content into an
  external transfer.
- **Add `--history` directly to the policy mutation.** Rejected for the first
  slice: policy mutation and a potentially long network transfer have
  different retry and confirmation semantics. The policy command points at the
  replay command instead.
- **Reset the central watermark.** Rejected: it replays unrelated rows, races
  scheduled ticks, and turns plugin state into a user API.
- **Run transcript backfill again.** Rejected: it repairs missing local rows;
  it cannot make already-deduplicated cache rows new to a sink.
