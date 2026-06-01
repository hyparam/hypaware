# LLP 0007: Plugin Install and Locking

**Type:** Decision
**Status:** Active
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0002, LLP 0008

> How plugins are named, resolved, fetched, and pinned. Decomposed from
> `hypaware-design.md` (Plugin Install and Locking).

> **V1 note:** first-party plugins ship bundled in this repo
> ([LLP 0002](./0002-v1-scope.decision.md#plugin-packaging-divergence)).
> This install path is the long-term direction and the path third-party plugins
> already take; it is not a V1 cutover gate.

## Single install surface

All plugins install through one CLI surface: `hypaware plugin install <name>`.
The resolver tries, in order:

1. `@hypaware/<name>` — first-party scope → `github:hyperparam/hypaware-<name>`
2. `@scope/hypaware-plugin-<name>` — third-party scoped → npm registry
   `repository` URL
3. `hypaware-plugin-<name>` — third-party unscoped → same path as (2)

Scoped community plugins (`@acme/hypaware-plugin-foo`) must be installed by full
name; short-name resolution cannot guess the scope.

## Namespacing (ESLint-style)

Any package under `@hypaware/<name>`, `@scope/hypaware-plugin-<name>`, or
`hypaware-plugin-<name>` is expected to expose a HypAware manifest; discovery
scans filter by these patterns. The `@hypaware/` scope is reserved for
first-party.

## Install path: git artifact, never `npm install`

The kernel fetches a **prebuilt artifact from git**: clone/tarball the resolved
ref, read the manifest, copy the tree into the install root. The plugin's own CI
commits its built `dist/` to the release tag named in the manifest `version`.
**The kernel never runs `npm install` on the user's machine** — npm is a naming
authority and metadata lookup, not an install source. See
[LLP 0008](./0008-plugin-runtime-dependencies.decision.md).

## Install root and lock file

```text
~/.hyp/hypaware/plugins/<plugin-name>/
~/.hyp/hypaware/plugin-lock.json
```

Lock entries record: plugin name, installed version, source spec (including
resolved short-name expansion), resolved git commit, artifact content hash,
manifest hash, install time, last update check, and available-update metadata.
Startup update checks are best-effort, cached, silent, and share policy with the
existing npm update check.
