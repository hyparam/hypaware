# LLP 0249: Focused CLI compatibility rollover

**Type:** Plan
**Status:** Draft
**Systems:** CLI, Plugins, Onboarding, Tests
**Author:** Phil / Codex
**Date:** 2026-08-18
**Related:** LLP 0009, LLP 0248

## Goal {#goal}

Ship LLP 0248's focused help and journey groups without removing a public
spelling or changing an existing command's side effects.

## Rollover boundary {#boundary}

This plan ships categorized help, canonical journey names, hidden compatibility
aliases, updated teaching, and equivalence evidence. It stops before alias
removal and before transactional `setup update`, `repair`, or `rollback`.

## Milestones {#milestones}

### M1: Focus help

- Add help category, audience, aliases, and semantic boot profile metadata.
- Render Getting started, Explore and share, Control capture and movement, and
  the compact Additional commands list.
- Keep config-active plugin help discovery activation-free.

### M2: Add journey routes

- Add `setup`, `client`, `privacy`, and `dev` canonical routes.
- Move cache mutation to direct top-level `cache`.
- Add `mcp serve` and `enrichment` while preserving their old aliases.
- Keep daemon, config, sink, plugin lifecycle, remote, graph operations, vector
  status, and version under their existing direct spellings.
- Implement `client status` from the overall status collector.

### M3: Plugin routes

- Add canonical graph query, vector query, enrichment, Claude account, and
  Claude Desktop routes with runtime and manifest aliases.
- Keep session top-level and hide credential/hook machine contracts.
- Withhold `source gascity` until attach and detach are durable.

### M4: Teach the interface

- Update help, status repairs, walkthrough copy, skills, and docs.
- Preserve exact hidden machine spellings in generated hooks and helpers.
- Reconcile the merged Claude OTEL surface: teach its listener, project its
  attach and capture health, and make `session status` read every live recorder
  before claiming the session is protected.

### M5: Evidence

- Snapshot the three journey sections and exact Additional commands list.
- Assert changed aliases resolve to the canonical registration and runner.
- Assert plugin aliases remain config-active-only.
- Assert `setup` uses `all-available` and no-plugin commands use `none`.
- Run traditional tests, typecheck, and CLI, walkthrough, attach, status, and
  package boot smokes.

## Follow-up slices {#follow-ups}

1. Persist Gas City attach and detach, then expose `source gascity`.
2. Convert vector search to a typed verb if remote parity is desired.
3. Reconcile Claude OTEL detach and purge semantics that remain after the
   status, session, manifest, picker, and attach dry-run gates in this rollover.
4. Design transactional setup lifecycle in a separate LLP.
5. Remove aliases only in a major version with usage evidence and a new LLP.

## Completion criteria {#completion}

- Help matches LLP 0248's section ordering and compact operations list.
- No `admin` or `fleet` group appears.
- Direct operational spellings remain direct.
- Canonical and compatibility spellings share runners and effects.
- Hidden machine contracts are callable and absent from help.
- Confirmation, destructive-action, privacy, and credential contracts do not
  change.

## References

- [LLP 0248](./0248-task-oriented-cli-rollover.decision.md)
- [LLP 0009](./0009-cli-registry.spec.md)
- `research/2026-08-18-cli-command-semantics/REPORT.md`
