# LLP 0173: OpenClaw two-lane capture, implementation plan

**Type:** plan
**Status:** Active
**Related:** LLP 0172
**Generated-by:** neutral

> [LLP 0172](./0172-openclaw-two-lane-capture.design.md) is the technical
> design for the one deliverable set LLP 0171 specifies: the reworked
> `@hypaware/openclaw` attach/detach module (Lane A), the daemon-side
> scheduled sweep (Lane B), the `json_path` core revival, the
> `openclaw-steering-plugin/` deletion, and the acceptance/onboarding
> rewrites. It already names the files, functions, and call shapes and
> resolves every fork LLP 0171 left open. This plan turns those ten sections
> into a thirteen-task graph with real code-dependency edges, states the two
> external blockers (PR #552, PR #553) that no task's `deps` field may
> absorb, and decides the hermetic-smoke scoping question the design left for
> this rung.

## How this refines the design

The design's sections map close to 1:1 onto tasks, with three departures
found while re-verifying the design against the actual tree (not assumed
from the design's prose alone):

- **The deletion inventory (design Section 5) is incomplete against the real
  tree.** `tsconfig.json`'s `include` array still lists
  `"openclaw-steering-plugin"` at line 19; deleting the package without
  dropping this line leaves a dead include path.
  `test/plugins/openclaw-client-registration.test.js` is not named in Section
  5 or R9, but it directly asserts the old no-op `attach()`'s
  `routing_owned_by`/`openclaw-steering-plugin` output (lines 39-114) and the
  premise that `descriptor.attachProbe` is `undefined` (lines 197-240): both
  assertions go false once Lane A and the manifest land, so this file needs
  a rewrite, not silent bit-rot, and not a delete (three of its six tests
  cover real, still-true resolution/adjacency behavior). Both are their own
  task (T10, T11) rather than folded into the design's named deletion, because
  neither is optional cleanup once discovered.
- **`hypaware-core/plugins-workspace/openclaw/src/projector.js` line 31**
  carries a stale comment ("Written by the `openclaw-steering-plugin`...")
  that Section 5's survivor list does not flag, because the design correctly
  treats the projector's *behavior* as unchanged; the *comment* describing
  who writes the header it gates on is now factually wrong once Lane A owns
  that write. Folded into T5 (manifest/copy task) rather than its own task,
  since it is a one-line prose fix riding the same "stop naming the steering
  plugin" sweep.
- **Sections 1 and 2 (attach, detach) are one design narrative but two
  independently shippable units.** `attach.js` (Section 1.2) has no runtime
  dependency on `detachJsonPathProviders` (Section 2.2); they only share a
  manifest field (Section 1.4) that gates both. Splitting them (T4, T2) lets
  either land first and still leaves the tree buildable, at the cost of the
  manifest task (T5) needing both as prerequisites.

Everything else maps directly onto the design's section numbers.

## The task graph

**First wave (deps `[]`), three-wide:**

- **T1**, kernel types (Sections 1.4, 2.1, 4.2): `PluginAttachProbeManifest`
  regains `'json_path'` in its format union plus `container_path`,
  `provider_keys`, `cache_glob` (reusing the existing `marker_header`), and
  `BackfillContribution` gains the optional `sweep?: { cron: string }` field.
  Revises, rather than deletes outright, the existing comment at the
  `json_path` removal site (`hypaware-plugin-kernel-types.d.ts` around line
  183) that warns re-adding the format without runtime support is dangerous:
  that warning is now satisfied by T2/T3, so the comment must say what
  changed and point at this plan, not simply vanish.
- **T4**, the new attach module (Section 1.1, 1.2, 1.3): `attach.js` plus
  `index.js`'s old no-op removal. Has no code dependency on T1 because
  `attach.js` never reads `PluginAttachProbeManifest`; it only writes the
  `models.providers` shape the manifest (T5) later declares a probe against.
- **T6**, config validation (Section 4.2, 4.5 second half): `config.js`'s
  `validateBackfillSection` gains `sweep_cron` and `quiesce_ms` together, in
  one task, because the section's unknown-key rejection loop would otherwise
  reject whichever key's task landed second as unrecognized for the window
  between the two merges.

**Second wave:**

- **T2** (deps `[T1]`), detach core (Section 2.1, 2.2) plus threading
  `expectedBaseUrl` through both real callers: `detachClientViaCore` in
  `src/core/commands/clients.js` (currently calls `detachClientFromDisk`
  with no `expectedBaseUrl`) and `action_attach.js`'s `reverse()` (currently
  calls `detach({descriptor, env: ctx.env})`; `ctx.endpoint` is already
  present in the same `ActionContext` `perform()` uses). Bundled into one
  task because a `detachJsonPathProviders` that no caller threads
  `expectedBaseUrl` into is untestable end-to-end and would ship as dead
  code for one merge.
- **T3** (deps `[T1]`), the `daemon/status.js` read branch (Section 2.3):
  pure read, structurally parallel to the existing `json`/`toml` branches at
  the current lines 1066/1083.
- **T7** (deps `[T1, T6]`), Lane B's kernel-facing metadata (Section 4.2
  second half, 4.3): `createOpenclawBackfillProvider`'s `sweep` field reading
  `config.backfill?.sweep_cron`, and narrowing `runBackfillProvider`,
  `runProvider`, `resolveOwnersForRun` (all in `src/core/commands/backfill.js`)
  from `CommandRunContext` to the new, smaller `BackfillRunnerContext`
  interface. Depends on T6 because reading `config.backfill.sweep_cron` in
  production is only meaningful once the validator accepts the key instead
  of rejecting a user's config that sets it.
