# LLP 0162: OpenClaw full capture, implementation plan

**Type:** plan
**Status:** Active
**Related:** LLP 0161
**Generated-by:** neutral
**Extended-by:** LLP 0167 (two-lane capture: the steering-plugin tasks' output is deleted by LLP 0171 R9; the remainder stands as the record of what #510 shipped)

> [LLP 0161](./0161-openclaw-full-capture.design.md) is the technical design for
> the two deliverables and one removal [LLP 0157](./0157-openclaw-full-capture.spec.md)
> specifies. It already names the files, functions, and call shapes and resolves
> every fork LLP 0157 left open. This plan turns those eleven sections into an
> eleven-task graph with real code-dependency edges, so the first wave can land
> in parallel and each task leaves the tree green on its own.

## How this refines the design

The design's numbered sections are already close to minimal, independently
testable units. This plan keeps that decomposition with two departures, both
because the design's own text implies work it does not give its own section:

- **A shared session-file reader is new work, not existing code.** Sections 6
  and 7 both say "reads the session file through the LLP 0158 reader," but
  [LLP 0158](./0158-one-reader-for-openclaw-session-jsonl.decision.md) is a
  decision document, not a shipped module: `hypaware-core/plugins-workspace/openclaw/`
  currently has no file that reads `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
  at all (verified: `settings.js`, `config.js`, `index.js`, `projector.js` are
  the only files in that tree today). Building that reader is its own task
  (**T3**) so the settlement enricher (T8) and the backfill provider (T9) both
  consume one module instead of each growing its own copy: exactly the drift
  LLP 0158 exists to prevent, applied to a module that does not exist yet
  either.
- **Section 3.1 (manifest) splits across two tasks**, not one, because half of
  it (`attach_probe` removal, `permissions`, the config-section summary text)
  is coupled to the settings-file retirement (Section 3.3) and half (the
  `required_upstreams` growth to `["anthropic", "openai"]`) is coupled to the
  `openai` upstream preset actually being registered (Section 3.4). Landing
  `required_upstreams: [..., "openai"]` before any code registers an `openai`
  preset would declare a routing capability the plugin does not yet have;
  landing it after is the honest order. T6 (Section 3.4) therefore depends on
  T5 (Section 3.1 minus the upstream list, plus 3.2 and 3.3), both because they
  edit the same manifest object and because the upstream-list edit is only
  true once T6's preset registration lands.

Everything else maps close to 1:1 onto the design's section numbers.

## The task graph

**First wave (deps `[]`), four-wide:**

- **T1**, the steering plugin's core (Sections 1, 2, 2.1): package scaffold,
  the two shadow provider registrations, and the four-branch
  `resolveSteering` precedence algorithm with its `DEFERRED_SET`. This is the
  one place LLP 0157 left a real fork and the design resolved it with an
  algorithm, not a restatement; see complexity note below.
- **T3**, the LLP 0158 session-file reader, new module, consumed later by T8
  and T9. Faithfully porting the Codex `rollout_session_meta.js` precedent's
  non-obvious guard rules (bounded first-line read, `type` guard, the
  absolute-path `cwd` predicate) matters more than it looks: LLP 0150
  documents two shipped privacy bugs from exactly this shape copied loosely.
- **T4**, Section 5's `match_key.js`: `canonicalMatchKey` / `wireMatchKey` /
  `sessionMatchKey` and the ordinal/time fallback matcher. The hardest single
  piece of this change set; see complexity note below.
- **T5**, Sections 3.1 (partial), 3.2, 3.3: manifest `attach_probe` removal
  and `permissions` trim, the `validateBackfillSection` copy in `config.js`,
  deleting `settings.js`, and the honest no-op `attach()` that keeps
  `registerClient` registered (the fork Section 3.3 resolves: dropping
  registration entirely, the Desktop precedent, would break `hyp clients
  openclaw` / `hyp attach openclaw` discoverability, which LLP 0157 never asked
  for).

**Second wave:**

- **T2** (deps `[T1]`), Section 2.2: credential borrowing
  (`prepareRuntimeAuth`) and the `wrapStreamFn` wire-parity mirror for
  `hypaware-anthropic`. Depends on T1 because both hooks attach to the same
  provider-registration object T1 creates.
- **T6** (deps `[T5]`), Section 3.4: `openaiUpstreamPreset()`, the
  `x-hypaware-upstream`-header precedence rung on both presets' `match()`, and
  the `required_upstreams` manifest growth. Depends on T5 as explained above.
- **T7** (deps `[T4]`), Section 3.5: the projector's shape-aware branch
  (`anthropicMessages()` / new `openaiMessages()`), dropping the hardcoded
  `provider: 'anthropic'`, and stamping `wireMatchKey` (from T4) as
  `attributes.openclaw.match_key` on fallback-identity rows.
- **T9** (deps `[T3]`), Section 7: the backfill provider. Needs T3's reader;
  does **not** need T4's match keys: Section 7 states explicitly that
  backfilled rows carry native identity directly and never need a match key,
  which is what makes R11 true by construction rather than by a second match
  pass.
- **T10** (deps `[T5]`), Section 8: the `json_path` core removal. Depends on
  T5, not the other way round: [LLP 0143](./0143-openclaw-registers-no-attach-probe.decision.md)'s
  R7 requires the manifest's last `json_path` consumer (T5's `attach_probe`
  removal) and core's removal of the format to land in the same logical
  change, and landing the manifest side first (or together) is what keeps
  `hyp detach openclaw` / `hyp status` from probing a format core no longer
  understands for even one merged commit.

**Third wave:**

- **T8** (deps `[T3, T4]`), Section 6: the settlement enricher. Needs T3 (the
  reader) and T4 (`sessionMatchKey` + the ordinal/time fallback) to build its
  per-session lookup index. Does not depend on T7: T8's tests supply rows with
  `attributes.openclaw.match_key` directly rather than requiring the live
  projector to have produced them, so T7 and T8 can be developed in parallel
  off the shared T4 contract; they only need to agree on the attribute shape,
  which T4 defines for both.

**Last:**

- **T11** (deps `[T1, T6, T7, T9]`), Section 9: `docs/ACCEPTANCE.md`'s
  `## openclaw_capture` procedure. Depends on everything it documents: T1 for
  the warning-ledger step, T6 and T7 for the live-capture route, T9 for the
  backfill route's pass condition.

This yields a 4-wide first wave (T1, T3, T4, T5), a 5-wide second/third wave
(T2, T6, T7, T9, then T8 once T3+T4 are in), and T11 landing last. T2, T6, T7,
T9, T10 touch five different files/packages with no imports between them, so
none of them block each other even though several land in the same second
wave.

## Rating complexity: the hard parts, by name

Two tasks earn a 5, both named directly in the brief for this plan:

- **T1 (steering precedence): 5.** The `resolveSteering` four-branch
  algorithm is the one place LLP 0157 left a real fork and the design fills it
  with judgement, not restatement: which candidates land in `no_credential`
  vs. `no_preset` vs. `deferred` determines what the warning ledger says
  coverage is, and because the gateway's upstream presets have a *static*
  `base_url` per preset (no per-request dynamic forward target), steering a
  candidate whose real target is not literally `api.anthropic.com` /
  `api.openai.com` would silently redirect that traffic to the wrong vendor.
  A wrong branch order here is not a test failure to catch later, it is a
  wrong answer to "is this provider captured" that the whole coverage
  statement (LLP 0157 R13) rests on.
- **T4 (match-key normalization): 5.** `canonicalMatchKey` /
  `wireMatchKey` / `sessionMatchKey` is a genuinely new two-sided
  normalization (Claude's single wire-shaped hash does not transfer, per the
  design's own Section 5 fork), the `toolCall` → `tool_use`-style synonym
  table it needs is verified against live OpenClaw session files at
  implementation time (an open item, see below), and R11's "backfill dedupes
  to zero writes against live" guarantee is exactly the property that breaks
  silently if this normalization is wrong in either direction: a false
  match key double-collapses distinct messages, a missed one lets the
  ordinal/time fallback carry more weight than the design intends. This is
  the hardest single piece of the whole change set.

Four tasks earn a 4, each because they apply a well-precedented shape but
still require real reasoning, not because the shape is unknown:

- **T2: 4.** Owner-scoped OpenClaw hooks (`prepareRuntimeAuth`,
  `wrapStreamFn`) with concrete header values the design already gives, but
  the idempotent `Set`-based merge and the OAuth-vs-opt-in beta branching need
  correct reasoning about OpenClaw's own request shaping to not duplicate or
  drop a header.
- **T7: 4.** `openaiMessages()` is a new OpenAI Chat Completions
  request/response/SSE parser with no precedent inside this plugin (Codex's
  `response-items.js` is OpenAI-shaped but plugin-private and not
  importable across plugins per house rule); building the shape dispatch and
  the streaming reconstruction correctly is real, bounded engineering.
- **T8: 4.** Applies Claude's well-precedented `settle.js` shape with one
  documented simplification (single cwd per session, no time-slicing), but
  still has to wire the two-pass match (content, then T4's ordinal/time
  fallback) and the flush-time usage-policy drop correctly against a session
  grouping that did not exist in this plugin before.
- **T9: 4.** Getting native-identity construction (`message_id`,
  `previous_message_id`, `part_id`) exactly right is what makes R11's
  zero-write dedupe-to-live true "by construction, not coincidence" per the
  design; the CLI-backend allowlist open item (below) also lands here.
- **T11: 4.** Writing acceptance steps that actually work when a human runs
  them requires resolving, in the doc itself, what the design explicitly
  leaves open: "exact mechanics depend on what OpenClaw's own plugin API
  exposes for introspection, verified at implementation time." A wrong
  guess here is a procedure a human cannot follow, discovered only when they
  try, which is the failure this document exists to prevent.

Everything else (T3, T5, T6, T10) is mechanical: the read rules, the
manifest edits, and the deletions are already fully specified by a design or
an Accepted decision document, with no fork left for the implementer to
resolve.

## Carrying the design's open items forward

Section 10 names four implementation-time verifications. None are dropped;
each is pinned to the task that must resolve it before it can be correct,
and each task begins by establishing the fact rather than assuming it:

- **Does `pi-ai` add the default betas itself, absent a wrapper?** → **T2**.
  T2's `wrapStreamFn` merge must be correct either way (it is `Set`-based and
  idempotent by construction per the design), but T2 should still start by
  reading `@mariozechner/pi-ai` in the openclaw repo (`pnpm install` there,
  per LLP 0157's own note) so the merge is verified, not just defensively
  idempotent.
- **Does OpenClaw append session JSONL lines in real time, or buffer until
  session end?** → **T8**. This does not change T8's code (the design accepts
  either outcome as a residue question, not a correctness one), but T8's
  implementer should measure the settlement match rate at flush against a
  real OpenClaw session before considering the enricher done, and note the
  observed behavior in the PR description; LLP 0159's Consequences say this
  number is what would trigger revisiting the whole route-agreement design.
- **The `toolCall` / `tool_use`-style synonym table `sessionMatchKey` needs.**
  → **T4**. The design states the one divergence LLP 0159 already names
  (`toolCall` → `tool_use`) and the mechanism for handling more (a synonym
  table, not a hardcoded pair), not an exhaustive table, because that table
  does not exist in this repo to read yet. T4 begins by pulling a handful of
  real OpenClaw session JSONL files (or, failing local access, the openclaw
  repo's own fixtures/tests for its normalized message shape) and building
  the table from what is actually there, not from guessing every OpenClaw
  block-type name in advance.
- **The exact `provider`/`api` values a CLI-backend-routed session record
  carries.** → **T9**. Section 7 already names the fail-closed default (an
  explicit allowlist, project only `provider: 'anthropic'` or `'openai'`,
  rather than a denylist) precisely so this is safe to ship before the
  question is answered: an unrecognized future value is excluded, not
  mis-attributed. T9 begins by verifying against a live OpenClaw session that
  included at least one CLI-backend turn, and either confirms the allowlist
  is already sufficient or documents what it is missing; it does not have to
  block on finding one, because the fail-closed default is correct either way.

One further fact-finding item does not come from Section 10 but is real: T1's
package needs OpenClaw's own plugin-manifest shape (id, entry, permission
declaration fields; whatever `openclaw plugins install` expects), which is
OpenClaw API surface this repo does not own. T1 begins by verifying that
shape against the openclaw repo, the same way LLP 0157 verified
`extensions/anthropic/stream-wrappers.ts` before relying on it, rather than
guessing a manifest shape and discovering it is wrong at `npm install
--omit=dev` time inside OpenClaw's own installer.

Section 11's two "living lists" (`DEFERRED_SET` membership, the CLI-backend
allowlist) are not implementation tasks; they are a process note for
*after* ship: the first time either list needs an addition, that addition
should land as its own short decision LLP citing LLP 0161/0162, not a silent
diff to T1's or T9's code. No task here needs to anticipate that; it is
recorded so a future implementer does not have to rediscover the norm.

