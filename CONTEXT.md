# HypAware: Context & Glossary

This file is a glossary of the domain language used in HypAware. It is not a
spec or a design doc: it defines terms so that code, docs, and conversation
use the same words to mean the same things.

## Glossary

### Source

A thing HypAware can capture signals from. The picker sources are `claude`,
`codex`, `raw-anthropic`, `raw-openai`, and `otel`; the first-run wizard menu
offers `claude`, `codex`, and `otel`, the two raw proxy rows being **hidden**
(LLP 0202) rather than removed. Sources divide into two kinds:

- **Client source**: a known tool HypAware configures for you. `claude` and
  `codex` are the client sources. Picking one adds its gateway upstream *and*
  its adapter plugin (`@hypaware/claude` / `@hypaware/codex`), which
  [[attach]]es the tool, installs hooks/skills, and can backfill its local
  history. Client sources are the only sources that can be [[autodetect]]ed.
- **Raw proxy source**: `raw-anthropic` / `raw-openai`. Picking one opens the
  gateway with that provider upstream but configures no client; the user
  points their own SDK app or script at the local gateway by hand. Serves the
  "observe my own AI app" persona. Not autodetectable: there is no installed
  tool to find. Reached by `hyp init --source <id>` only: the rows are
  hidden from the menu because, carrying no adapter, they compose a working
  proxy that projects no rows (LLP 0202).

`otel` is a third shape: a local OTLP receiver for apps that export
OpenTelemetry signals. Like a raw proxy source, it is manual and not
autodetectable.

An `otel` picker source is not the same thing as "a source that speaks OTLP".
`@hypaware/claude` runs its own OTLP listener to receive Claude Code's
telemetry ([[attach]] mode `otel`, LLP 0257), on its own port, with its own
payload rules and its own datasets. That listener is claude-owned: a machine
attached that way still has `claude` as a **client source** here, autodetected
and configured for the user, and nothing about it turns on the `otel` source.
Picking `otel` is what a user does for *their own* app's telemetry.

### Attach

Writing a reversible block into a **client source**'s own configuration so that
what the tool does reaches HypAware, and being able to take it back out.
`hyp attach <client>` writes it, `hyp detach <client>` removes exactly those
keys and restores anything they displaced, and the undo record (the `_hypaware`
marker) lives in the file that was edited.

Attach is not one mechanism. Each client adapter picks a **mode**, and
`hyp status` names it (`claude  [configured, attached (otel)]`):

- **`base_url`**: point the tool's API base URL at the local gateway. `codex`
  attaches this way.
- **`proxy`**: set `HTTPS_PROXY` and trust a machine-local CA, so the gateway
  sees the tool's TLS traffic without its base URL being touched (LLP 0232).
- **`otel`**: turn on the tool's own OpenTelemetry export and point it at a
  HypAware listener (LLP 0258). No base URL, no proxy, no CA: the tool still
  talks straight to its provider and HypAware receives a copy of what it did.
  `claude` attaches this way.

The mode is worth naming because it decides what being attached costs: only
`proxy` installs CA trust, and only `base_url` and `proxy` put the HypAware
daemon on the request path.

### Autodetect

The first-run wizard inspecting the system for the presence of a **client
source** and pre-selecting (checking) it by default in the picker, while
leaving the user free to uncheck it. Only client sources (`claude`, `codex`)
are autodetected; raw proxy sources and `otel` are never autodetected because
there is no installed tool to find.

Autodetect sets only the *initial* checkbox state. It never forces a source
on, never hides one, and an undetected source can still be checked by hand.

Distinct from a [[default]]: autodetect is derived from system state; a default
is a fixed starting choice that holds regardless of what is on the system.

### Default

A fixed starting selection in the wizard that is not derived from system
state. The export choice defaults to `local-parquet` (pre-checked) and
retention defaults to 90 days. Defaults hold whether or not any source is
detected, and the user can change them. Contrast [[autodetect]], which is
driven by what is actually present on the system.
