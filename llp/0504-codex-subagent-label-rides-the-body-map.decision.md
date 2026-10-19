# LLP 0504: the Codex subagent label rides the body map, and its value set is open

**Type:** Decision
**Status:** Active
**Systems:** Plugins, Sources, Gateway
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0049, LLP 0083, LLP 0151, LLP 0165

> Extends [LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md#container-fallback-gap)
> and [LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md#real-header-names)
> with two factual corrections and the guard input they imply (issues #514 and
> #498). Both documents are settled, so the correction lands here and they carry
> forward-refs to it.

## Context

LLP 0083 keeps a container fallback for a Codex turn that names a session
container but no thread, and refuses it when the turn states subagent lineage
without naming its own thread. It records the lineage that makes the refusal
reachable as two **direct headers**, `x-codex-parent-thread-id` and
`x-openai-subagent`, and lists the second one's values as four: `review`,
`compact`, `collab_spawn`, `memory_consolidation`. LLP 0151 repeats the four as
"its values".

Two statements there are wrong as of `openai/codex` release tag
`rust-v0.146.0`, `codex-rs/core/src/responses_metadata.rs`:

1. **The header is not the only carrier.** `CodexResponsesMetadata::client_metadata`
   inserts `x-openai-subagent` into the body's flat `client_metadata` map whenever
   it is set, beside `x-codex-parent-thread-id`, and `compatibility_headers` sends
   the same value as a header. The projector already read the parent thread id from
   the body map first ([LLP 0151 #body-is-authority](./0151-codex-lineage-from-body-client-metadata.decision.md#body-is-authority)),
   but read the subagent label from the header only. LLP 0151 itself notes the
   API-key route's generic `/v1/responses` can carry no Codex-namespaced header,
   so there the body is the only carrier and the guard could not see the label.
2. **The value set is open.** `subagent_header_value` maps
   `SubAgentSource::Other(label)` to `Some(label.clone())`, so any label a
   `SubAgentSource::Other` carries reaches the wire. The four named values are the
   ones Codex itself mints, not the whole set.

The retention of the guard and the container fallback was settled on #498 and is
not reopened here.

## Decision

<a id="body-carried-subagent"></a>**The guard reads `x-openai-subagent` from the
validated body map first, then the header.** The value comes from the same
`client_metadata` map every other lineage key is read from, and only once
`readCodexClientMetadata` has accepted that map as Codex's (an `x-codex-` key of
its own, or a corroborated flat id pair per
[LLP 0165 #flat-pair-corroboration](./0165-codex-flat-pair-needs-a-namespace-signal.decision.md#flat-pair-corroboration)).
A map Codex does not own states no lineage. The header stays as the fallback for
a hop that dropped the map. A turn that carries the label on either surface makes
the same refusal LLP 0083 describes; nothing else about the refusal changes.

<a id="open-label-set"></a>**Any non-empty label counts; none is matched.** The
guard was already value-blind, and the open set is why it has to stay so: an
allowlist of the four named values would let a future or `Other` label through
as a root thread. A malformed value (empty, not a string) follows the parser
contract every map key follows and reads as absent. It does not become lineage,
and it does not invent a thread.

<a id="what-this-does-not-do"></a>**Scope.** This prevents confidently borrowing
a parent's cwd for a turn that declares child lineage. It does not repair
unknown-cwd capture policy: a refusal still means cwd unknown, and what happens to
an unknown cwd is [LLP 0049](./0049-hypignore-usage-policy.spec.md)'s to decide.
The label is not recorded on the row, no column is added, and `is_sidechain`
still derives only from the blob's `thread_source` (the separate decision LLP 0151
leaves open). A turn that names its own thread, which every released Codex
request does through the body map, takes the thread path before the guard is
consulted, so ordinary traffic is unaffected.

## Consequences

- One more string lookup in an already-parsed map per Codex exchange. No new
  scan, cache, or allocation.
- The value-blind cost LLP 0083 discloses (same-workspace sub-threads refuse a
  container the root would have resolved) now applies to body-carried labels
  too. It needs the same unobserved request shape as before, a container with no
  thread id on any surface, so its reach is unchanged.
- The upstream facts are a snapshot of a program this repo does not build.
  Re-check the two functions named above if the guard's cost ever matters.

## References

- Code: `hypaware-core/plugins-workspace/codex/src/exchange-projector.js`
  (`resolveCodexContext`, `subagent_signal`)
- Tests: `test/plugins/codex-rollout-cwd.test.js` (the #514 block)
- Issues: #514, #498
