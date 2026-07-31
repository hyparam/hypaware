# LLP 0164: `hyp status` names recent clients from gateway-tracked entrypoints

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Gateway, Daemon, Onboarding
**Author:** Phil / Claude
**Date:** 2026-07-31
**Related:** LLP 0003, LLP 0017, LLP 0086, LLP 0114, LLP 0130, LLP 0131, LLP 0133, LLP 0141

> Closes the one consequence [LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md)
> left deliberately open: `hyp status` could not say "Codex Desktop traffic
> arrived recently". The gateway now counts and timestamps the `entrypoint`
> values it writes into rows, the daemon carries that into `status.json` on
> every tick, and `hyp status` renders it. No dataset registry, no cache read,
> and no client-specific string anywhere in core.

## Context

[LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md) made
Codex Desktop coverage legible in the picker, the reference docs, and the
`unsupported_location` event, and wrote the manual `codex_desktop_capture`
procedure. It closed with one item open, and named four candidate shapes for
closing it:

1. a declarative activity-probe key on the client descriptor,
2. changing `hyp status`'s boot profile, or giving it a cache read,
3. a fifth entrypoint section in `hyp query overview`,
4. the gateway tracking last-seen entrypoints into `status.json`.

The constraint that rules out the obvious answers: `decideBootProfile`
(`src/core/cli/dispatch.js`) returns `{ activate: [] }` for `status`, on
purpose - a diagnostics command must not bind a gateway or OTLP listener just
to print a report. So `hyp status` has no dataset registry and cannot see a
row. Teaching core which `entrypoint` strings mean "Codex Desktop" would put
client-specific data in core, against
[LLP 0130](./0130-declarative-picker-descriptors.decision.md)'s "rendering
needs no plugin code" and LLP 0003's core/plugin split.

The same gap had already produced a false instruction elsewhere:
`claude-desktop verify` told the user to "confirm capture via `hyp status`",
which was not achievable for exactly this reason.

## Decision

**Option 4.** The gateway tracks last-seen entrypoints; `hyp status` reports
them from `status.json`.

<a id="gateway-tracks-what-core-cannot-name"></a>**The gateway counts and
timestamps entrypoints it never interprets.** As each batch of projected
message rows is committed, the AI-gateway source folds their `entrypoint` and
`client_name` values into an in-memory map: last-seen timestamp and a row
count per distinct `entrypoint`. It is recorded *after* the append resolves,
so "recent clients" means rows that landed, not rows that were projected and
then lost to a write failure.

Three properties make this the client-agnostic option rather than a disguised
version of option 2:

- **No interpretation.** Nothing in the gateway or in core decides what a
  value means. `codex-tui`, whatever Codex Desktop reports, and
  `local-agent` are all just strings that arrived in a column. The vendor
  owns them ([LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md)
  pins none of them), and the value printed is byte-identical to the one a
  follow-up `ai_gateway_messages` query filters on - for every value a real
  client surface produces. The one exception is deliberate: a value carrying
  control bytes or running past 120 characters is cleaned before it is
  displayed (see **Bounded** below), so it is the row, not the readout, that
  stays authoritative for a pathological name.
- **No placeholder.** A row with no `entrypoint` is skipped, not bucketed
  under "unknown". A name in `hyp status` that no query can reproduce would
  be worse than a short list.
- **Bounded, in both dimensions.** The map is capped (32) with
  least-recently-seen eviction, so an odd or hostile client cannot grow
  daemon-lifetime state, and the entry an overflow drops is the one a
  "recent" readout would have dropped anyway.

  A count cap is only half a bound, because nothing on the way in
  constrains the *value*. Two of the three routes into the column are
  bounded by the HTTP parser (Codex's `originator` header and the
  User-Agent product, which cannot carry C0 control bytes and cap around
  16KB), but the third is not: for Claude the live projector copies
  `entrypoint` off a transcript `.jsonl` line on disk
  (`assignTranscriptIdentity`), and that is an ordinary JSON string of any
  length containing any byte. Since this map is the source for a file on
  disk and for text printed to a terminal, values are passed through
  `sanitizeLabel` (control bytes stripped, clamped to 120 chars) at the
  point of record, and again in core when read back. Without it, a
  transcript value could repaint the operator's screen or forge a
  plausible extra `hyp status` line, and 32 unbounded values would be
  rewritten into `status.json` on every tick.

