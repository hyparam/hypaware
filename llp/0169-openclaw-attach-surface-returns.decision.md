# LLP 0169: The OpenClaw attach surface returns

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Config, CLI
**Author:** Phil / Claude
**Date:** 2026-07-31
**Related:** LLP 0167 (the accepted RFC this decision realizes), LLP 0143 (superseded), LLP 0045 (client attach design), LLP 0044 (attach-on-join), LLP 0163 (malformed-block backup), LLP 0171 (requirements)

> With LLP 0168 writing real config entries, there is again a
> reversible settings-file write for the LLP 0044/0045 loop to own.
> Attach refuses over a user's entry and rewrites its own, the marker is
> the entry itself, core revives the `json_path` probe format, and detach
> also rewrites the per-agent model caches, which do not self-heal.

## Context

LLP 0143 removed the attach surface because LLP 0152 left nothing on
disk to reverse. LLP 0168 reverses that premise. Two verified facts
shape the design (LLP 0167#verify-results): OpenClaw's config is
strictly validated, so a top-level marker key would break it (the
LLP 0109 finding that motivated `json_path`), and the per-agent
`models.json` caches carry a removed provider entry forward
indefinitely, live for routing.

## Decision

- **Refuse over a user's entry, rewrite our own.**
  `models.providers.anthropic` and `.openai` are user-authored keys; if
  either holds a value HypAware did not write, attach refuses with an
  explanation instead of merging. Otherwise attach writes the two
  LLP 0168 entries whole, *including* over an entry a previous attach
  wrote: `isCurrent()` re-performs attach on an ephemeral-port rebind
  (LLP 0086) or an asset-set change (LLP 0107), so the write has to be
  idempotent over its own output or every drift pass refuses forever.
  Ownership is the self-identifying triple detach already tests
  (`baseUrl`, marker header naming the key, empty `models`), shared with
  it as one predicate. No user value is ever displaced, so there is no
  undo record anywhere: deletion is the whole undo.
- **The marker is the entry.** The `x-hypaware-upstream` header inside
  the created entry is the probeable marker. The manifest registers
  `attach_probe` in the `json_path` format, and core restores the
  `json_path` branches removed by PR #510
  (`src/core/config/client_detach_disk.js`, `src/core/daemon/status.js`).
- **Detach deletes and rewrites the caches.** Detach removes an entry
  only when its `baseUrl` is the gateway's; a present-but-not-ours or
  mangled entry is backed up, never discarded (LLP 0163). Detach also
  deletes the written provider keys from every
  `agents/<id>/agent/models.json`, because the caches do not self-heal.
- **Attach-on-join, full symmetry.** The plugin registers the runtime
  clients adapter so the LLP 0044 loop covers OpenClaw as it covers
  Claude and Codex, governed by `attach.on_join`. A refuse during join
  warns and never fails the join.
- **Both surfaces print the restart instruction**: a running OpenClaw
  gateway does not apply `models.providers` changes until
  `openclaw gateway restart` (verified on 2026.3.13).

## Consequences

- LLP 0143 is **Superseded**. Its reasoning was correct for its
  premise; the premise changed. The `json_path` retirement it ordered
  is reversed in the same change set that needs it.
- `hyp status` reports OpenClaw attach state truthfully again,
  resolving the OpenClaw half of issue #544.
- A user who removes HypAware without detaching strands a dead gateway
  URL; turns fail at connection time. Accepted as the same class as
  Claude's stranded attach block (LLP 0167#open-questions), made
  benign-by-construction at the CLI level because the entries are
  schema-valid.

## References

- LLP 0167#attach-detach, #verify-results
- LLP 0171 (the implementable requirements)
