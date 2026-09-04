# LLP 0379: status derives backfill state by the reconciler's provider gate

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Config, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-04
**Related:** LLP 0041 (#run-once-flow-backfill-handler: `desired()` enumerates the runtime backfill registry), LLP 0229 (the attach twin of this rule, and the wording it borrows), LLP 0358 (#onboarding: Claude Desktop's history is imported by the Claude provider), LLP 0140 (why Desktop declares transcript entrypoints but no reader of its own)
**Extends:** LLP 0229

> `hyp status` declared every enabled client adapter on a joined host a
> default-on backfill target, but the reconciler's `desired()` only names
> plugins that register a backfill provider. `@hypaware/claude-desktop`
> registers none (the `@hypaware/claude` provider reads its transcripts), so
> its line read `backfill @hypaware/claude-desktop [pending]` forever. Status
> derives backfill state by the reconciler's own gate, and the gate is a
> manifest fact: a client block may declare `backfill_provider: false`.

## Context {#context}

[LLP 0229](./0229-status-derives-attach-state-by-the-desired-gate.decision.md)
settled the attach half of this: a client with no `attach_probe` is one the
attach reconciler will never name, so status renders `n/a`, never `pending`.
The backfill half was left where LLP 0041 put it. `buildClientActionsReport`
cannot see the runtime backfill registry (status boots no plugins, by design,
so rendering can never bind a port), and used "this enabled plugin contributes
a client" as the proxy for "this plugin registers a backfill provider". The
proxy held until v1.31.0 shipped a client adapter that is not a provider:
Claude Desktop contributes a client descriptor for entrypoint ownership
(LLP 0140) and skills, while its history is imported by the Claude provider
([LLP 0358 #onboarding](./0358-claude-desktop-transcript-import.decision.md#onboarding)).

Four shapes were on the table:

- **Status activates plugins** so it can read the registry. Rejected: LLP 0041
  made status a read-only marker view, and a boot profile of `none` is what
  keeps `hyp status` from binding the gateway or OTLP ports.
- **The daemon writes the desired set** into a state file status reads.
  Rejected: a new state file that is stale whenever the daemon is stopped or
  old, for a fact that never changes at runtime.
- **A positive manifest declaration** (`backfill_provider: true` on the five
  adapters that register one). Rejected on failure mode: a provider that
  forgets the flag loses its `pending` line silently, and nothing at runtime
  needs the flag, so nothing would catch the omission.
- **A negative manifest declaration** on the client that has no provider.
  Chosen. A client that forgets it shows the loud permanent `pending` this
  decision exists to fix, which is the status quo, not a regression.

## Decision {#decision}

<a id="manifest-declares-no-provider"></a>**A client block may declare
`backfill_provider: false`, and only the explicit `false` is carried into the
client descriptor.** Absent means the plugin registers a provider, which every
other bundled client adapter does. The catalog copies nothing else: a reader
of the descriptor cannot mistake "not declared" for "declared true". This is
the manifest-declares-what-status-needs pattern `attach_probe` and
`activity_probe` already follow, stated over the manifest and not over a
client roster, for the reason
[LLP 0229 #the-rule-outlives-its-clients](./0229-status-derives-attach-state-by-the-desired-gate.decision.md#the-rule-outlives-its-clients)
gives.

<a id="status-derives-by-the-provider-gate"></a>**`buildClientActionsReport`
treats a provider-less client adapter as inert for backfill.** It carries
`inert: true` in the declared-target map and derives `n/a`, joining
`on_join: false` and a non-joined host as the ways of saying the reconciler
is a no-op for this key. The explicit-block branch is gated too: a
`config.backfill` block on a provider-less plugin does not make it a target,
because `desired()` iterates providers, not config. The target is **not
dropped** from the report, for the reason LLP 0229 gives: a vanished row
cannot be told apart from a row status forgot to derive.

<a id="what-this-is-not"></a>**This is a gate, not a new signal.** Nothing
here reports whether Desktop history is in fact being imported. That remains
the Claude provider's line: on a joined host the `backfill @hypaware/claude`
row is the one that goes `pending` and then `done`, and it covers Desktop's
transcripts along with Claude Code's.

## Consequences {#consequences}

- On a joined host with Desktop capture on, `hyp status` reads
  `backfill @hypaware/claude-desktop [n/a]` beside
  `backfill @hypaware/claude [pending]` (or `[done]`). The permanent
  `pending` is gone.
- `PluginClientManifest.backfill_provider` is a new optional key of the
  kernel contract. Only `@hypaware/claude-desktop` sets it. A third-party
  client adapter that imports nothing of its own sets it the same way.
- A plugin that owns several clients is inert only if none of them brings a
  provider.
- Nothing at runtime reads the flag. The registry still accepts a
  registration from a plugin that declared `false`; that mismatch is a
  packaging mistake for `hyp plugin doctor` to grow a check for, not a
  runtime decision.
- This closes the over-reporting half of the gate only. The default-on
  derivation still keys off "this enabled plugin contributes a client", so a
  plugin that registers a provider and contributes no client block
  (`@hypaware/hermes`) is a target `desired()` names and status derives no
  line for until a marker lands. Unchanged here and not a permanent `pending`
  (the row appears `done` once the import runs), but the client-descriptor
  proxy is still not the provider gate in that direction.
