# LLP 0068: session opt-out — implementation plan

**Type:** plan
**Status:** Active
**Systems:** Gateway, Plugins, Sources
**Generated-by:** neutral
**Date:** 2026-07-06
**Related:** LLP 0067, LLP 0066

> Executable breakdown of [LLP 0067](./0067-session-opt-out.design.md), which
> realizes the [LLP 0066](./0066-session-opt-out.spec.md) spec (issue #220).
> Three tasks along the design's two seams: the gateway control surface first
> (inert until consumed, so independently mergeable), then the adapter drops
> that consume it, then the cross-cutting R8 verification matrix and smoke.

Task shape:

- **T1 — gateway control surface** (all `@hypaware/ai-gateway` + kernel types).
  The `/_hypaware/` local control-path short-circuit in `proxy.js` (before
  `matchUpstream`, no exchange started), the new `control.js` route module
  (`POST`/`DELETE /_hypaware/ignore/session`, idempotent, `{session_id,
  ignored, total}`, 400/404/405/413), `ignoredSessions: Set<string>` on
  `GatewayState` (survives `reload()`, dies with the process), the
  `isSessionIgnored` predicate threaded through
  `createAiGatewayMessageProjector` into the projector ctx
  (`AiGatewayExchangeProjectorContext` in `hypaware-plugin-kernel-types.d.ts`),
  `status()` counter, and the T1-scoped unit tests (control route, not-proxied,
  ctx threading). Merges green with zero behavior change for LLM traffic:
  nothing consumes the set yet. Rated 4: the control-path concept is new
  gateway architecture (routing-order correctness against catch-all upstreams,
  recorder bypass, set lifetime vs reload), not a mechanical wire-up.
- **T2 — adapter drops** (all `@hypaware/claude` + `@hypaware/codex`). The
  session-keyed `USAGE_POLICY_DROP` in `claude/src/projector.js` (right after
  `resolveClaudeSessionId`) and `codex/src/exchange-projector.js` (hoist
  `conversationId`/`sessionId` resolution above `messagesForTransport`, test
  the exact stamped value), drop logs with `policy_source: 'session_opt_out'`,
  `@ref LLP 0066#enforcement` annotations, and per-adapter unit tests
  (Claude drop/no-drop; Codex whole-session over-drop across two threads).
  Rated 3: the seam, sentinel, and dispatcher handling all exist
  (`.hypignore` precedent); the only judgment is the R5 key-equivalence
  reasoning and the Codex hoist, both settled by the design.
- **T3 — R8 matrix + smoke** (tests only). The R7 independence matrix
  (`.hypignore` x session set), R3 restart-drops-state / reload-keeps-set
  tests, and the hermetic smoke
  `hypaware-core/smoke/flows/session_optout_capture_drop.js` (ignore → drop
  asserted via rows AND telemetry → unignore → resumes). Rated 3: mostly
  mechanical against existing smoke scaffolding (`hypignore_capture_drop.js`),
  but the smoke must assert both external behavior and the emitted drop
  telemetry per the log-driven house rules.

## Tasks
- id: T1  branch: task/session-opt-out/T1  deps: []      complexity: 4  -- gateway control-path (/_hypaware/*) + in-memory ignored-session set + POST/DELETE handlers returning .total + isSessionIgnored projector-ctx predicate
- id: T2  branch: task/session-opt-out/T2  deps: [T1]    complexity: 3  -- adapter projector drop keyed on resolved session_id -> USAGE_POLICY_DROP (Claude + Codex), policy_source telemetry + @refs
- id: T3  branch: task/session-opt-out/T3  deps: [T2]    complexity: 3  -- tests: Claude session==conversation, Codex over-drop, restart-drops-state + reload-keeps-set, independence from .hypignore, session_optout_capture_drop smoke
