# LLP 0432: Codex saved-provider compatibility

**Type:** Spec
**Status:** Draft
**Systems:** Config, Plugins, Backfill
**Author:** Phil / Codex
**Date:** 2026-09-24
**Related:** LLP 0429, LLP 0045, LLP 0313

## Repair request {#compatibility}

This extends [LLP 0429's migration](./0429-codex-capture-leaves-inference.spec.md#migration):
saved Codex chats retain `model_provider = "hypaware"`. Deleting that provider
prevents them loading, even after the default selection was restored. Keep an
unselected compatibility provider after releasing the gateway. It has
`name = "OpenAI"`, `requires_openai_auth = true`, `wire_api = "responses"`, and
`supports_websockets = true`, with no endpoint or credentials. Codex selects its
native ChatGPT or API endpoint from the current login. The exact name preserves
Codex's OpenAI-specific provider behavior.

The default selection still restores the recorded prior value. In particular,
a custom prior provider and its endpoint/auth settings are unchanged: they
serve new chats, while the saved HypAware chats continue using OpenAI, as the
old HypAware gateway route did. Do not copy credentials, read `auth.json`, pin
one login mode, or copy another provider's secrets into the alias.

Version 1.38.0 already removed both markers on affected machines. Therefore
manual transcript attach, scheduled transcript migration, and explicit core
detach add the missing alias to an existing config even without markers. This
is intentionally add-only and does not select the alias. Without scanning
history or adding a migration ledger, an already-migrated config is
indistinguishable from an ordinary existing config. The bounded cost of an
unused alias is preferable to breaking saved chats or repeatedly scanning all
history just to establish that it exists. Absent config files stay absent.
Existing unmarked providers are user-owned and remain untouched. Explicit
gateway capture keeps the managed gateway writer and bypasses sweep repair.

## Ownership {#ownership}

Extend [LLP 0045's TOML undo](./0045-client-attach.design.md#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record):
markers establish ownership of the managed selection and provider, not every
line between comments. Codex can insert unrelated root keys, desktop settings,
features, and hook trust tables inside those markers. Remove only marker
metadata, the still-owned root selection, and the managed provider table.
Preserve other settings and externally changed selections. Share this editor
between the plugin and core undo so unloading a plugin cannot change repair.
The status probe uses the gateway's BEGIN marker, not the alias's table header.

If the root `model_providers` namespace is an inline table without a `hypaware`
child, expand its entries into equivalent dotted assignments before appending
the compatibility table. Retain each child value and the default selection.
An existing user-owned inline `hypaware` child remains untouched. Strings,
nested tables, arrays, and comments must not be mistaken for entry boundaries
or managed markers.

Previously deleted unrelated settings cannot be reconstructed without a backup;
this repair prevents further loss and does not invent those settings.

## Isolation and validation {#validation}

The smoke harness and traditional test runner isolate HOME, client path
overrides, XDG paths, Windows application directories, and HypAware config
before loading test code. A temporary HYP_HOME alone does not isolate native
client settings or histories. Regression coverage must exercise the real
scheduled and explicit detach paths, markerless repair, custom selections,
user-owned providers, idempotence, and unrelated settings inside markers.

`node scripts/check-codex-saved-provider.js /absolute/path/to/codex` exercises
the installed CLI or Desktop-bundled app server in a disposable home. It first
reproduces the missing-provider error from a synthetic saved rollout, applies
the real settings repair, then checks `thread/resume` retains the saved provider
and message while `thread/start` retains the custom default. The child uses an
allowlisted environment and file-only credential storage, without credentials
or `turn/start` requests. This proves synthetic app-server resume; authenticated
inference and the Desktop UI remain separate acceptance checks.

Work is a fixed number of linear passes over one config file and a single
atomic write when needed. Repair does not scan session history, add a daemon
cache, or grow with uptime.