## Tasks

- id: T1   branch: task/openclaw-full-capture/T1   deps: []                  complexity: 5  -- New top-level `openclaw-steering-plugin/` package (package.json name `@hypaware/openclaw-steering-plugin`, `src/index.js`): register the two shadow providers (`hypaware-anthropic` api `anthropic-messages`, `hypaware-openai` api `openai-completions`) via `api.registerProvider({ catalog: { run } })` with `baseUrl` at `gateway.localEndpoint()` resolved from an env var at plugin load, and the `before_model_resolve` hook implementing `resolveSteering`'s four-branch precedence (shadow-shape lookup -> canonical-provider check -> `DEFERRED_SET` membership -> credential resolution), returning `providerOverride` + `x-hypaware-upstream` request metadata on the terminal steer branch. Begins by verifying OpenClaw's own plugin-manifest shape (id/entry/permission fields) against the openclaw repo. Unit-tested standalone against `DEFERRED_SET` membership and each of the three warning causes (`no_credential`, `no_preset`, `deferred`).
- id: T2   branch: task/openclaw-full-capture/T2   deps: [T1]                complexity: 4  -- Steering plugin credential + wire parity (design Section 2.2): `prepareRuntimeAuth` borrows the shadowed provider's credential via `openclaw/plugin-sdk/provider-auth-runtime`'s `resolveApiKeyForProvider`, returns `{ apiKey, baseUrl, expiresAt? }` per request, never persists it, and re-resolves every call. `wrapStreamFn` on `hypaware-anthropic` mirrors `extensions/anthropic/stream-wrappers.ts`'s header set (default betas, OAuth-only additions, `context-1m` opt-in, `service_tier`) via an idempotent Set-based header-name union. Begins by checking whether `@mariozechner/pi-ai` adds the default betas itself (open item); the merge must be correct either way.
- id: T3   branch: task/openclaw-full-capture/T3   deps: []                  complexity: 3  -- New module implementing the LLP 0158 shared OpenClaw session-file reader: a bounded first-line header read returning `{ sessionId, cwd, startedAt }` (type: "session" guard, non-blank-string fields only, absolute-path predicate on cwd shared in behavior with the Codex `sessionMetaCwd` precedent in src/core/codex/rollout_session_meta.js), plus a full-transcript iteration for message records. No consumer outside `@hypaware/openclaw` yet, so it stays plugin-local per LLP 0158's placement decision (promote to src/core/openclaw/ only when a second plugin needs it). Tested against fixture session JSONL covering the guard/blank/relative-cwd edge cases LLP 0150's precedent already names.
- id: T4   branch: task/openclaw-full-capture/T4   deps: []                  complexity: 5  -- New hypaware-core/plugins-workspace/openclaw/src/match_key.js (design Section 5): `canonicalMatchKey(role, tuples)` (sha256Hex over role + canonicalJson(tuples), reusing src/core/util's canonicalJson/sha256Hex), `wireMatchKey(role, content)` building `{kind, identity}` tuples from Anthropic/OpenAI wire-shaped blocks via stripVolatileBlockFields, `sessionMatchKey(role, blocks)` building the same tuple shape from OpenClaw's session-file block records through a synonym table (toolCall -> tool_use is the one mapping named so far), and the ordinal/time fallback matcher (retry against (role, same-role ordinal) bounded to a 5-minute window when content matching misses, as a deliberately separate second pass, never merged into one score with content matching). Begins by pulling real OpenClaw session JSONL (or the openclaw repo's own fixtures) to build the synonym table from what actually exists, not a guessed list.
- id: T5   branch: task/openclaw-full-capture/T5   deps: []                  complexity: 2  -- hypaware.plugin.json: delete `contributes.client.attach_probe` entirely, drop `write_openclaw_settings` from `permissions` (flag `write_home` for re-audit down to `read_home` in the PR description, do not resolve it here), update `config_sections[0].summary` to mention the backfill block. hypaware-core/plugins-workspace/openclaw/src/config.js: add `validateBackfillSection(value, pointer)` as a same-shape copy of @hypaware/codex's validator (on_join boolean, window_days positive integer, unknown keys rejected), wired into `validateOpenclawConfig`; delete the stale "no backfill block" comment. Delete src/settings.js entirely and hypaware-core/plugins-workspace/openclaw/src/index.js's import of it; `activate()` keeps `gateway.registerClient({ name: 'openclaw', defaultUpstream: 'anthropic', attach })` but `attach()` becomes an honest no-op (writes nothing, logs/returns that routing is owned by the `openclaw-steering-plugin` npm package, points at its install instructions). Delete test/plugins/openclaw-settings-attach.test.js (tests the retired settings.js directly); add a test that `hyp attach openclaw` / `hyp detach openclaw` / `hyp clients openclaw` still resolve the client (do not error `unknown client`) with the no-op attach in place.
- id: T6   branch: task/openclaw-full-capture/T6   deps: [T5]                complexity: 3  -- hypaware-core/plugins-workspace/openclaw/src/projector.js: add `openaiUpstreamPreset()` (name 'openai', base_url 'https://api.openai.com', path_prefix '/v1', priority 100), byte-identical in shape to @hypaware/codex's existing openai preset. Both `anthropicUpstreamPreset()` and `openaiUpstreamPreset()` gain one precedence rung above their existing path/header checks in `match()`: unconditional match when `input.headers['x-hypaware-upstream']` names this preset's provider. index.js registers both presets (register iff absent, matching the existing anthropic-only pattern). hypaware.plugin.json: `contributes.client.required_upstreams` grows from `["anthropic"]` to `["anthropic", "openai"]`. Regression test: Claude/Codex traffic (which never sends x-hypaware-upstream) must route unchanged.
- id: T7   branch: task/openclaw-full-capture/T7   deps: [T4]                complexity: 4  -- hypaware-core/plugins-workspace/openclaw/src/projector.js: extend `createOpenclawExchangeProjector()` (stays priority 110, `match()` unchanged) with a shape-aware `project()`: read `x-hypaware-upstream` to pick the existing `anthropicMessages()` or a new `openaiMessages()` (OpenAI Chat Completions-shaped request/response/SSE-stream parser, mirroring `anthropicMessages`'/`reconstructAssistantMessage`'s shape but for the OpenAI wire format), and stop hardcoding `provider: 'anthropic'` (read from `x-hypaware-upstream`, fall back to `'anthropic'` only when absent). Stamp `wireMatchKey` (T4) as `attributes.openclaw.match_key` on every row emitted under fallback identity (R8). Tests cover both shapes, the streamed and non-streamed cases, and the header-absent fallback.
- id: T8   branch: task/openclaw-full-capture/T8   deps: [T3, T4]            complexity: 4  -- New hypaware-core/plugins-workspace/openclaw/src/settle.js, `createOpenclawSettlementEnricher(opts)` returning `{ name: 'openclaw-settlement', clientName: 'openclaw', settle(rows, ctx) }`, registered in index.js's activate() right after registerExchangeProjector (mirrors claude/src/index.js placement). Per session (grouped by session_id): read the session file once via T3's reader (best-effort, never throws); build a `Map<matchKey, {nativeId, blocks}>` from the transcript via `sessionMatchKey` (T4); for each row, look up `attributes.openclaw.match_key` (content match, then T4's ordinal/time fallback), upgrade native identity on a hit (recompute message_id/part_id, strip spent match_key/identity_source attributes, mirroring claude/src/settle.js's upgradeRow/cleanAttributes); independent of match success, apply the session's single header cwd through the shared usage-policy resolver, returning USAGE_POLICY_DROP at that row's position when `policy.class === 'ignore'`, logging `plugin.openclaw.usage_policy_drop` with the same shape as the Claude precedent (never raw cwd). Test-measure the settlement match rate at flush against a real or realistic OpenClaw session as part of resolving the "does OpenClaw append JSONL in real time" open item; note the observed rate in the PR description.
- id: T9   branch: task/openclaw-full-capture/T9   deps: [T3]                complexity: 4  -- New hypaware-core/plugins-workspace/openclaw/src/backfill.js, `createOpenclawBackfillProvider(opts)` implementing BackfillContribution (datasets: ['ai_gateway_messages']), registered via ctx.backfills.register(...) in activate(), mirroring Codex's placement. Per session file under `~/.openclaw/agents/*/sessions/*.jsonl` (enumerated within resolveWindow(ctx)'s bounds via filterByWindow, both from src/core/backfill/scan_util.js): read the header via T3's reader (no usable cwd -> not gated, project; usable cwd -> resolve through the shared usage-policy resolver once per file, `ignore` skips the whole file); iterate the transcript, excluding CLI-backend records via an explicit allowlist (provider is 'anthropic' or 'openai' only, fails closed on anything else -- begin by verifying the exact provider/api value set against a live OpenClaw session with a CLI-backend turn, but do not block on finding one); for a message record that passes both filters, build an AiGatewayProjectedExchange directly from the record's own fields (native message_id, chained previous_message_id, usage, model/provider/api) -- never through anthropicMessages()/openaiMessages(), and never a match key, since backfill reads the authoritative source directly. Wrap with projectedExchangeItem(exchange, { client_name: 'openclaw', source_path, native_id }) and yield. Test proves R11: a backfilled row and a settled live row for the same turn carry identical message_id/part_id.
- id: T10  branch: task/openclaw-full-capture/T10  deps: [T5]                complexity: 1  -- Delete the `json_path` branches: src/core/config/client_detach_disk.js's `if (probe.format === 'json_path' && probe.marker_path) {...}` branch and the `detachJsonPathMarker` function it calls; src/core/daemon/status.js's matching read-side branch (around line 1000) using getAtDottedPath/parseJsonRecordString. Leave `json`/`toml` and the MALFORMED_MARKER guard untouched. Delete test/core/client-detach-json-path.test.js. Depends on T5 because LLP 0143 R7 requires the manifest's last json_path consumer (T5's attach_probe removal) and this removal to land together; T10 must not merge ahead of (or without) T5.
- id: T11  branch: task/openclaw-full-capture/T11  deps: [T1, T6, T7, T9]    complexity: 4  -- docs/ACCEPTANCE.md gains `## openclaw_capture`, mirroring `## codex_desktop_capture`'s exact structure (What it proves / What it does not prove / Requires / Related / ### Steps / ### If it fails). Step 1 replaces the settings-marker check (none exists, R7) with an assertion that the shadow providers registered and are steering -- a steering-plugin debug/status surface if OpenClaw exposes one, else a probe request through the gateway confirming x-hypaware-upstream arrives; resolve which mechanic is available against the openclaw repo/docs while writing this step, since a step a human cannot run is the exact failure this document exists to prevent. A new step exercises the warning ledger against a deferred-family provider (T1's DEFERRED_SET), confirming a `deferred`-caused warning is queryable. The backfill step matches Codex's shape: run `hyp backfill openclaw --since ...` over the live-captured window; pass condition `rows_written: 0` with `rows_skipped >= 1` (T9's R11 in practice). This document must exist and be run by a human before the adapter ships (R12); this task lands the document, not the human run.

