# LLP 0002: V1 Scope and Cutover Decisions

**Type:** Decision
**Status:** Active
**Systems:** Core, Process
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0000, LLP 0007, LLP 0011, LLP 0017

> These are the *as-shipped* decisions for V1, lifted from `finish-v1.md` before
> it was tombstoned. Where they diverge from the broader target architecture in
> the design doc, **these decisions win** — they describe what HypAware actually
> does today. v1.0.0 has shipped.

## V1 target

> A fresh user can run `npx hypaware`, choose what to capture, install a
> persistent daemon, attach Claude Code and/or Codex when selected, and query
> locally captured logs/traces/metrics/conversations without manually installing
> plugins or editing config.

## Decisions

### Packaging and CLI identity

- Publish and run as **`hypaware`**. Keep **`hyp`** as a CLI alias.
- The npm package provides the `hypaware` binary required by `npx hypaware`.

See [LLP 0009](./0009-cli-registry.spec.md) for the command surface.

### First-run flow

- Keep the **interactive first-run picker** as the canonical onboarding path.
  See [LLP 0011](./0011-setup-and-onboarding.decision.md).

### Daemon install

- When daemon install is requested from `npx hypaware`, **install a persistent
  global package first, then point launchd/systemd at the stable global
  binary** (never at an ephemeral npx path). See [LLP 0017](./0017-daemon-runtime.decision.md).

### Plugin packaging divergence

- **First-party plugins remain bundled in this repo** under
  `hypaware-core/plugins-workspace`. This is a deliberate divergence from the
  design doc's target of one repo per plugin installed through the kernel's
  external-install path. The external-install machinery
  ([LLP 0007](./0007-plugin-install-and-locking.decision.md)) exists and is the
  long-term direction, but V1 does not gate on extracting plugins into separate
  repos.

### Out of V1 scope

- `@hypaware/central` and `@hypaware/gascity` are **not** V1 scope. They are
  present in the workspace but excluded from the default path and acceptance
  gates. Gascity remains the canonical external-plugin example for post-V1.
- **No Collectivus config or recording migration** is required for V1.

## V1 acceptance criteria (summary)

1. `npx hypaware` works from a fresh install, starts the picker on a TTY.
2. Picker can select Claude Code, Codex, raw Anthropic/OpenAI capture, OTEL,
   local cache, and local Parquet export.
3. Generated config is explicit and reproducible at `~/.hyp/hypaware-config.json`.
4. Daemon installs as a persistent user service (launchd / systemd user unit).
5. Daemon starts configured sources and runs the sink export loop.
6. Claude Code / Codex attach is idempotent and reversible.
7. Local query works against newly captured data.
8. V1 smokes emit a `DEV_RUN_ID` verifiable through `hyp query`.
9. V1 docs do not claim central, gascity, repo extraction, or migration ship.

Full historical phasing is preserved in the tombstoned plans
(`llp/tombstones/0018`, `llp/tombstones/0019`).
