# LLP 0187: Reconciler refused marker, implementation plan

**Type:** plan
**Status:** Active
**Related:** LLP 0184, LLP 0186
**Generated-by:** neutral

> [LLP 0186](./0186-reconciler-refused-marker.design.md) is the technical
> design for option (1) from LLP 0184's proposed directions, decided by the
> maintainer in [hyparam/hypaware#601](https://github.com/hyparam/hypaware/issues/601):
> a terminal `refused` marker state that short-circuits the reconciler
> unconditionally, surfaces as attention-needed in `hyp status`, and clears
> only on an explicit `hyp attach` re-run. It already names every file,
> function, and call shape and resolves every fork the issue left open. This
> plan turns those sections into an eight-task graph with real code-dependency
> edges, verified line-for-line against the actual tree rather than assumed
> from the design's prose alone.

## How this refines the design

The design's sections map close to 1:1 onto tasks. Three things verified
against the real tree, not fully spelled out in the design's own prose:

- **The OpenClaw ownership-conflict refusal site is a single, precise line**:
  `hypaware-core/plugins-workspace/openclaw/src/attach.js:159`,
  `return fail(span, attachCtx, logger, settingsPath, reason, 'refused')`
  inside `conflictingProviderKeys`'s non-empty branch. `fail()` (the shared
  helper five call sites use, lines 405-425) hardcodes `status: 'failed'` on
  both the CLI-facing `writeAttachOutput` payload and its own return value.
  The design says only the ownership-conflict call site's *returned*
  `ActionOutcome` changes to `'refused'`; it says nothing about the printed
  `--json`/prose attach output changing shape. T5's brief is explicit about
  this distinction because `fail()` is shared: widening its `status`
  parameter (or bypassing it for this one call site) without also drifting
  `writeAttachOutput`'s wire format is the part a mechanical read of the
  design could get wrong.
- **The JSONC refusal has zero existing test coverage.** A repo-wide search
  (`grep -rl JSONC test/`) finds nothing outside
  `hypaware-core/plugins-workspace/claude/src/settings.js` itself: no test
  file exercises `looksLikeJsonc`'s throw site at all today. T6 is not "add
  one more case to an existing suite", it is the first test this refusal
  path has ever had.
- **Two OpenClaw tests assert the exact string `'failed'` against the
  refusal outcome and must change, not just gain coverage**:
  `test/plugins/openclaw-attach.test.js:158`
  (`'attach refuses without writing when a provider key already exists
  (R2)'`) and `:281` (`'an entry that is not ours still refuses, however
  close it looks (R2)'`). Both assert `outcome.status === 'failed'` against
  the ownership-conflict path T5 migrates to `'refused'`; leaving them
  unchanged would make T5 fail its own test suite by design, so updating
  them is part of T5's brief, not a follow-up.

Everything else maps directly onto the design's own section structure.

## The task graph

**First wave (deps `[]`), two-wide:**

- **T1**, the type widening (`src/core/config/types.d.ts`): the seam every
  other task's types rest on.
- **T8**, the re-arm (`src/core/commands/clients.js`): genuinely
  independent of the rest of the design. `clearClientActionMarker` already
  exists (`src/core/config/action_reconciler.js:455`) and is marker-status-
  agnostic; per the design, calling it unconditionally after a successful
  manual attach is correct whether or not a `refused` marker ever existed at
  that key ("clearing a non-existent problem is a no-op"). It needs no new
  type and no new module.

**Second wave (deps `[T1]`), three-wide:**

- **T2**, the `action_refusal.js` convention: the additive marked-Error
  module that carries the transient/permanent bit across the kernel's
  throw-only `attach(): Promise<void>` seam. Depends on T1 only for the new
  `ActionRefusalError` interface to import via `@import`.
- **T3**, the reconciler engine (`src/core/config/action_reconciler.js`):
  the unconditional `refused` short-circuit, the third outcome branch, the
  reverse-gap widening, and `runOutcome()`'s accepted-shape check. Depends
  on T1 for `ActionMarkerStatus`/`ActionOutcome`/`ReconcileActionResult`.
  Does **not** depend on T2: the reconciler engine never calls
  `markActionRefused`/`isActionRefused` itself, only `action_attach.js`
  (T4) and the two adapters (T5, T6) do.
- **T7**, the `hyp status` attention-needed surface
  (`src/core/daemon/types.d.ts`, `src/core/daemon/status.js`,
  `src/core/commands/status.js`): a pure read off whatever is in the marker
  store. Depends on T1 for `ClientActionState`, not on T3: a test can
  hand-write a `refused` marker fixture without the reconciler ever having
  run one.

