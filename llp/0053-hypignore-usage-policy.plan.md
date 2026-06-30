# LLP 0053: hypignore usage policy — implementation plan

**Type:** plan
**Status:** Active
**Systems:** Sources, Gateway, CLI, Core
**Generated-by:** neutral
**Related:** LLP 0052, LLP 0049, LLP 0050
**Date:** 2026-06-29

> Implementation steps for the `.hypignore` usage policy designed in
> [LLP 0052](./0052-hypignore-usage-policy.design.md). Small, independently-mergeable
> tasks: the shared core matcher first, then the two adapters and the CLI in parallel,
> then a hermetic smoke. V1 enforces only the capture seam (LLP 0050) — no cache schema,
> export driver, or gateway change.

## Tasks
- id: T1  branch: task/hypignore-usage-policy/T1  deps: []          -- Core module `src/core/usage-policy/`: `format.js` (`parseHypignore` — strip `#`/blank lines, first token is the class; empty/comment-only ⇒ `ignore`; unknown/unimplemented token ⇒ `ignore` + a `warn` string, the privacy fail-safe), `matcher.js` (`createUsagePolicyResolver({readFileSync,existsSync})` — gitignore-style ancestor walk from a cwd to the nearest `.hypignore`, per-cwd memo cache, fs injected; `resolve(cwd)`→`{class,governedBy,declared}`, `isIgnored(cwd)`), `index.js` barrel, `types.d.ts` (`UsageClass`,`ResolveResult`,`UsagePolicyResolver`). Annotate `@ref LLP 0050 [implements]` on matcher, `@ref LLP 0049#file-format`/`#fail-safe`/`#scope [implements]`. Traditional tests in `test/core/usage-policy*.test.js` (empty⇒ignore, unknown⇒ignore+warn, nearest-ancestor wins, no file⇒full, cache stable).
- id: T2  branch: task/hypignore-usage-policy/T2  deps: [T1]        -- Claude adapter capture-seam drop (`@ref LLP 0050 [implements]`): in `claude/src/projector.js` `createClaudeExchangeProjector`, once the exchange `cwd` is resolved, `if (resolver.isIgnored(cwd)) return []` before building rows (the `ai-gateway/src/source.js` write guard then persists nothing — R2, live call untouched); in `claude/src/backfill.js`, skip ignored sessions before projecting/writing (R1). Hold one resolver per projector/backfill run. Tests: ignored cwd ⇒ `[]`/skip, clean cwd unaffected.
- id: T3  branch: task/hypignore-usage-policy/T3  deps: [T1]        -- Codex adapter capture-seam drop, symmetric to T2 (`@ref LLP 0050 [implements]`): `codex/src/exchange-projector.js` `createCodexExchangeProjector` returns `[]` for an ignored cwd; `codex/src/backfill.js` skips ignored sessions. Tests mirror T2.
- id: T4  branch: task/hypignore-usage-policy/T4  deps: [T1]        -- CLI verbs (`@ref LLP 0049#cli [implements]`) in `src/core/cli/core_commands.js` + `core_verbs.js`: `hyp ignore [path]` writes a self-documenting `.hypignore` (comment header + `ignore` token) at the git repo root (else cwd; explicit path overrides), idempotent (R5); `hyp unignore [path]` removes the governing file, idempotent; `hyp ignore --check [path]` reports ignored?/governing file/residual already-cached row count (prospective-only, no purge). Reuse the existing repo-root helper. Tests for idempotency + `--check` output.
- id: T5  branch: task/hypignore-usage-policy/T5  deps: [T2, T3, T4]  -- Hermetic smoke `hypaware-core/smoke/flows/hypignore_capture_drop.js`: drive one exchange from a `.hypignore`'d cwd and one from a clean cwd through the daemon; assert only the clean row lands in the cache and a `usage_policy_drop` event is emitted (stable `smoke_name`/`smoke_step`, log-driven). Register in the smoke flow index.

## Notes

- The design (LLP 0052) is already `Status: Active` (neutral-minted), so no status-flip task
  is needed — merging the change set ships it.
- T2/T3/T4 are independent after T1 and run in parallel; T5 closes the loop end-to-end.
- No task touches the cache schema, the export driver, `@hypaware/ai-gateway`, or settlement
  (`claude/src/settle.js`) — capture-seam only, per LLP 0050.
