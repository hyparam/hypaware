# LLP 0109: OpenClaw client adapter plugin

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway, Config
**Author:** Kenny Daniel
**Date:** 2026-07-15
**Related:** LLP 0016 (ai-gateway), LLP 0044 (client attach on join), LLP 0045 (client attach design), LLP 0005 (plugin manifest), LLP 0035 (token usage normalization)

## Summary

Add `@hypaware/openclaw`, a client adapter plugin for OpenClaw (the
open-source personal AI assistant, formerly Clawdbot/Moltbot). Like the
Claude and Codex adapters, it reroutes the client's model traffic through
the local AI gateway and projects captured exchanges into
`ai_gateway_messages`. OpenClaw's config model forces two departures from
the existing adapters, both decided here: the attach marker cannot be a
top-level key, and the self-describing undo record rides inside the
injected provider's `headers` map.

## Context

OpenClaw facts that constrain the design (verified against
docs.openclaw.ai, July 2026, OpenClaw 2026.7.1):

- Config lives at `~/.openclaw/openclaw.json`, JSON5, strictly validated:
  **unknown root keys make the OpenClaw gateway refuse to start** (only
  `$schema` is tolerated). The file hot-reloads; invalid external edits
  are rejected without rewriting the file.
- Custom model providers are declared under `models.providers.<id>` with
  `baseUrl`, `api` (`anthropic-messages` or `openai-completions`),
  `apiKey` (supports `${ENV_VAR}` interpolation), a free-form string map
  `headers`, and a `models[]` list. A custom `baseUrl` origin is
  automatically allowed by the network policy.
- The Anthropic path uses the Anthropic Messages API; the SDK appends
  `/v1/messages` to `baseUrl`, so the gateway's existing `anthropic`
  upstream preset routing (path prefix `/v1/messages`) matches unchanged.
- Model selection is `agents.defaults.model.primary` as
  `<provider>/<model-id>`; a model must also pass the optional
  `agents.defaults.models` allowlist.
- `ANTHROPIC_BASE_URL` is not honored, and overriding the built-in
  `anthropic` provider's `baseUrl` in merge mode is unreliable (openclaw
  issue #56679), so a dedicated provider id is the only dependable
  reroute.

The core attach contract (LLP 0045) requires: attach writes a
self-describing undo record into the client's settings file; detach is a
single core, disk-driven, plugin-agnostic undo keyed off the manifest
`attach_probe`. Existing probe formats are `json` (top-level marker key,
Claude) and `toml` (managed block, Codex). Neither fits OpenClaw: a
top-level `_hypaware` key would brick OpenClaw's own gateway, and the
file is not TOML.

## Options considered

