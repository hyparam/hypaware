# LLP 0008: Plugin Runtime Dependencies

**Type:** Decision
**Status:** Active
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0005, LLP 0007

> Why plugins are pre-bundled pure JS. Decomposed from `hypaware-design.md`
> (Plugin Runtime Dependencies).

## Decision

Every plugin ships a **self-contained, pre-bundled JavaScript entrypoint** built
by its own CI. The kernel does not run `npm install` on the user's machine, does
not compile native modules, and does not bring in non-JS runtimes. V1 supports
**pure-JS plugins only**; the plugin's CI bundles all transitive deps into the
manifest `entrypoint`.

## Deliberately ruled out at V1

- `npm install` at user install time — too many failure modes.
- Plugin-declared peer deps on host-provided libs — couples plugins to the
  kernel version.
- In-process native modules — would require a C toolchain on every machine.
- Any plugin runtime that isn't pure JS in-process. Native modules and non-JS
  runtimes (Python, ffmpeg, …) are out of scope; the kernel provides no
  host-side process supervisor, and anything needing one is post-V1.

## Consequences

- **Version conflicts dissolve.** Each plugin's bundle carries its own copy of
  its deps. The duplication is real but predictable — the same tradeoff browser
  and VS Code extensions make.
- **Private files stay private.** The kernel loads each plugin only through its
  manifest `entrypoint`; cross-plugin imports must go through
  `ctx.requireCapability(...)` ([LLP 0006](./0006-dependencies-and-capabilities.spec.md)).
  Plugins should declare a package.json `exports` map exposing only the
  entrypoint, so a deep import is a loader error, not a silent coupling.