**Third wave (deps `[T2]`), three-wide:**

- **T4**, `action_attach.js`'s `perform()` catch: the narrow translation
  point (`isActionRefused(err) ? 'refused' : 'failed'`).
- **T5**, the OpenClaw migration: `attach.js`'s ownership-conflict call
  site, `types.d.ts`'s `OpenclawAttachOutcome` widening, `index.js`'s
  wrapper widening to throw a marked Error on `'refused'`.
- **T6**, the Claude migration: `settings.js`'s `looksLikeJsonc` throw site
  wrapped with `markActionRefused`.

T4, T5, and T6 all depend on T2 (the shared module) but touch disjoint files
and do not depend on each other: any merge order among the three leaves the
tree buildable, and the full refusal pipeline (adapter marks -> `perform()`
reads -> reconciler writes `refused`) only becomes true end-to-end once T2,
T3, T4, and at least one of T5/T6 have all landed. That is expected, the
same way LLP 0173's T2/T4 both fed T5 without depending on each other.

## Rating complexity: the hard parts, by name

Two tasks earn a 4, both because a wrong branch is a silent regression of
the exact bug LLP 0184 reports, not a crash:

- **T3 (reconciler engine): 4.** The forward-gap loop currently reads
  `if (existing && existing.status === 'done' && markerIsCurrent(...))`
  (line 139) and branches outcome-handling as `if (outcome.status ===
  'done') {...} else {...failed...}` (lines 146-221); after T1 widens
  `ActionOutcome.status` to three values, a bare `else` silently swallows
  `refused` into the `failed` branch, which would write a **retried**
  marker for what the adapter reported as a permanent refusal, reproducing
  LLP 0184's `attempts: 17` bug under a different label. The reverse-gap
  drop condition (line 255) has the same silent-failure shape in the other
  direction: forgetting to add `refused` there means a `refused` marker for
  a key the config stops naming is retried forever by `reverse()` instead
  of being dropped or routed correctly. Both are exactly and only what the
  design specifies ("two checks in sequence", "treats `refused` the same
  way `failed` is treated there"), so this is well-specified work, not open
  judgement, but the cost of a small mistake is a silent regression a test
  suite could still pass if the wrong assertion is written alongside it.
- **T5 (OpenClaw migration): 4.** The refactor of `fail()` (shared by five
  call sites, only one of which needs to start returning `'refused'`)
  without changing the other four's behavior, the CLI-facing
  `writeAttachOutput` wire shape, or introducing a `status` parameter that a
  future call site could pass wrong, is a real design decision the design
  document names the destination for but not the mechanism. Getting it
  wrong produces a config-valid OpenClaw attach that silently keeps
  retrying a refusal, the field bug this whole change set exists to fix.

Everything else is mechanical: type widening (T1), a small new module with
two pure functions (T2), a one-line catch-branch translation (T4), a single
throw-site wrap with no existing test to break (T6), three files' worth of
read-only status rendering against an exact spec (T7), and one function call
mirroring an existing, closely-precedented call site (T8, `clients.js:1164`'s
detach-side `clearClientActionMarker` call). Rated 1-3 accordingly.

## Deferred items, not planned here

Per the design's own "Explicitly out of scope" section and the maintainer's
instructions in issue #601, this plan schedules none of:

- **`attempts`-bounding on transient `failed` markers.** LLP 0184's own open
  question, left open by the design; no task here touches it.
- **The `isCurrent`-style automatic re-arm** for `refused` markers (the
  LLP 0086 precedent named as a follow-up candidate). T8 builds only the
  explicit `hyp attach` re-run the maintainer asked for.
- **Any change to `hypaware-plugin-kernel-types.d.ts`'s `attach():
  Promise<void>` contract.** The design rejected widening it; T2's marked-
  Error convention is the chosen alternative, and no task here revisits
  that call.
- **Any edit to what LLP 0041 itself says.** LLP 0041's `Extended-by:` line
  already names LLP 0186; no task in this plan touches LLP 0041's own text.

## Notes for implementers

- `@ref` annotations land with the code that realizes them: T3 cites
  LLP 0184 (the coverage anchor already on LLP 0186) and LLP 0041
  (extension, not edit); T5 cites LLP 0167#attach-detach (the ownership
  check this refusal already implements) alongside whatever new `@ref` the
  status widening earns; T8 cites LLP 0045#part-3 the same way the existing
  detach-side call does. Run `/ref-check` on touched files before each
  task's PR.
- T5's brief needs to explicitly preserve `writeAttachOutput`'s existing
  `status: 'failed'` wire value for the ownership-conflict path (only the
  internal `ActionOutcome` the reconciler sees becomes `'refused'`); the two
  test assertions at `openclaw-attach.test.js:158` and `:281` are the
  concrete proof this was gotten right or wrong.
- T2 exists before any of T4/T5/T6 need it, so none of the three has to
  invent a placeholder shape for `markActionRefused`/`isActionRefused` and
  reconcile it later.
- No task here flips any LLP's `Status`: LLP 0186 is already `Active`, and
  this plan introduces no design needing a shipped-marker flip.

## References

- [LLP 0186](./0186-reconciler-refused-marker.design.md): the technical
  design this plan schedules
- [LLP 0184](./0184-reconciler-retries-permanent-failures.issue.md): the
  request LLP 0186 designs a fix for
- [LLP 0041](./0041-central-config-client-actions.design.md): the marker-
  state design this document's design extends (its `Extended-by:` line
  already names LLP 0186)
- [LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md): the
  `isCurrent` freshness-hook precedent named as a follow-up, not built here
- `src/core/config/action_reconciler.js`, `src/core/config/types.d.ts`,
  `src/core/config/action_attach.js`: the reconciler engine and the widened
  type seam (T1, T3, T4)
- `hypaware-core/plugins-workspace/openclaw/src/attach.js`,
  `hypaware-core/plugins-workspace/openclaw/src/index.js`,
  `hypaware-core/plugins-workspace/openclaw/src/types.d.ts`: the first
  migrated adapter (T5)
- `hypaware-core/plugins-workspace/claude/src/settings.js`: the second
  migrated call site (T6)
- `src/core/daemon/status.js`, `src/core/daemon/types.d.ts`,
  `src/core/commands/status.js`: the `hyp status` attention-needed surface
  (T7)
- `src/core/commands/clients.js`: `hyp attach`'s success path, where the
  explicit re-arm clear is added (T8)
- `llp/0173-openclaw-two-lane-capture.plan.md`: format precedent for this
  plan's task-graph and complexity-rating structure

## Tasks

- id: T1  branch: task/reconciler-refused-marker/T1  deps: []        complexity: 2  -- src/core/config/types.d.ts: widen `ActionMarkerStatus` from `'done' | 'failed' | 'applied'` to add `'refused'`; widen `ActionOutcome.status` from `'done' | 'failed'` to add `'refused'`; widen `ReconcileActionResult.outcome` from `'done' | 'skipped' | 'failed' | 'reversed'` to add `'refused'`; add a new `ActionRefusalError` interface extending `Error` with one required `hypActionRefused: true` field; revise `ActionMarker`'s doc comment to note a refused marker reuses `at` (terminal-state time, like `done`) and `reason` (like `failed`), carries no `attempts`, and preserves `installed_assets` across rewrites the same way `done`/`failed` do. Test: no dedicated test file (pure type/interface widening); confirms clean by every consumer in T2-T7 typechecking against the new shapes with no `any` fallback.
- id: T2  branch: task/reconciler-refused-marker/T2  deps: [T1]      complexity: 2  -- New src/core/config/action_refusal.js: `markActionRefused(err: Error): ActionRefusalError` sets `hypActionRefused: true` on the passed Error and returns it; `isActionRefused(err: unknown): boolean` returns `err instanceof Error && err.hypActionRefused === true`, tolerant of any non-Error or unmarked throw. Sibling module to the existing action_attach.js / action_backfill.js in the same directory. Test: new test/core/action-refusal.test.js: a thrown, marked Error round-trips through isActionRefused as true; a plain `new Error(...)` and a non-Error throw (e.g. a string) both read as false.
- id: T3  branch: task/reconciler-refused-marker/T3  deps: [T1]      complexity: 4  -- src/core/config/action_reconciler.js: in the forward-gap loop, widen the short-circuit at line 139 to two checks in sequence: a `refused` marker skips unconditionally (no `markerIsCurrent` consultation), a `done` marker skips through the existing `markerIsCurrent()` gate unchanged. Replace the bare `if (outcome.status === 'done') {...} else {...failed...}` (lines 146-221) with a third branch, `else if (outcome.status === 'refused')`, that writes `{ status: 'refused', request_key, reason, at }` (no `attempts`), carries forward `installed_assets` from `existing` the same way the `done` branch does (reuse `readInstalledAssets(existing)`, lines 167-170's pattern), pushes `{ kind, requestKey, outcome: 'refused', reason }` onto `results`, and logs `log.error('client_action.refused', { [Attr.COMPONENT]: 'action-reconciler', [Attr.OPERATION]: 'client_action.perform', kind, request_key, [Attr.STATUS]: 'failed', [Attr.ERROR_KIND]: 'action_refused', detail: reason })`. In the reverse-gap loop, widen the drop condition at line 255 from `marker.status === 'failed'` to `(marker.status === 'failed' || marker.status === 'refused')`, so an assetless `refused` marker for a no-longer-desired key is dropped like an assetless `failed` one, and one carrying `installed_assets` is routed to `reverse()`. Widen `runOutcome()`'s accepted-shape check (line 349) from `outcome.status === 'done' || outcome.status === 'failed'` to include `'refused'`. Test: extend test/core/action-reconciler.test.js: a fake handler whose `perform()` returns `{status:'refused', reason}` once then would return `done` on a second call: a second `reconcile()` pass still reports `skipped`, proving the unconditional short-circuit (unlike a `done` marker with `isCurrent() => false`); the written marker has `status:'refused'`, `reason`, `at`, no `attempts`, and preserves a carried `installed_assets`; the reverse-gap drops an assetless `refused` marker and routes an asset-bearing one to `reverse()`.
- id: T4  branch: task/reconciler-refused-marker/T4  deps: [T2]      complexity: 1  -- src/core/config/action_attach.js: import `isActionRefused` from `./action_refusal.js`; change `perform()`'s catch (currently `catch (err) { return { status: 'failed', reason: err instanceof Error ? err.message : String(err) } }`, lines 166-170) to `catch (err) { return { status: isActionRefused(err) ? 'refused' : 'failed', reason: err instanceof Error ? err.message : String(err) } }`. Test: extend test/core/action-attach.test.js: a mocked `registration.attach()` that throws a `markActionRefused`-marked Error makes `perform()` return `{status:'refused', reason}`; the existing "perform() returns failed when the adapter throws (file not writable)" case (line 382) keeps returning `'failed'` for an unmarked throw.
- id: T5  branch: task/reconciler-refused-marker/T5  deps: [T2]      complexity: 4  -- hypaware-core/plugins-workspace/openclaw/src/types.d.ts: widen `OpenclawAttachOutcome` from `{status:'done'} | {status:'failed', reason:string}` to add `{status:'refused', reason:string}`. hypaware-core/plugins-workspace/openclaw/src/attach.js: the `conflictingProviderKeys` non-empty branch (line 159, currently `return fail(span, attachCtx, logger, settingsPath, reason, 'refused')`) must return `{status:'refused', reason}` as its `ActionOutcome`, while the printed `--json`/prose attach output (`writeAttachOutput`'s payload, and `fail()`'s own `span`/log side effects) keeps reporting `status: 'failed'` exactly as today: do not let `fail()`'s shared five-call-site shape drift for the other four `errorKind` values (`settings_path`, `endpoint`, `read`, `write`), which stay `{status:'failed'}` unchanged. hypaware-core/plugins-workspace/openclaw/src/index.js: import `markActionRefused` from `../../../../src/core/config/action_refusal.js`; widen the wrapper (currently `if (outcome.status === 'failed') throw new Error(outcome.reason)`, line 187) to add `if (outcome.status === 'refused') throw markActionRefused(new Error(outcome.reason))` alongside the unchanged `'failed'` branch. Test: update test/plugins/openclaw-attach.test.js: line 158's `assert.equal(outcome.status, 'failed')` in "attach refuses without writing when a provider key already exists (R2)" becomes `assert.equal(outcome.status, 'refused')`; line 281's equivalent assertion in "an entry that is not ours still refuses, however close it looks (R2)" likewise becomes `'refused'`; the existing "a missing openclaw.json is a hard failure" (line 388) and "a malformed openclaw.json is a hard failure" (line 402) tests are unchanged, asserting `'failed'` still, proving the four non-ownership `errorKind`s did not migrate.
- id: T6  branch: task/reconciler-refused-marker/T6  deps: [T2]      complexity: 2  -- hypaware-core/plugins-workspace/claude/src/settings.js: import `markActionRefused` from `../../../../src/core/config/action_refusal.js`; wrap the JSONC throw site (lines 327-333, `throw new ClaudeSettingsError(..., {code:'JSONC', cause: err})`) with `throw markActionRefused(new ClaudeSettingsError(..., {code:'JSONC', cause: err}))`, preserving the existing message and `code`. The other `ClaudeSettingsError` throw sites (`MALFORMED_JSON`, `NOT_AN_OBJECT`, `CONCURRENT_EDIT`, `INVALID_PORT`, `INVALID_VERSION`, `INVALID_STATE_FILE`, the two plain read/stat failures) are unchanged. index.js's `attach()` catch (lines 232-235, `catch (err) { ...; throw err }`) needs no change: it already rethrows the original error unchanged, so the mark survives. Test: this refusal path has no existing test coverage anywhere in the repo (confirmed by `grep -rl JSONC test/` returning nothing): add a new case to test/plugins/claude-settings-attach.test.js constructing a settings.json fixture containing a `//` comment (JSONC), calling `attach()`, and asserting the thrown error is recognized by `isActionRefused` from src/core/config/action_refusal.js; add a companion case for one other `ClaudeSettingsError` code (e.g. malformed non-JSONC JSON) asserting it is NOT recognized as refused.
- id: T7  branch: task/reconciler-refused-marker/T7  deps: [T1]      complexity: 3  -- src/core/daemon/types.d.ts: widen `ClientActionState` from `'done' | 'failed' | 'pending' | 'n/a'` to add `'refused'`, extending the doc comment with a `refused` bullet (terminal, needs `hyp attach <requestKey>`, carries `reason`+`at`, never degrades `overall`); `ClientActionReport` needs no new field. src/core/daemon/status.js: in `buildClientActionsReport` (starting line 831), add a branch between the existing `marker.status === 'failed'` check (line 922) and the generic `else if (marker)` fallthrough (line 931): `else if (marker && marker.status === 'refused') { actions.push({ kind, requestKey, state: 'refused', ...(typeof marker.reason === 'string' ? {reason: marker.reason} : {}), ...(typeof marker.at === 'string' ? {at: marker.at} : {}) }) }`. src/core/commands/status.js: the `client_actions[]` JSON mapping (lines 267-278) needs no change (state/reason/at already forward verbatim through the existing optional spreads); the prose render loop (lines 462-480) gains an `else if (a.state === 'refused')` branch between the existing `done`/`failed` branches, reusing the `failed` branch's `reason` rendering and appending a fixed hint: `` `... [refused]  (${reason})  run 'hyp attach ${a.requestKey}' after fixing the cause` ``. Test: extend test/core/status-client-actions.test.js: a mixed marker store (one `done`, one `failed`, one `refused`) renders all three correctly with `refused` carrying `reason`/`at` and no `rows`/`attempts`/`lastAttempt`; `overall` stays `healthy` with the `refused` entry present (mirrors the existing "a failed backfill does not flip overall to degraded" test at line 194); the JSON renderer test (line 235) gains a `refused` case asserting `state: "refused"`; the text renderer test (line 259) gains a case asserting the repair-hint line's exact text.
- id: T8  branch: task/reconciler-refused-marker/T8  deps: []        complexity: 2  -- src/core/commands/clients.js: in `runClientLifecycle`'s attach branch, after `await client.attach({endpoint, config:{}, stdout, stderr, dryRun: parsed.dryRun, json: parsed.json})` (lines 419-426) resolves without throwing, call `clearClientActionMarker({ stateRoot: readObservabilityEnv(ctx.env).stateDir, kind: 'attach', requestKey: name })`, mirroring the existing detach-side call (line 1164) including its best-effort try/catch (a marker-store I/O failure logs a warning via `getLogger('cmd-attach')` and must never fail the attach that just succeeded). Import `clearClientActionMarker` from `../config/action_reconciler.js` if not already imported in this file (it is already imported for the detach path per line 18). Test: new test/core/attach-refused-rearm.test.js, mirroring test/core/detach-rejoin-recovery.test.js's pattern: pre-seed a `refused` marker in the client-actions store for a client, run `hyp attach <client>` against a mocked successful registration, assert `readClientActionStatus` shows no entry at that request key afterward, and assert a subsequent `reconcile()` pass (against a handler that would now report `done`) re-`perform()`s and writes a fresh `done` marker; a companion case where the mocked `attach()` throws asserts the `refused` marker is left in place (never cleared on a failed manual attach).
