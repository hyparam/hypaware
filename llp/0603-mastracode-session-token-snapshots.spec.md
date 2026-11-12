# LLP 0603: Mastra Code session token snapshots

**Type:** Spec
**Status:** Draft
**Systems:** Sources, Plugins, Backfill, Query
**Date:** 2026-11-12
**Extends:** LLP 0586#owner-decisions (D4), LLP 0035#per-turn
**Related:** LLP 0598#accounting, LLP 0590#derivation, LLP 0449#reconciliation

## Evidence

Local Claude subscription probes on Mastra Code 0.49.0 showed counters
accumulating across turns and a process restart, and starting fresh on a new
thread. Raw provider usage confirmed prompt = uncached input + cache reads +
cache writes, and output already includes reasoning. For example, one step
reported 28,026 prompt tokens, 28,022 cache writes, 4 uncached input, and 295
output comprising 3 text and 292 reasoning tokens. An interrupted response
persisted partial text while the usage still described the preceding completed
request. These counters are recorded usage, not guaranteed billed totals.
The configured agent exposed no child tool, so child accounting was not tested.

Installed @mastra/core 1.82.0's `stream-GSsXnWy3.js#normalizeUsage` maps V3
input.total/cacheRead/cacheWrite and output.total/reasoning to the flat fields.
`agent-controller-BDds1y5w.js#addUsage` adds them to the thread tally; `raw` is
only the latest step, not historical usage. Other providers were not live-tested.

## Accounting {#accounting}

Extend D4 with one synthetic system/status row per thread, marked
provider_subtype=session_usage. Keep the legacy process_token_usage attribute
on the last assistant part for compatibility, without per-turn attributes.usage.
The new row maps:

- input_tokens = promptTokens - cachedInputTokens - cacheCreationInputTokens
- output_tokens = completionTokens (reasoning is already included)
- cache_read_tokens = cachedInputTokens
- cache_write_tokens = cacheCreationInputTokens
- reasoning_tokens = reasoningTokens
- total_tokens = totalTokens, unchanged when supplied

Reject negative, fractional or unsafe counters and impossible cache subtraction.
Missing fields remain unknown: derive input only when prompt and both cache
fields are present. Never substitute the last step's raw usage for a session
total. No credentials, provider raw payloads or new database columns are read.

Use a stable message id and position, with the thread's createdAt as its date.
Set model and provider to unknown: the thread can switch models/providers.
Store thread updatedAt as attributes.mastracode.usage_observed_at, a snapshot
revision, not proof that every request's usage was saved. Local whole-thread
reconciliation replaces this row with the conversation. Both poll and backfill
use the same projector and the existing materializer fills the token columns.
Metadata-only updates already invalidate the thread digest. No new scans,
timers, retained state or runtime dependencies are required; one constant-size
row and constant CPU work are added per projected thread.

## Queries and scope {#queries}

Session-start date grouping means recorded lifetime usage of sessions starting
on that date, not spend during that day. Backfill selection still uses the
existing updatedAt window; it does not produce an as-of usage reconstruction.
An assistant-only usage query excludes these rows intentionally.

On a remote, exported revisions can coexist. Select the greatest
attributes.mastracode.usage_observed_at per gateway_id and message_id, keeping
all counters from that revision, before summing. Do not sum snapshots or take
an independent maximum of each counter. Server rollup support is a separate
change in the server repository; this change populates local/exported columns.

## Validation

Test materialized columns, gross/net cache arithmetic, reasoning overlap,
missing and invalid fields, stable identity/date, no inherited last model,
and no usage on ordinary messages. Exercise metadata-only updates, restart
and repeated backfill through the existing poll/backfill harness and verify
one replacement snapshot plus unchanged conversation rows and poll telemetry.
