# HypAware — Context & Glossary

This file is a glossary of the domain language used in HypAware. It is not a
spec or a design doc — it defines terms so that code, docs, and conversation
use the same words to mean the same things.

## Glossary

### Source

A thing HypAware can capture signals from. In the first-run wizard the
user-facing sources are `claude`, `codex`, `raw-anthropic`, `raw-openai`, and
`otel`. Sources divide into two kinds:

- **Client source** — a known tool HypAware configures for you. `claude` and
  `codex` are the client sources. Picking one adds its gateway upstream *and*
  its adapter plugin (`@hypaware/claude` / `@hypaware/codex`), which attaches
  the tool (rewrites its base URL), installs hooks/skills, and can backfill
  its local history. Client sources are the only sources that can be
  [[autodetect]]ed.
- **Raw proxy source** — `raw-anthropic` / `raw-openai`. Picking one opens the
  gateway with that provider upstream but configures no client; the user
  points their own SDK app or script at the local gateway by hand. Serves the
  "observe my own AI app" persona. Not autodetectable — there is no installed
  tool to find.

`otel` is a third shape: a local OTLP receiver for apps that export
OpenTelemetry signals. Like a raw proxy source, it is manual and not
autodetectable.

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
retention defaults to 30 days. Defaults hold whether or not any source is
detected, and the user can change them. Contrast [[autodetect]], which is
driven by what is actually present on the system.
