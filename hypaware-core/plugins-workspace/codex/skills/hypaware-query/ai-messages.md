# AI gateway messages

`ai_gateway_messages` has one row per message content part.

- Scope sessions with `session_id`. `conversation_id` is a nullable thread within a session.
- `role` is `user`, `assistant`, `tool`, `system`, or `developer`.
- `part_type` is `text`, `reasoning`, `tool_call`, `tool_result`, `image`, or `fallback`. Use `tool_call`, not the provider's `tool_use`.
- Message text is in `content_text`; tool calls use `tool_name`, `tool_call_id`, and `tool_args`.
- Token usage is under `attributes.usage` on assistant rows: `input_tokens`, `output_tokens`, `cache_read_tokens`, and `cache_write_tokens`. OpenAI omits cache-write tokens and adds `reasoning_tokens` and `total_tokens`.

Extract token fields with `COALESCE(CAST(JSON_EXTRACT(attributes, '$.usage.input_tokens') AS BIGINT), 0)`. Use COALESCE for each term in an addition and each aggregate sum. Usage appears on one assistant part per captured response, but that does not guarantee uniqueness across capture sources or historical stream updates.

Before summing token volumes, check usage-bearing records for repeated provider request identities and inspect bounded examples. Verify identity semantics for each provider and source. Count proven copies/updates of one response once: prefer the final usage record, or the record with the highest output count when these are verified cumulative updates of the same response. Take all counters from that same record. Do not sum updates or take independent maxima of different counters. Keep unmatched captures; filtering to one entrypoint can discard real requests. Never merge unrelated records with missing request IDs or deduplicate on identical token values alone. Reconcile identities across date partitions before combining totals. If identity cannot be resolved, report the defensible scope and coverage instead of a falsely exact combined total.

Read usage from `attributes.usage`, not `raw_frame`. `input_tokens` is net of cache. Keep input, output, cache read, and cache write separate; reasoning may already be included in output. Missing usage is not zero consumption.

To scope a question to one agent or machine, find its gateway from facts the user knows rather than asking for an id. A gateway is one HypAware install: a person's machine or an autonomous agent's runtime. Discriminate on `git_remote` for the repository it works in, on a `cwd` pattern for where it runs (an agent in containers has paths like `/work/...` that no laptop has), or on its name in `system_text`; count distinct sessions per `gateway_id` for each candidate, confirm with a bounded sample, then filter on `gateway_id`. A name match alone is not enough: people working on an agent's repository mention it too. If no local gateway matches, the agent runs elsewhere: look on the configured remote without asking first.

Run `hyp query schema ai_gateway_messages` for the full column list. For OpenClaw activity, read [openclaw.md](openclaw.md) before choosing a source filter.