- **T8** (deps `[T6]`), the quiesce window (Section 4.5, first half):
  `listSessionFiles(agentsDir)` gains `quiesceBeforeMs`; `runOpenclawBackfill()`
  computes `quiesceMs` from `config.backfill?.quiesce_ms` (default 180000,
  cited from `QUERY_FLUSH_DEBOUNCE_MS` in `src/core/cache/spool.js` plus a
  one-minute margin) and skips files whose `mtimeMs` is more recent.
  Independent of T7: this filter operates on file mtimes, not on the
  contribution's scheduling metadata.

**Third wave:**

- **T5** (deps `[T2, T3, T4]`), the manifest and copy (Section 1.4, 8.2):
  `hypaware.plugin.json` gains the `attach_probe` block, `description` and
  `picker[0].summary` lose every `@hypaware/openclaw-steering-plugin`
  reference, Claude's own picker entry gains the CLI-backend-routing line
  Section 8.2 asks for, and `projector.js`'s stale comment (found above) is
  corrected. Depends on all three because declaring a `json_path` probe
  before core can read it (T3) or reverse it (T2), or before `attach()`
  produces the shape the probe describes (T4), would make `hyp status` /
  `hyp detach openclaw` probe a format-shape nothing yet honors correctly.
- **T9** (deps `[T7, T8]`), the daemon sweep driver (Section 4.4): new
  `src/core/daemon/backfill_sweep.js`, `createBackfillSweepDriver({backfills,
  backfillMaterializers, env, config, storage})`'s `tick({now})` iterating
  `backfills.list()`, skipping contributions with no `sweep` field or a
  not-yet-due `cronMatches` (imported from `src/core/sinks/driver.js`), and
  firing `runBackfillProvider(...)` unblocked (`void`, matching
  `action_backfill.js`'s "never wedge the tick loop" discipline) rather than
  gating `runTick()` on it. Wired into `runtime.js`'s `runTick()` right after
  the existing `await driver.tick({now, source: 'daemon'})` call for the sink
  driver, riding the existing `DEFAULT_TICK_INTERVAL_MS = 60_000` loop rather
  than opening a second timer. **Flagged in Rating/External blockers below**:
  this is the task R8 warns about.

**Fourth wave:**

- **T10** (deps `[T5]`), rewrite the stale assertions in
  `test/plugins/openclaw-client-registration.test.js`: the two tests
  asserting `attach()`'s old no-op output matches `/openclaw-steering-plugin/`
  (lines 39-82, 84-114 in the current tree) must assert the new write
  (refusal-when-exists, the two-entry shape, the restart-instruction print)
  instead; the descriptor test asserting `descriptor?.attachProbe ===
  undefined` (lines 222-240) must assert the new `json_path` shape instead;
  the "honest no-op" detach test (lines 197-220) needs its R7-citing comment
  corrected (the no-op it observes on a fresh temp home is now the
  absent-settings-file guard, not a no-probe guard) and gains a companion
  case with a real `openclaw.json` fixture proving the ownership-based
  detach (T2) actually fires. The registration-order test (116-155) and the
  generic `hyp attach` resolution test (157-195) are unaffected; leave them.
- **T11** (deps `[T5]`), the steering-plugin deletion (Section 5, R9):
  `openclaw-steering-plugin/` in full (source, tests, manifest,
  `package.json`), `test/plugins/openclaw-steering-plugin.test.js`, and
  `tsconfig.json`'s stray `"openclaw-steering-plugin"` include entry (line
  19, not named in the design, found in this plan's own verification pass).
  Deliberately independent of T10 in the dependency graph: neither file
  T11 deletes is imported by `openclaw-client-registration.test.js` (it only
  contains string-regex assertions about steering-plugin *names*, not
  imports), so the two tasks do not block each other, but both must land
  after T5 per the "deletion strictly after its replacement" rule.
- **T12** (deps `[T8, T9]`), the hermetic smoke gap (Section 9): a new
  `backfill_openclaw_fixture` helper (mirroring `backfill_claude_fixture.js`
  / `backfill_codex_fixture.js` under `hypaware-core/smoke/flows`) writing a
  minimal OpenClaw v3 session JSONL in the nested-`message`-envelope shape,
  under a controllable-mtime `agents/<id>/sessions/` tree, plus a smoke flow
  exercising the quiesce skip (a file mtime inside the window is absent from
  the run) and a sweep-then-rerun dedupe assertion (identical `part_id`
  nets to zero new rows on a second sweep). **Externally blocked; see
  below.**
- **T13** (deps `[T5, T8, T9]`), `docs/ACCEPTANCE.md`'s `openclaw_capture`
  rewrite (Section 8.1): drops the steering-plugin link/enable setup and the
  `before_model_resolve`/`hooks.allowConversationAccess` version-gate
  language; adds the `hyp attach --client openclaw` setup step, a sweep step
  (disable or wait out live capture, confirm the row is absent, confirm it
  lands within one sweep interval past the quiesce window), a zero-duplicate
  assertion (a turn both lanes observe resolves to exactly one row), and
  re-confirms LLP 0167#verify-results items 1/3/4 on the floor OpenClaw
  version. **Externally blocked for the sweep/dedupe steps; see below.**

## Rating complexity: the hard parts, by name

No task in this plan earns a 5. The design (LLP 0172) resolved every real
fork itself (the attach-probe/status interaction, the scheduling seam, the
ownership-check base URL source, the backup-vs-refuse asymmetry); what is
left is well-specified engineering against precedent, some of it exacting,
none of it open judgement calls the way LLP 0162's `resolveSteering` or
`match_key.js` were.

Three tasks earn a 4, each because correctness failure here is silent, not a
crash:

- **T2 (detach ownership/backup/purge): 4.** The ownership check (compare
  `baseUrl` against `expectedBaseUrl` and `expectedBaseUrl + '/v1'`, confirm
  the marker header) has to get both the bare-origin/`+/v1` asymmetry and
  the "present but mismatched -> backup, never discard" precedent (LLP 0163)
  exactly right; a wrong branch here silently deletes a value HypAware never
  wrote, or silently fails to detect the gateway's own entry. The
  best-effort cache purge across `agents/*/agent/models.json` adds a second
  place a partial failure must not become a fatal one.
- **T4 (attach.js): 4.** The refusal-vs-write decision (refuse if either
  `models.providers` key already exists, R2) must run entirely before any
  write, and the two-entry shape's bare-origin-vs-`+v1` split is the one
  place the design itself flags as "worth a dedicated unit test rather than
  trusting the acceptance run alone": writing the wrong shape for either
  entry produces a schema-valid but non-functional config, which is a
  failure mode no test framework catches by accident.
- **T9 (daemon sweep driver): 4.** Wiring into the daemon's hot tick loop
  without blocking it (`void runBackfillProvider(...)`, matching
  `action_backfill.js`'s subprocess-era discipline applied to an in-process
  call) while still emitting the structured telemetry CLAUDE.md's Log-Driven
  Development section requires (component/operation/status attributes
  around a new lifecycle transition) takes real care; a mistake here is a
  wedged daemon or a live source of unbounded async work with no visibility,
  not a unit-test failure.

Four tasks earn a 3, applying a well-precedented shape but needing real
reasoning about interaction with existing code:

- **T7: 3.** `BackfillRunnerContext` is a pure structural narrowing (every
  `CommandRunContext` still satisfies it), but it touches three functions
  across two call sites and must not regress `hyp backfill`'s existing CLI
  path or the onboarding finale's call, both of which keep using the wider
  type today.
- **T8: 3.** The quiesce filter is a straightforward mtime comparison, but
  it must compose with the existing `effectiveProviders`/`partitionByBackend`
  forward/backward-fill logic (R10, untouched) without accidentally
  filtering by provider identity instead of file recency, and the
  180000ms default must resolve from the cited constant, not a re-guessed
  number.
- **T12: 3.** Mirrors two existing fixture precedents closely, but building
  a controllable-mtime tree and a dedupe-proving rerun assertion is new work
  in this plugin, not a copy-paste.
- **T13: 3.** Writing acceptance steps a human can actually run (exact
  timing against the quiesce window and the sweep interval, exact CLI
  invocations matching what T2/T4 actually implement) is more than prose
  transcription; a wrong step is discovered only when a human tries it,
  which is the failure this document exists to prevent.

Everything else (T1, T3, T5, T6, T10, T11) is mechanical: type edits, a read
branch mirroring existing branches, manifest/config edits against an exact
spec, and a deletion, each already fully specified by the design with no
fork left for the implementer to resolve.

## External blockers (not expressible as `deps`)

Two PRs are green, unmerged, and held for a human's manual merge. Verified
directly against git history: `44c7080` (fix/issue-543, PR #552) and
`daca753` (fix/issue-544, PR #553) exist as real commits reachable via
`git log --all` but are not ancestors of `origin/master` or this integration
branch's HEAD (`eda2598`); `session_file.js`'s `parseOpenclawSessionMessage`
in the current tree still reads fields flat off the raw record, confirming
PR #552 is genuinely unmerged here. Neither blocker is encoded in any task's
`deps`, per this plan's own rule that `deps` are intra-plan code edges only:

- **PR #552 (fix/issue-543)** fixes the LLP 0158 session-file reader to
  project OpenClaw v3's nested `message` envelope via `openclawMessageEnvelope`.
  R8 states the sweep "MUST NOT ship before" this merges, because the sweep
  has no code path that degrades gracefully against the old flat reader; it
  would simply project nothing.
  - **T9** (sweep driver): the scheduling code itself does not read session
    content and can be implemented and unit-tested now against a mocked
    `backfills`/provider. Its real-world effect (turns actually landing from
    a sweep) is silently zero until #552 merges. Do not treat T9's tests
    passing as proof the sweep captures anything on a real OpenClaw v3
    transcript.
  - **T12** (hermetic smoke fixture): genuinely cannot be built correctly
    against the current tree. The fixture must write the nested-`message`
    envelope shape "matching PR #552's fixed reader" (design Section 9,
    verbatim); writing it against the still-unmerged old flat reader would
    test behavior the reader doesn't have yet, or worse, pass against the
    wrong reader and need to be rewritten once #552 lands. **This task
    should be held, not dispatched, until #552 merges into this integration
    branch.**
  - **T13** (ACCEPTANCE.md rewrite): the doc text itself can be written now,
    but the sweep step and the zero-duplicate assertion cannot be
    successfully run by a human against a real OpenClaw v3 session until
    #552 merges. Flag this in the doc's own "Requires" line so a human
    running the procedure early gets a clear reason for the failure, not a
    confusing false negative.
- **PR #553 (fix/issue-544)** made `hyp status` treat a probe-less client as
  `attach n/a` rather than permanently `pending`. Per design Section 3, this
  design requires **no code change** to #553's own logic: once T5 lands a
  real `attach_probe`, `descriptor.attachProbe` is truthy for OpenClaw for
  the first time since LLP 0143, and #553's existing probe-truthy branch
  already produces the correct `attached`/`not attached` derivation. The
  only place this plan names #553 as a blocker is **T13**: the acceptance
  procedure's re-confirmation of `hyp status`'s `client_attach` row assumes
  #553's fix is present in whatever binary the human runs the procedure
  against. If #553 is unmerged at acceptance time, the status row's
  behavior reverts to whatever pre-#553 `hyp status` did for a
  now-probed client, which this design was not written to describe.

No other task in this plan carries an external blocker.

## The hermetic-smoke decision

The design (Section 9) explicitly leaves this as "the one scoping judgment
call in this document worth reconsidering." This plan's decision: **include
it, as T12, rather than defer it whole to issue #555**, for three reasons
that hold even given the PR #552 blocker above:

1. It is small and fully precedented: `backfill_claude_fixture.js` and
   `backfill_codex_fixture.js` already establish the fixture-writer shape
   this plugin has never had an analog of.
2. It is the only automated coverage, of any tier, for the quiesce filter
   (T8) and the sweep driver's `cronMatches` wiring (T9) before the human
   acceptance run (T13). CLAUDE.md's Smoke Test Model section states
   hermetic smokes exist precisely for "PR confidence" on "plugin/kernel
   wiring checks" like this, as distinct from the acceptance tier's release
   gate.
3. Deferring it whole to #555 would mean Lane B ships with zero PR-level
   regression coverage between now and whenever #555 is separately
   prioritized; a regression in `listSessionFiles`'s new parameter or the
   sweep's due-check would only surface in a manual acceptance run.

The blocker on PR #552 does not argue against including the task in this
plan; it argues for **naming T12 in this plan and holding it externally**,
exactly the mechanism the task instructions describe ("isolate it in the
plan and name it in the return value rather than inventing an answer").
Building the fixture now against the wrong reader shape would be worse than
deferring it, so T12's own brief states the hold explicitly. If a human
reviewing this plan judges #555 the better home for this work regardless
(for example, if #555 is already staffed and this plan's Lane B work should
ship without waiting on it), that is a legitimate reversal of this decision,
not a mistake this plan is making silently.

## Carrying the design's open items forward

Design Section 10 names two items for a human, both carried forward
unchanged rather than resolved here, because resolving them is not this
rung's job:

- **R11's acceptance rewrite (T13) requires a human run before the adapter
  ships.** This plan schedules the document; a human still has to run it,
  and per the external-blockers section above, a full successful run needs
  PR #552 (and, for the status row, PR #553) merged first.
- **The hermetic smoke gap** is the scoping call the previous section
  resolves for this plan (include, as T12, held pending #552); the design's
  framing of this as worth a human's reconsideration stands, since this
  plan's Impl-designer rung is not the human the design asked to weigh in.

## Notes for implementers

- No task here flips any LLP's `Status`: LLP 0172 is already `Active`, and
  this plan introduces no design needing a shipped-marker flip.
- `@ref` annotations land with the code that realizes them: T2/T3 cite
  LLP 0169#decision and LLP 0163#open-questions; T4 cites LLP 0167#attach-detach
  and LLP 0169#decision; T7/T8/T9 cite LLP 0170#decision and LLP 0171#requirements
  (R7, R8); T6's the two new config keys land together per the note in "How
  this refines the design." Run `/ref-check` on touched files before each
  task's PR.
- T5 and T11 both touch `hypaware.plugin.json` in non-overlapping ways (T5
  adds `attach_probe` and rewrites copy; T11's deletion never touches this
  file). No merge-order concern between them beyond the dependency already
  stated (T11 after T5).
- T2 and T4 both eventually feed T5's manifest edit but touch no common file
  with each other (`client_detach_disk.js` vs. new `attach.js`); they can
  proceed fully in parallel in the second wave despite both gating T5.
- T9's `void runBackfillProvider(...)` fire-and-forget call means a slow or
  failing sweep run must not throw unhandled into the daemon's event loop;
  wrap it so a rejected promise is logged (`component: 'backfill-sweep'`,
  `operation: 'backfill.sweep'`, `error_kind`) rather than becoming an
  unhandled rejection, per CLAUDE.md's Log-Driven Development section.
  `component` names the emitting module, not the plugin: the driver is
  plugin-agnostic (it fires any contribution carrying a `sweep` field, and
  OpenClaw is only the first opt-in), and per-plugin attribution already
  rides `hyp_plugin`/`provider` on the same records.
- T12, once unblocked, should confirm against issue #555's own tracked scope
  before starting, in case #555 has since grown requirements beyond what
  design Section 9 describes.

## References

- [LLP 0172](./0172-openclaw-two-lane-capture.design.md): the technical
  design this plan schedules
- [LLP 0171](./0171-openclaw-two-lane-capture.spec.md): the requirements
  (R1-R12, plus LLP 0157's carried-over R8/R9/R10/R11/R14) this design and
  plan implement
- LLP 0167, LLP 0168, LLP 0169, LLP 0170: the accepted RFC/decision set LLP
  0172's sections cite one-by-one
- LLP 0163 (malformed-block backup precedent), LLP 0143 (superseded;
  `json_path` retirement, reversed by T2/T3), LLP 0157/0158/0159/0161/0162
  (the prior design/plan; steering-plugin-shaped sections retired by T11,
  projector/settlement/backfill sections remain the record of what shipped
  and are the survivor list T5/T11 check deletions against)
- `docs/ACCEPTANCE.md`, issue #543 (PR #552, `fix/issue-543`), issue #544
  (PR #553, `fix/issue-544`), issue #555 (the separately-tracked hermetic
  smoke gap this plan chooses not to defer to, per the hermetic-smoke
  decision above)
- `llp/0162-openclaw-full-capture.plan.md`: format precedent for this plan's
  task-graph and complexity-rating structure

## Tasks

- id: T1   branch: task/openclaw-two-lane-capture/T1   deps: []                  complexity: 2  -- hypaware-plugin-kernel-types.d.ts: restore `'json_path'` to `PluginAttachProbeManifest.format`'s union, add `container_path: string`, `provider_keys: string[]`, `cache_glob: string` (reuse existing `marker_header?`), and revise (not delete) the comment at the current removal site to explain what changed and why the danger it warned about (issue #212) is now addressed by T2/T3's runtime support. Add the optional `sweep?: { cron: string }` field to `BackfillContribution`, absent-by-default for every existing contribution. Test: a type-level check (or JSDoc `@ts-check` compile) that `hypaware-core/plugins-workspace/openclaw`'s existing files still typecheck unchanged, proving the additions are additive.
- id: T2   branch: task/openclaw-two-lane-capture/T2   deps: [T1]                complexity: 4  -- src/core/config/client_detach_disk.js: add `detachJsonPathProviders({settingsPath, containerPath, providerKeys, markerHeader, cacheGlob, homeDir, expectedBaseUrl, fs})` implementing the ownership check (baseUrl matches expectedBaseUrl or expectedBaseUrl + '/v1', markerHeader value matches the key name), the backup-not-discard path for a present-but-mismatched entry (mirrors the LLP 0163 prev_malformed precedent, lands under a `_hypaware_detach_backup.<key>` sibling key in the same file), and the best-effort cache purge across `homeDir/.openclaw/<cacheGlob>` (a file that fails to parse is logged and skipped, not fatal). Wire the dispatcher's `probe.format === 'json_path'` branch to call it. Thread a new `expectedBaseUrl` parameter through both real callers: `detachClientViaCore` in src/core/commands/clients.js (currently calls detachClientFromDisk with no expectedBaseUrl) and action_attach.js's `reverse()` (has `ctx.endpoint` already, in the same ActionContext perform() uses). Test: unit tests proving the four outcomes directly (ours: deleted; mismatched: backed up not discarded; absent file: {changed:false}; cache purge best-effort on a malformed sibling file).
- id: T3   branch: task/openclaw-two-lane-capture/T3   deps: [T1]                complexity: 2  -- src/core/daemon/status.js: restore the `probe.format === 'json_path'` read branch (removed by LLP 0143 / PR #510) parallel to the existing json/toml branches at the current lines 1066/1083: navigate `container_path` + each of `provider_keys`, read `headers[marker_header]`, report attached when it equals the expected value for at least one configured key. Pure read, no ownership/backup concerns. Test: `probeClientAttachFromDescriptor` returns attached/not-attached correctly against a fixture openclaw.json with the entry present, absent, and present-but-wrong-header.
- id: T4   branch: task/openclaw-two-lane-capture/T4   deps: []                  complexity: 4  -- New hypaware-core/plugins-workspace/openclaw/src/attach.js, `createOpenclawAttach({homeDir, fs})` returning `{attach(attachCtx)}`, mirroring hypaware-core/plugins-workspace/claude/src/index.js's attach() shape (same AiGatewayClientAttachContext param, withSpan('client.attach', ...), dry-run branch). Reads openclaw.json (or $OPENCLAW_HOME), refuses with {status:'failed', reason} if models.providers.anthropic or .openai already exists (R2, pure read-then-decide, no partial write), otherwise writes both entries from attachCtx.endpoint with the bare-origin (anthropic) vs. +'/v1' (openai) asymmetry the design flags as worth its own test, preserves any other existing models keys, prints the `openclaw gateway restart` instruction on both human and --json paths, returns {status:'done'}. hypaware-core/plugins-workspace/openclaw/src/index.js: delete the old no-op attach() body, STEERING_PLUGIN_NAME, ROUTING_OWNED_BY_STEERING_PLUGIN_MESSAGE, and the @ref LLP 0143#decision comment block; wire index.js's activate() to attach.js's attach() instead. Test: refusal-when-exists, the exact two-entry shape (asymmetry included), restart-instruction print on both output modes, and that attach() never throws on refusal.
- id: T5   branch: task/openclaw-two-lane-capture/T5   deps: [T2, T3, T4]        complexity: 2  -- hypaware-core/plugins-workspace/openclaw/hypaware.plugin.json: add contributes.client.attach_probe exactly per design 1.4 (format json_path, settings_file .openclaw/openclaw.json, container_path models.providers, provider_keys [anthropic, openai], marker_header x-hypaware-upstream, cache_glob agents/*/agent/models.json); rewrite `description` and `picker[0].summary` to drop every @hypaware/openclaw-steering-plugin reference and state the two capture tiers directly (live gateway capture once attached, plus periodic transcript sweep). hypaware-core/plugins-workspace/claude/hypaware.plugin.json: add the LLP 0167#onboarding line naming the claude-cli/<model> case OpenClaw's CLI-backend exclusion produces. hypaware-core/plugins-workspace/openclaw/src/projector.js line 31: correct the stale "written by the openclaw-steering-plugin" comment to describe the config-override write. Test: a manifest-shape test asserting attach_probe parses to the exact fields above, and that description/summary strings no longer match /openclaw-steering-plugin/.
- id: T6   branch: task/openclaw-two-lane-capture/T6   deps: []                  complexity: 2  -- hypaware-core/plugins-workspace/openclaw/src/config.js: validateBackfillSection gains `sweep_cron` (string, validated as a 5-field cron expression via the same validator cronMatches's caller uses to reject malformed schedules elsewhere) and `quiesce_ms` (non-negative integer), added in the same change so the existing unknown-key rejection loop recognizes both together, alongside the existing on_join/window_days keys. Test: validateOpenclawConfig accepts both keys with valid values, rejects an invalid cron string, rejects a negative quiesce_ms, and still rejects a genuinely unknown key.
- id: T7   branch: task/openclaw-two-lane-capture/T7   deps: [T1, T6]           complexity: 3  -- hypaware-core/plugins-workspace/openclaw/src/backfill.js: createOpenclawBackfillProvider populates `sweep: { cron: config.backfill?.sweep_cron ?? '*/5 * * * *' }` on the returned contribution. src/core/commands/backfill.js: declare the new `BackfillRunnerContext` interface `{env, config, storage, backfills, backfillMaterializers}` (a structural subset every CommandRunContext already satisfies) and narrow runBackfillProvider's, runProvider's, and resolveOwnersForRun's `ctx` parameter types to it. Test: existing hyp backfill CLI-path and onboarding-finale call sites still typecheck and pass unchanged (proving the narrowing is non-breaking); a new test asserts the contribution's `sweep.cron` reads the configured value and falls back to the default when absent.
- id: T8   branch: task/openclaw-two-lane-capture/T8   deps: [T6]              complexity: 3  -- hypaware-core/plugins-workspace/openclaw/src/backfill.js: listSessionFiles(agentsDir) gains an optional `quiesceBeforeMs` parameter, skipping any file whose mtimeMs is more recent; runOpenclawBackfill() computes it once per run as Date.now() - quiesceMs, where quiesceMs resolves from config.backfill?.quiesce_ms defaulting to 180000 (cited from QUERY_FLUSH_DEBOUNCE_MS in src/core/cache/spool.js plus a one-minute margin). Must compose with, not replace, the existing effectiveProviders/partitionByBackend forward/backward-fill logic (R10, untouched). Test: a session file with mtime inside the quiesce window is excluded from the run; one outside it is included; the default resolves to exactly 180000 when quiesce_ms is absent from config.
- id: T9   branch: task/openclaw-two-lane-capture/T9   deps: [T7, T8]          complexity: 4  -- New src/core/daemon/backfill_sweep.js, createBackfillSweepDriver({backfills, backfillMaterializers, env, config, storage}) with tick({now}) iterating backfills.list(), skipping contributions with no sweep field or a not-due cronMatches (imported from src/core/sinks/driver.js), and firing `void runBackfillProvider({ctx: {env, config, storage, backfills, backfillMaterializers}, provider: provider.name, dryRun: false, devRunId: sweep-<name>-<now>})` per due contribution, with the fired promise's rejection logged (component openclaw, operation backfill.sweep, error_kind) rather than left unhandled. src/core/daemon/runtime.js's runTick(): call `await sweepDriver.tick({now})` right after the existing sink-driver tick call, inside the same DEFAULT_TICK_INTERVAL_MS=60_000 loop, no new timer. Externally blocked for real capture (PR #552, see External blockers); code and unit tests (mocked backfills/provider) can land now. Test: tick() fires runBackfillProvider only for due, sweep-bearing contributions; a rejected sweep run does not throw out of tick() or block the sink tick's own await.
- id: T10  branch: task/openclaw-two-lane-capture/T10  deps: [T5]              complexity: 2  -- test/plugins/openclaw-client-registration.test.js: rewrite the two attach() no-op tests (current lines 39-82, 84-114) to assert the new write-based behavior (refusal-when-exists, the two-entry shape, restart-instruction print) instead of the old /openclaw-steering-plugin/ stdout match; rewrite the descriptor test (lines 222-240) to assert the new json_path attach_probe shape instead of `attachProbe === undefined`; correct the "honest no-op" detach test's (lines 197-220) stale R7 comment and add a companion case using a real openclaw.json fixture proving the ownership-based ` detachJsonPathProviders` (T2) actually fires and reports changed:true. Leave the registration-order test (116-155) and the generic hyp attach resolution test (157-195) unchanged; neither depends on the old no-op shape.
- id: T11  branch: task/openclaw-two-lane-capture/T11  deps: [T5]              complexity: 1  -- Delete openclaw-steering-plugin/ in full (src/, test/, package.json, openclaw.plugin.json, .d.ts files) and test/plugins/openclaw-steering-plugin.test.js (R9). Remove tsconfig.json's `"openclaw-steering-plugin"` entry from the `include` array (line 19; not named in the design's own deletion inventory, found verifying the deletion against the real tree). Test: `npm test` and a `tsc --noEmit` (or equivalent checkJs run) pass with no reference to the deleted directory remaining anywhere in the tree (`grep -rl openclaw-steering-plugin` returns nothing outside llp/ history documents).
- id: T12  branch: task/openclaw-two-lane-capture/T12  deps: [T8, T9]          complexity: 3  -- New backfill_openclaw_fixture helper under hypaware-core/smoke/flows (mirroring backfill_claude_fixture.js / backfill_codex_fixture.js), writing a minimal OpenClaw v3 session JSONL in the nested-message-envelope shape under a temp agents/<id>/sessions/ tree with a controllable mtime, plus a smoke flow asserting (a) a file with mtime inside the quiesce window is skipped by a sweep run, (b) a file outside the window is captured, and (c) rerunning the sweep after a live-lane row already wrote the same part_id nets zero new rows. Externally blocked: hold, do not dispatch, until PR #552 merges into this integration branch (the fixture's envelope shape only matches the reader #552 introduces; building it against the current flat reader would test the wrong, soon-obsolete shape).
- id: T13  branch: task/openclaw-two-lane-capture/T13  deps: [T5, T8, T9]      complexity: 3  -- docs/ACCEPTANCE.md's openclaw_capture section (starting at the current line 173): drop the steering-plugin link/enable setup and the before_model_resolve/hooks.allowConversationAccess version-gate language; add a setup step running `hyp attach --client openclaw` followed by the restart instruction it prints; add a sweep step (disable or wait out live capture, confirm the row is absent, confirm it lands within one sweep interval past the quiesce window); add a zero-duplicate assertion (a turn both lanes observe resolves to exactly one row for its part_id); re-confirm LLP 0167#verify-results items 1, 3, 4 on the floor OpenClaw version. State in the section's own Requires line that the sweep/dedupe steps need PR #552 merged, and the client_attach status-row re-confirmation needs PR #553 merged, to run successfully. Test: this is a doc; the test is a human's successful run, which this task's own text cannot perform, only specify accurately against what T2/T4/T5 actually implement.
