# LLP 0306: OpenCode CLI and Desktop capture

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins, Config, Daemon, Onboarding, Privacy
**Author:** Phil / Codex
**Date:** 2026-08-24
**Related:** LLP 0011, LLP 0012, LLP 0015, LLP 0016, LLP 0035, LLP 0037, LLP 0045, LLP 0049, LLP 0050, LLP 0066, LLP 0103, LLP 0140, LLP 0252, LLP 0256, LLP 0257

## Context {#context}

OpenCode CLI and Desktop share the same server, plugin machinery, global
configuration directory, and session store. OpenCode 1.18.22 exposes a
documented local JavaScript plugin surface, an authenticated SDK client inside
that plugin, and bounded CLI session export. Its generic plugin event callback
is fire-and-forget, and controlled CLI/Desktop runs did not reliably deliver a
completed turn through native OTLP. Export has complete messages and parts but
does not retain the frontend that created a session.

Existing HypAware client registration is exposed only through the AI gateway
capability. That was sufficient while every adapter attached by repointing a
provider or proxy, but it would make an unrelated gateway a dependency of an
OpenCode plugin integration.

## Decision {#decision}

One `@hypaware/opencode` adapter covers CLI and Desktop.

### Live lane {#live-lane}

Attach installs one HypAware-owned plain JavaScript file in OpenCode's
documented global plugin directory. The plugin uses the SDK client OpenCode
supplies to fetch the affected session and its ordered `{info, parts}` message
snapshot. Generic events are wake-ups only: their delivery and ordering are not
a journal, and the callback never waits for HypAware or fails a model call.

The plugin sends snapshots to a loopback-only HypAware source. It stamps the
live `OPENCODE_CLIENT` frontend before shared storage can merge CLI and Desktop
history. Missing frontend is `unknown`; missing cwd is an observable drop and
is never guessed.

### Recovery lane {#recovery-lane}

The same projector consumes documented `opencode export <exact-session-id>`
objects. Historical discovery first lists session metadata, applies the exact
requested time window, and exports only the selected IDs. Message and part
array order is authoritative. The recovery lane never opens every transcript
or scans unrelated content.

Native OpenCode session IDs, message IDs, part IDs, and tool call IDs are kept
verbatim. `part.id` is the canonical `part_id`, so a live snapshot and export
of the same final part converge through the existing projected-exchange
writer. Pending and running tool states are not persisted because the
append-only part-id dedupe would otherwise prevent their final state from
landing. Usage and cost ride one terminal assistant part only. Unknown part
shapes remain rows with their native type and raw frame.

Every producer applies session ignore, `.hypignore`, the machine-local policy,
and `local-only` before persistence. `ignore` and missing cwd write nothing;
`local-only` keeps the cwd on locally recorded rows so the shared export seam
withholds them.

### Endpoint-free clients {#endpoint-free-clients}

Client registration becomes an intrinsic kernel registry. The AI gateway's
`registerClient`, `getClient`, and `listClients` delegate to it, preserving the
existing Claude, Codex, and OpenClaw surface. A registration declares whether
attach requires a gateway endpoint, defaulting to true. OpenCode registers
directly with `requiresEndpoint: false`; manual and reconciled attach resolve a
gateway endpoint only for registrations that require one.

This changes only client lifecycle dispatch. It does not move upstream presets,
exchange projectors, or gateway recording into core.

### Managed plugin file {#managed-plugin-file}

The attach probe gains a `managed_file` format with an exact ownership marker.
Attach creates or replaces the file only when absent or already owned by
HypAware, and refuses an unowned collision. Detach removes the file only while
the marker remains present. This is the self-describing disk undo required by
LLP 0045, specialized to a whole file rather than a block inside settings.

OpenCode's global path follows its documented XDG config root:
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/hypaware.js`. OpenCode does
not document `OPENCODE_HOME`, so HypAware does not interpret it. The onboarding
probe stays within the existing single-`settings_file` picker contract and
checks `.config/opencode/opencode.json`, whose containing directory detects
either JSON or JSONC users and both frontends. The detector honors
`XDG_CONFIG_HOME` for this row. A fresh, never-run installation is an accepted
false negative because the row remains visible and selectable.

### Dataset ownership {#dataset-ownership}

OpenCode writes the existing `ai_gateway_messages` normalized conversation
dataset through the existing projected-exchange writer. The adapter does not
compose or activate `@hypaware/ai-gateway`. When the gateway plugin is absent,
OpenCode idempotently registers that dataset owner's existing registration and
backfill materializer modules in the same runtime. The schema and expansion
remain single implementations; this is reuse of the dataset owner, not a new
table or a second row contract.

### Health and excluded lanes {#health}

Source status reports listener activity, reconciliation cursor, writes/skips,
policy and session drops, missing cwd, unknown entrypoints, store-activity
gaps, and the last error. Native OTLP may later add health evidence, but generic
traces remain off by default and conversation completeness never depends on
OTLP. A provider baseURL proxy and a hosted gateway are not part of this slice.

## Consequences {#consequences}

- OpenCode capture works without provider routing, credentials, or gateway
  configuration.
- Live callbacks can be lost without losing eventual recovery, subject to the
  bounded reconciliation/export window.
- An OpenCode config home relocated only through a process-local override that
  the setup process cannot observe may not be pre-checked. This does not widen
  the picker probe schema.
- Manual CLI/Desktop acceptance is still required for releases touching this
  adapter. It is not simulated by the hermetic smoke and is never run without
  explicit authorization.