## Notes for implementers

- No task here flips any LLP's Status: LLP 0161 is already `Active`, and this
  plan does not introduce a design that needs a shipped-marker flip.
- `@ref` annotations land with the code that realizes them, per repo
  convention: T1/T2 cite LLP 0157#requirements and LLP 0161's Sections 2/2.1/2.2;
  T4 cites LLP 0159 and LLP 0157#requirements (R8); T5/T10 cite LLP 0143;
  T6/T7 cite LLP 0157#adapter-rework; T8/T9 cite LLP 0159 and LLP 0157#requirements
  (R9, R10, R11, R14). Run `/ref-check` on touched files before each task's PR.
- T5, T6, and T7 all touch files under `hypaware-core/plugins-workspace/openclaw/`
  in overlapping directories (T5 and T6 both edit `hypaware.plugin.json`; T6
  and T7 both edit `projector.js`) without importing each other's new symbols.
  This is a plain git-merge-order concern, not a scheduling dependency: keep
  each task's diff to the hunks the brief above names so a later task's PR
  rebases cleanly.
- Two "living lists", T1's `DEFERRED_SET` and T9's CLI-backend allowlist,
  are deliberately incomplete-by-design at ship (LLP 0161 Section 11). Their
  first post-ship addition should land as its own short decision LLP citing
  LLP 0161/0162, not a silent diff to either task's code.

## References

- [LLP 0161](./0161-openclaw-full-capture.design.md): the technical design
  this plan schedules
- [LLP 0157](./0157-openclaw-full-capture.spec.md): the requirements this
  design and plan implement
- LLP 0109, 0143, 0144, 0145, 0146, 0147, 0148, 0149, 0150, 0152, 0158, 0159:
  the Accepted decision set and precedent shapes LLP 0161's sections cite
  section-by-section
- `hypaware-core/plugins-workspace/claude/src/settle.js`,
  `hypaware-core/plugins-workspace/claude/src/transcripts.js`,
  `hypaware-core/plugins-workspace/codex/src/index.js`,
  `hypaware-core/plugins-workspace/codex/src/config.js`,
  `hypaware-core/plugins-workspace/codex/src/backfill.js`,
  `src/core/codex/rollout_session_meta.js`,
  `src/core/backfill/scan_util.js`,
  `src/core/config/client_detach_disk.js`, `src/core/daemon/status.js`,
  `docs/ACCEPTANCE.md`: the precedent and target files each task above names