1. **Override the built-in `anthropic` provider's baseUrl.** Least
   invasive to the user's model selection, but documented as unreliable
   (issue #56679) and unconfirmed to work on current releases. Rejected.
2. **Store the undo record in HypAware state (`HYP_HOME`) instead of the
   settings file.** Violates LLP 0045 Part 3 (reverse runs from disk
   state of the client's own settings file; the marker is the backup)
   and would break detach when state and settings drift. Rejected.
3. **Dedicated `hypaware` provider entry whose `headers` map carries the
   undo record.** `headers` is a schema-legal free-form string map, so a
   single `x-hypaware-marker` header holding a JSON undo record survives
   OpenClaw's strict validation, and the same mechanism injects an
   `x-hypaware-client: openclaw` header onto every request, giving the
   gateway projector a deterministic match signal. Chosen.

## Decision

### Attach (plugin-owned)

`hyp attach --client openclaw` edits `~/.openclaw/openclaw.json`
(HOME-relative; `OPENCLAW_HOME` overrides via the generic
`resolveClientSettingsPath` seam):

- Adds `models.providers.hypaware` with `baseUrl` =
  `http://127.0.0.1:<gateway-port>`, `api: "anthropic-messages"`,
  `apiKey: "${ANTHROPIC_API_KEY}"`, `headers` containing
  `x-hypaware-client: openclaw` and `x-hypaware-marker: <JSON undo
  record>`, and a `models` list mirroring the user's current primary
  model id.
- Repoints `agents.defaults.model.primary` from `anthropic/<model>` to
  `hypaware/<model>`, recording the previous value in the undo record.
- If an `agents.defaults.models` allowlist exists, appends
  `hypaware/<model>` and records the addition.
- V1 scope guards: attach requires the current primary to be an
  `anthropic/*` model (clear error otherwise), and requires the file to
  parse as strict JSON (JSON5 comment syntax is refused rather than
  destroyed, mirroring the Claude adapter's JSONC refusal). Writes are
  atomic and mtime-gated (CONCURRENT_EDIT), and never through a symlink
  (OpenClaw replaces the file by rename).

The undo record shape:

```json
{
  "attached_at": "...", "version": "...", "port": 4317,
  "managed": {
    "added": ["models.providers.hypaware"],
    "created_parents": ["models", "models.providers"],
    "set": [{ "path": "agents.defaults.model.primary",
              "value": "hypaware/<model>", "prev": "anthropic/<model>" }],
    "appended": [{ "path": "agents.defaults.models",
                   "value": "hypaware/<model>" }]
  }
}
```

### Probe and detach (core-owned)

A third probe format, `json_path`, joins `json` and `toml` in the
core format dispatch (probe + `detachClientFromDisk`):

```json
"attach_probe": {
  "format": "json_path",
  "settings_file": ".openclaw/openclaw.json",
  "marker_path": "models.providers.hypaware",
  "marker_record": "headers.x-hypaware-marker"
}
```

- **Probe:** attached iff the object at `marker_path` exists; `version`
  and `port` are read from the JSON-parsed record at `marker_record`
  (a path relative to the marker object).
- **Detach (core undo):** parse the record, then (a) for each `set`
  entry, restore `prev` (or delete when no `prev`) only if the current
  value still equals `value`; a differing value warns and is left in
  place, an externally deleted leaf is skipped silently (mirrors the
  `json` branch), never clobbering; (b) remove each `appended` value
  from its array if still present; (c) delete the `added` subtree, and
  always delete the `marker_path` subtree itself even when a buggy
  record omits it from `added` (otherwise the client probes as attached
  forever with no retraction path); then prune exactly the recorded
  `created_parents`, deepest first, only while empty - unrecorded
  ancestors are never pruned. A marker present without a parseable
  record fails non-destructively (`MALFORMED_MARKER`); `json_path` has
  no legacy-marker fallback. Format-aware, plugin-agnostic: core knows
  `json_path` semantics, never "OpenClaw".

This keeps LLP 0045's invariants: one core undo, driven entirely from the
settings file on disk, and the marker is a self-describing undo record.

### Gateway capture

- The plugin requires `hypaware.ai-gateway ^2.0.0`, registers the client
  (`defaultUpstream: 'anthropic'`), and registers the `anthropic`
  upstream preset itself iff not already present (the Claude plugin may
  or may not be active; the preset is identical and the name must stay
  `anthropic`, LLP 0016).
- Exchange projector `openclaw` matches on the injected
  `x-hypaware-client: openclaw` request header (deterministic, no
  user-agent sniffing) with priority above the Claude projector so
  OpenClaw traffic through the shared `/v1/messages` path is never
  misattributed. It projects Anthropic Messages exchanges (including SSE)
  into `ai_gateway_messages` with `provider: 'anthropic'` and
  `attributes.client: 'openclaw'`. Session identity: OpenClaw does not
  forward a session id header, so v1 derives `session_id` from a stable
  hash of the request's system-prompt head, and message ids fall back to
  the gateway's hash convention.

### Known v1 limitations (revisit triggers)

- Auth: the injected provider authenticates via `${ANTHROPIC_API_KEY}`;
  OpenClaw auth-alias/keychain credentials are not visible to a custom
  provider. Attach warns when the env var is unset.
- OpenClaw caches resolved providers in
  `~/.openclaw/agents/<id>/agent/models.json`, where a non-empty cached
  `baseUrl` wins over config; attach emits a warning naming that file
  when a stale `hypaware` entry is detected, but does not edit agent
  state.
- Non-Anthropic primaries and skills installation
  (`skill_dir: .openclaw/skills` is declared, but no skills ship in v1)
  are follow-ups.

## Consequences

- Core gains a third, generic probe/undo format (`json_path`); the
  claude/codex paths are untouched.
- The `PluginSkillClient` union and the hardcoded first-run picker
  (`cli/detect.js`, walkthrough, `init.js` enums) do not learn about
  OpenClaw in v1; `hyp attach --client openclaw` is registry-driven and
  works without them.
- Every OpenClaw request carries the marker header to the local gateway;
  it is inert metadata, never forwarded upstream (the gateway strips
  `x-hypaware-*` request headers before proxying).

## Open questions

- Whether newer OpenClaw releases make built-in-provider `baseUrl`
  overrides reliable (would remove the model repoint).
- Whether OpenClaw session JSONL (`~/.openclaw/agents/<id>/sessions/`)
  should feed a settlement enricher for native session identity, like
  the Claude transcript enricher (LLP 0027).

## References

- LLP 0016, 0044, 0045, 0005, 0035, 0027
- https://docs.openclaw.ai/gateway/configuration
- https://docs.openclaw.ai/concepts/model-providers
- https://github.com/openclaw/openclaw/issues/56679