This is an **activity signal, not a store**. It is in-memory and
daemon-scoped: it dies with the process and is never written anywhere but the
status snapshot. The cache remains the only durable record of a row.

<a id="status-reads-it-from-the-status-file"></a>**`hyp status` reads it from
`status.json`, which the daemon now refreshes.** Boot wrote each source's
`status()` details exactly once (`startConfiguredSources`), which was enough
while every detail was fixed at bind time: host, port, and the LLP 0114
fallback marker never change after the bind. It is not enough for a detail
that accrues. So the daemon re-reads started sources' details on every sink
tick, and once more at shutdown before the sources are torn down (a daemon
that stopped between ticks must not leave a file claiming it saw nothing).
Name, plugin, and state are left alone: liveness is the lifecycle's business,
not a status probe's, and the refresh is best-effort per source like
`safeStatus` itself.

Core's whole share of the feature is `recentEntrypointsFromSources`: find the
gateway source's snapshot, validate the shape, order by time, drop what is
malformed. `hyp status` then renders a `recent clients:` block, and
`--json` a `recent_entrypoints` array. The block appears only when the daemon
recorded something, so an install that has never captured keeps the V1 text
surface unchanged.

This also makes `claude-desktop verify`'s step 3 true rather than
aspirational: Claude Desktop's 3p route lands under `entrypoint:
"local-agent"` ([LLP 0133](./0133-desktop-solo-sudo-plist.decision.md)#attribution),
which is a value like any other, so it appears with no Claude-specific code.

<a id="not-liveness-gated"></a>**Unlike a bound port, it is not gated on
daemon liveness.** `resolveLiveGatewayEndpointFromStatus` checks the pid file
first, because a port in a stale status file is a claim about *now* and
becomes false the moment the daemon dies. "Last seen at T" does not: it stays
true afterwards. So the list is reported whether or not a daemon is running,
and the rendered age (`just now` / `5m ago` / `3h ago` / `2d ago`) is what
carries the staleness. The age is coarse on purpose - the question the line
answers is "was that just now, or last week?", and a precise timestamp would
invite reading the value as a query bound it is not.

## Consequences

- **A restart clears the list.** The tracker is in-memory, so a daemon that
  restarts after a conversation reports no recent client for it even though
  the rows are in the cache. This is the price of not adding a durable store
  for a diagnostic, and it is documented as an expected outcome in
  [`docs/ACCEPTANCE.md`](../docs/ACCEPTANCE.md)'s `codex_desktop_capture`
  step 4 and its failure notes. The query remains the durable check.
- **Row counts are per daemon process, not per install.** `rows` in the
  status output counts what this process committed. It is an activity
  signal; `select count(*) from ai_gateway_messages` is the number.
- **Only gateway-captured surfaces appear.** Backfill writes rows through the
  materializer, not through the live gateway, so importing a Desktop rollout
  does not put Desktop in `recent clients`. That is the honest reading of the
  line ("traffic arrived here"), but it means the two capture routes of
  [LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md) are
  not symmetric on this surface.
- **`status.json` writes are marginally larger and slightly more frequent in
  content**, since the tick now re-probes source details. The tick already
  ran and already wrote the file (LLP 0017), so this adds a bounded
  per-source `status()` call, not a new loop.
- **`hyp query overview` was not changed.** Option 3 would have altered that
  block's calibrated window budget (`OVERVIEW_SECTIONS.length` feeds
  `rowsAffordable`, LLP 0135#window); this decision leaves it untouched.
- **The live route is still only provable on real hardware.** Nothing here
  changes that: `gateway_codex_capture` asserts the plumbing against a
  synthetic Desktop-shaped exchange, and the real-app claim stays with the
  manual `codex_desktop_capture` procedure.
