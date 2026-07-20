# LLP 0121: the hermes adapter ships bundled, not as a standalone repo

**Type:** Decision
**Status:** Draft
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0002, LLP 0005, LLP 0007, LLP 0008, LLP 0118, LLP 0120, LLP 0122

> `@hypaware/hermes` lives in this repo at
> `hypaware-core/plugins-workspace/hermes/`, beside `claude` and `codex`,
> rather than as a standalone installable repo like `@hypaware/github`.

## Context

Two packaging precedents exist:

- **Bundled:** `@hypaware/claude`, `@hypaware/codex`, `@hypaware/otel` live in
  `hypaware-core/plugins-workspace/` and ship with the product
  ([LLP 0002](./0002-v1-scope.decision.md)).
- **Standalone:** `@hypaware/github` lives in its own repo with its own LLP
  corpus and installs via `hyp plugin install`
  ([LLP 0007](./0007-plugin-install-and-locking.decision.md)).

Which home does a hermes adapter get?

## Decision

**Bundled.** The deciding line is which contract surface the plugin couples
to:

- The hermes adapter is the same species as claude and codex: a client
  adapter that feeds `ai_gateway_messages` through the
  `ai_gateway.projected_exchange` materializer
  ([LLP 0120](./0120-hermes-rows-are-ai-gateway-messages.decision.md)) and the
  shared backfill scan utilities (`src/core/backfill/scan_util.js`) and
  usage-policy resolver (`src/core/usage-policy/`). Those are **in-repo
  contracts** that evolve with the repo; an out-of-repo adapter would chase
  them across releases. `@hypaware/github` is standalone precisely because it
  does the opposite: it brings its own dataset (`github_events`) and couples
  only to stable kernel surfaces and a versioned capability.
- Bundling gives hermes the same traditional-test, hermetic-smoke, and
  type-check infrastructure the sibling adapters use, and keeps this LLP
  cluster and the code in one tree (one commit lands doc and implementation
  together, per the living-docs rule).
- Symmetry has diagnostic value: when the materializer contract changes, the
  three adapters change in the same commit and the same review.

## Why not a standalone repo

- A standalone `hypaware-hermes` needs the LLP 0007 release machinery (CI
  building `dist/`, tagged prebuilt artifacts, lock-file pins) for a plugin
  whose only consumers are HypAware installs that already carry the bundle.
- Cross-repo coupling to `src/core/backfill/` and the materializer item shape
  would either freeze those internals into a public contract prematurely or
  break the plugin regularly. Neither is worth it for one adapter.
- Nothing is foreclosed: if the adapter later stabilizes against public
  kernel surfaces only, extracting it to a repo is mechanical and would be a
  new decision superseding this one.

## Consequences

- The plugin appears in the default bundle; whether a given machine runs it
  is config ([LLP 0010](./0010-config-model.spec.md)), and on fleet-joined
  hosts the layered-config rules apply unchanged
  ([LLP 0031](./0031-layered-config.decision.md)): central may name and lock
  it, local may add it where central is silent.
- With no hermes installation present the source idles per spec R9; bundling
  therefore costs non-hermes machines nothing but a probe.
- Entrypoint and dependency rules for bundled plugins
  ([LLP 0008](./0008-plugin-runtime-dependencies.decision.md)) apply: single
  pre-bundled entrypoint, no runtime dependency installation. This constrains
  the SQLite reader choice
  ([LLP 0122](./0122-hermes-log-forwarding.design.md#sqlite)).
