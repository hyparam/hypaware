# LLP 0178: Manual attach prompts to enable the client adapter, implementation plan

**Type:** plan
**Status:** Active
**Related:** LLP 0174
**Generated-by:** neutral

> [LLP 0174](./0174-attach-prompts-to-enable.design.md) settles that `hyp
> attach` gains three-state failure detection (unknown client / known-but-
> not-enabled / registered) plus a guided error everywhere, and, on top of
> that detection, an interactive enable-then-attach-then-backfill prompt.
> The design's own open-questions log settles that this ships as **two
> change sets**: detection + guided error first (fixes the dead end for
> every caller, including non-TTY and `--json`), the interactive prompt
> second, built on that detection. This plan turns both into one task
> graph, ordered so the change-set boundary is a real dependency cut, not
> narrative sequencing.

## Change-set boundary

**Phase 1 - T1 through T4.** Three-state detection, the guided error at
both failure sites in `src/core/commands/clients.js`, and the `hyp attach
all` one-line notes. No task in this phase depends on anything below the
line. A human can cut `integration/attach-prompts-to-enable` into its own
merged PR after T1-T4 land and open a fresh integration branch for phase 2
later; nothing here requires the interactive flow to exist.

**Phase 2 - T5 through T11.** The interactive prompt, the guarded config
write it triggers, the daemon restart + gateway-bind wait, and the reused
backfill consent question. Every task in this phase either depends
directly on a phase-1 task id, or (T5, T7) is mechanically independent of
phase 1's code but has no purpose except serving phase 2, so it is listed
here rather than phase 1.

## How this refines the design against the real tree

Read alongside the design, three things the design states at the
composition level need a concrete implementation seam that does not exist
yet, found while tracing the actual call paths (not assumed from the
design's prose):

- **The three-state check the design specifies (`#detection`) already has
  almost its whole implementation sitting in `src/core/cli/dispatch.js`,
  unexported.** `classifyInactiveState(layered, name)` (dispatch.js,
  currently module-private, ~line 957) is exactly "absent vs disabled, and
  local vs central for the disabled case" - built for LLP 0154's
  dispatch-miss repair, and it already returns `'absent' | 'disabled-local'
  | 'disabled-central'` from the same two-layer `resolveLayeredConfigFromDisk`
  (already exported, `src/core/runtime/boot.js`) this design needs. T1 just
  exports it; T3 is the only task that has to write new classification
  logic, and only for the "is the client in the static catalog at all, and
  is its owning plugin live-registered" half `classifyInactiveState` does
  not cover.
- **`buildClientDescriptorMap` (`src/core/commands/clients.js`) already
  builds the exact bundled+installed catalog the design points to for
  state 2 ("the same discovery detach already uses"), but throws away
  everything except `clientDescriptors`.** The interactive flow's dependency
  list ("the same composition the picker uses, `requires_gateway` and
  friends") needs `pickerDescriptors` from that same catalog build, and
  detection needs `pluginMetadata`/`knownDatasets` to call
  `resolveLayeredConfigFromDisk`. T2 generalizes the function once instead
  of building the catalog twice under two names.
- **The design's step 3 ("dispatch to the adapter's `attach()` exactly as
  today") is not free once the guided path actually runs.** `hyp attach`
  is a single short-lived CLI process; `ctx.capabilities.require(...)` and
  `gateway.getClient(name)` only see plugins this *same* process activated
  at its own boot. Writing config and restarting the *daemon* (a separate,
  long-running process) does not, by itself, make this invocation's own
  `ctx.capabilities` see the newly-enabled adapter - the daemon restart is
  necessary for the daemon's own live-capture gateway registry, but is
  orthogonal to whether this one CLI invocation can call `client.attach()`
  in-process afterward. `src/core/cli/dispatch.js` already solves an
  adjacent version of this problem (`activateSeamCommandPlugins`,
  ~line 790: activate a config-newly-enabled plugin's dependency closure
  into the *running* kernel so a command written after boot is still
  dispatchable), but that machinery runs at the dispatcher level, above
  `CommandRunContext`, which command bodies like `runAttach` cannot reach
  (`CommandRunContext` has no `runtime`/`kernel` handle, only the narrower
  `capabilities` / `commands.run(name, argv)` seams - see
  `hypaware-plugin-kernel-types.d.ts`). T9 has to resolve this; two
  candidate mechanisms are named there and the choice is left to the
  implementer because the design does not pick one.

## Non-goals carried over from the design (do not implement these)

- No `hyp client enable` / `hyp source disable` verb, and no other new
  imperative surface for the enablement layer.
- No `--enable` / `--backfill` (or any other) accept-flags on `hyp attach`.
  V1 is prompt-only; a script-friendly bypass is explicitly deferred.
- No change to `hyp join` or the LLP 0044 reconciler's own attach
  composition.
- No change to backfill consent semantics or providers: reuse the
  finale's existing question and `runBackfillProvider` verbatim.
- No reopening of LLP 0170's OpenClaw first-sweep consent stance. The
  OpenClaw prompt variant is a disclosure of existing behavior, not a new
  gate.
- No fix to the wizard finale's OpenClaw asymmetry
  (`src/core/cli/wizard/pick.js`'s hardcoded `claude`/`codex` client list).
  That is a separate, related request the design explicitly declines to
  fold in here.
- Do not edit `llp/0174-attach-prompts-to-enable.design.md` itself
  (Accepted) beyond what its own "Annotations to add when code lands"-style
  bookkeeping requires in the *code* via `@ref LLP 0174#<anchor>`
  annotations; if an implementer finds the design wrong rather than merely
  under-specified, that is a new request against it, not a plan edit here.
- **Remove the drifted `[--yes]` token** from the JSDoc usage line above
  `runAttach` in `src/core/commands/clients.js` (currently `hyp attach
  [client] [--client <name>] [--yes]`; nothing parses `--yes` for attach,
  and the real CLI usage string in `src/core/cli/core_commands.js` already
  omits it). This is folded into T1 since it is a one-line, zero-risk
  cleanup in a file phase 1 is already touching.

## Tasks

- id: T1   branch: task/attach-prompts-to-enable/T1   deps: []                    complexity: 2  -- `src/core/cli/dispatch.js`: add `export` to `classifyInactiveState(layered, name)` (~line 957) with no behavior change (it already returns `'absent' | 'disabled-local' | 'disabled-central'` from a `{ effective, centralConfig }`-shaped `layered`). Same commit: in `src/core/commands/clients.js`, fix the drifted JSDoc usage line above `runAttach` (~line 48) from `` `hyp attach [client] [--client <name>] [--yes]` `` to match the real usage string in `src/core/cli/core_commands.js` (`hyp attach [client] [--client <name>] [--dry-run] [--json]`). Test: new `test/core/classify-inactive-state.test.js` importing the now-exported function directly and asserting all three outcomes against hand-built `layered` fixtures (entry absent; entry `enabled:false` present only in local; entry `enabled:false` present in both local and central); confirm `npm test`'s existing `test/core/dispatch-inactive-plugin.test.js` still passes unchanged; `grep -n "\-\-yes" src/core/commands/clients.js` returns nothing.
- id: T2   branch: task/attach-prompts-to-enable/T2   deps: []                    complexity: 3  -- `src/core/commands/clients.js`: generalize `buildClientDescriptorMap(ctx)` (~line 1355) into a new exported `buildAttachPluginCatalog(ctx)` that returns the full `buildPluginCatalog(bundledLoaded, installedLoaded)` result (`{ plugins, pluginMetadata, knownDatasets, clientDescriptors, pickerDescriptors }`) instead of discarding everything but `clientDescriptors`; keep `buildClientDescriptorMap` exported with its exact current signature and behavior, reimplemented as `(await buildAttachPluginCatalog(ctx)).clientDescriptors`, so its three existing call sites in this file (~lines 100, 223, 331) and any other importer are unaffected. Test: existing attach/detach/skills-install tests that exercise `buildClientDescriptorMap` (e.g. `test/core/client-detach-disk.test.js`) pass unchanged; a new assertion (in a new or existing fixture-plugin test) that `buildAttachPluginCatalog` also returns non-empty `pickerDescriptors` and `pluginMetadata` for a fixture workspace containing the claude and ai-gateway manifests.
- id: T3   branch: task/attach-prompts-to-enable/T3   deps: [T1, T2]              complexity: 4  -- `src/core/commands/clients.js`, `runClientLifecycle`'s attach branch: replace the two current failure messages with three-state detection per design `#detection`. At the `cap_missing` gate (`if (!ctx.capabilities.has('hypaware.ai-gateway'))`, ~line 137) and at the registry-miss gate (`if (clientNames.length === 0)` after `expandClientName`, ~line 174-178), resolve state via T2's `buildAttachPluginCatalog(ctx)`: (1) `clientDescriptors.has(name)` false -> state `unknown`, keep the current `unknown client. Registered/Known clients: ...` text and exit code unchanged; (2) `clientDescriptors.has(name)` true but the client is not live (capability absent, or `gateway.getClient(name)` undefined) -> state `not_enabled` or `disabled_central`, resolved by calling T1's exported `classifyInactiveState(layered, descriptor.plugin)` where `layered` comes from `resolveLayeredConfigFromDisk({ stateRoot, configPath, knownPlugins: catalog.pluginMetadata, knownDatasets: catalog.knownDatasets })` (`stateRoot` via `readObservabilityEnv(ctx.env).stateDir`, `configPath` via the same resolution `configuredGatewayEndpoint`'s caller already uses / `ctx.env.HYP_CONFIG` else `defaultConfigPath`); `'absent'`/`'disabled-local'` both render the guided error `error: the ${name} adapter is not enabled on this install; enable it with 'hyp init', or add @hypaware/${plugin} to ${configPath} and run 'hyp daemon restart', then re-run attach` with `error_kind: 'adapter_not_enabled'`, `'disabled-central'` renders `error: the ${name} adapter is disabled by your fleet config; a local config cannot override the central-managed setting` with `error_kind: 'adapter_disabled_central'`; (3) client live -> unchanged current behavior. Bare `hyp attach` (defaults to `claude`) takes this same path, unchanged from today's default-resolution. Preserve the existing `--json` payload shape, only adding `error_kind`/the new message text. Test: extend `test/core/attach-policy.test.js` (or a new `test/core/attach-enablement-state.test.js`) with fixtures for all three states reached through *both* gates - zero gateway-using plugins active (`cap_missing` path lands on `not_enabled`), some other gateway-using plugin active but the requested client's adapter is not (`unknown client`-today path lands on `not_enabled` instead), and a central-config fixture naming `@hypaware/claude` with `enabled: false` (lands on `disabled_central`) - asserting the exact message and `error_kind` for each, and that a genuinely unrecognized name still gets today's plain `unknown client` text.
- id: T4   branch: task/attach-prompts-to-enable/T4   deps: [T3]                  complexity: 2  -- `src/core/commands/clients.js`, the `hyp attach all` expansion (`expandClientName(parsed.client, gateway)` returning `gateway.listClients()`): after computing the live-registered `clientNames` for the `all` sentinel, diff them against T2's `buildAttachPluginCatalog(ctx).clientDescriptors` keys and, for every catalog-known client missing from the live set, print one line to stdout - `note: ${name} is a known client but its adapter is not enabled; run 'hyp attach ${name}' to enable it` - using T3's classification to skip printing a note for a genuinely `unknown`-to-the-catalog id (there is none, by construction, since the diff is catalog-keys minus live-keys). Do not prompt, error, or change the exit code for these notes; every live-registered client in the `all` expansion still attaches exactly as before. Test: a fixture with two catalog-known clients where only one is live-registered asserts (a) the live one attaches normally, (b) exactly one `note:` line is printed naming the other and the fix command, (c) the command's exit code reflects only real attach failures among the live set, unaffected by the note.
- id: T5   branch: task/attach-prompts-to-enable/T5   deps: []                    complexity: 2  -- `src/core/cli/walkthrough.js`: add `export` to `defaultBackfillConsentPromptFactory` (~line 188) and to the private title-builder it and `legacyBackfillConsentPromptFactory`/`tuiBackfillConsentPromptFactory` share (`backfillConsentTitle`), with no change to their behavior, so the interactive attach flow (T9/T10) can ask the identical question instead of re-implementing its copy. No other code in `walkthrough.js` changes. Test: existing wizard/finale tests that exercise the backfill consent prompt (e.g. anything under `test/` covering `runPickerFinale`/`runFinaleBackfill`) pass unchanged; a new test imports `defaultBackfillConsentPromptFactory` directly from outside `walkthrough.js` and asserts it produces the same prompt title/copy the finale shows today for a sample `{ providers, retentionDays }`.
- id: T6   branch: task/attach-prompts-to-enable/T6   deps: [T2]                  complexity: 3  -- New exported function (co-located in `src/core/cli/walkthrough.js` next to `composePickerConfig`, since it is a one-descriptor slice of that same fold) `resolveSingleSourceEnablement(descriptor)` taking one `PickerDescriptor` (from T2's `buildAttachPluginCatalog(ctx).pickerDescriptors.get(name)`) and returning `{ requiresGateway: boolean, pluginNames: string[], entries: PluginConfigInstance[] }`: `entries` is `[@hypaware/ai-gateway (if descriptor.compose.requires_gateway), ...([descriptor.compose.plugin] filtered to defined), ...(descriptor.compose.plugins ?? [])]`, `pluginNames` their `.name`s in the same order, mirroring exactly the per-descriptor fold inside `composePickerConfig` (~lines 630-666) without the multi-descriptor union/upstream-merge machinery that fold needs for the whole picker. This is the "same composition the picker uses (`requires_gateway` and friends)" the design cites for the prompt's dependency list. Test: unit test asserting the exact `entries`/`pluginNames` for the claude picker descriptor (`@hypaware/claude` + `@hypaware/ai-gateway`) and the openclaw one (`@hypaware/openclaw` + `@hypaware/ai-gateway`), reading the real bundled manifests via `buildPluginCatalog`, not hand-rolled fixtures, so a manifest edit that changes the dependency set fails this test rather than drifting silently.
- id: T7   branch: task/attach-prompts-to-enable/T7   deps: []                    complexity: 2  -- `src/core/commands/clients.js`: extend the existing "cannot resolve the gateway endpoint" give-up message (~line 287-296, in the manual-attach endpoint-resolution ladder) to additionally name `hyp daemon install` / `hyp daemon start` when `(await import('../daemon/install.js')).serviceDaemonStatus({ homeDir })` reports the service is not installed, per design `#bootstrap-floor`'s "config exists but no daemon is installed" case. Keep the existing wording and `hyp start` mention for the case where a daemon service *is* installed but not currently reachable. [Correction, landed after this plan: `hyp start` was never a registered command, so following it produced "hyp: unknown command 'start'"; the shipped message spells the same mention `hyp daemon start` (issue #834). What T7 settled, that the installed-but-unreachable case names the lifecycle start command only and never `hyp daemon install`, is unchanged.] No other behavior in the ladder changes. Test: extend the existing endpoint-fallback test (`test/core/attach-endpoint-fallback.test.js`) with a case asserting the extended message text appears when no daemon service is installed, and that the current message is unchanged when one is installed but unreachable.
- id: T8   branch: task/attach-prompts-to-enable/T8   deps: [T6]                  complexity: 4  -- New function `enableClientAdapter({ name, entries, ctx })` (new module `src/core/config/client_enable.js`, alongside the existing `client_detach_disk.js`) doing: (1) read the current local config via `loadConfigFile(configPath)` (falling back to `{ version: 2, plugins: [] }` only if `configPath` resolves but the file is genuinely absent - the bootstrap-floor "no config at all" case is gated by the *caller*, T9, before this is ever invoked); (2) additively append each of T6's `entries` whose `name` is not already present in the *effective* merged config (read via `resolveLayeredConfigFromDisk`, so an entry the central layer already names is never duplicated locally); (3) guard the write with the existing `prepareLocalConfigWrite({ targetPath: configPath, force: true })` (LLP 0031's backup-before-replace; `force: true` because this is a program-driven additive edit behind its own consent prompt, not the user-facing overwrite-confirm `init` uses) and write with the same `JSON.stringify(config, null, 2) + '\n'` shape `pick.js`/`init.js` use; (4) if `serviceDaemonStatus({ homeDir })` reports installed, call `restartServiceDaemon({ homeDir })` then a new `waitForGatewayBind({ env, homeDir, timeoutMs, sleep })` (new export in `src/core/cli/remote_commands.js`, next to `waitForClientAttach`, same poll-with-bounded-timeout shape: poll `resolveLiveGatewayEndpointFromStatus({ stateRoot })` until a port is live or the budget elapses; a timeout returns `{ bound: false }`, it does not throw); (5) if not installed, skip restart/wait entirely and return immediately (T7's extended message is what the caller's subsequent endpoint-resolution ladder will show). Return a structured result naming which of the four steps (write / restart / wait / n/a) completed, so T9/T11 can report failures per-step. Test: a fixture asserting the additive write leaves unrelated existing plugins/keys untouched and produces a `.bak-<ts>` backup; a fixture asserting an entry already present in the effective config is not duplicated; a mocked-`restartServiceDaemon`-plus-fake-`sleep` test asserting `waitForGatewayBind` returns once a fake `status.json` reports a bound port, and returns (not throws) `{ bound: false }` on timeout; a not-installed fixture asserting restart/wait are both skipped.
- id: T9   branch: task/attach-prompts-to-enable/T9   deps: [T3, T6, T8]          complexity: 5  -- `src/core/commands/clients.js`, `runClientLifecycle`'s attach branch: on state `not_enabled` (T3) with a TTY and no `--json`, prompt before doing anything, per design `#prompt`: for Claude/Codex/other, `The ${clientLabel} adapter is not enabled on this install. Attaching requires it. Enable ${T6-derived plugin list} now? [y/N]`; for OpenClaw specifically, the `#openclaw` disclosure variant naming the periodic sweep import up front, same `[y/N]`. Bootstrap floor (`#bootstrap-floor`): if no local config file exists at all (test via the same existence check `prepareLocalConfigWrite` uses internally), skip the prompt entirely and fall through to T3's existing guided error (which already names `hyp init`) - never prompt when there is nothing to add to. The `disabled_central` state never reaches this task's prompt branch at all; T3's refusal is the only behavior for it, unchanged. On decline, exit 1 with zero side effects (no write, no restart), matching today's refusal shape. On accept: call T8's `enableClientAdapter`, then **resolve the crux left open in "How this refines the design"** - this same CLI invocation must dispatch to the newly-enabled adapter's `attach()` afterward, which needs this process's own `ctx.capabilities`/`gateway.getClient(name)` to see the plugin T8 just wrote. Two mechanisms are viable and the choice is this task's to make and document in-code: (a) generalize `activateSeamCommandPlugins`'s dependency-closure activation (`src/core/cli/dispatch.js` ~line 790) into a helper usable outside the command-dispatch-miss seam, exposed to `runAttach` through a new, narrow `CommandRunContext` capability (this would also require extending `hypaware-plugin-kernel-types.d.ts`'s `CommandRunContext` and the dispatcher that populates it), or (b) after T8 completes, re-run this command's own dispatch from a fresh boot against the just-written config (in-process re-boot-and-redispatch, or a self re-exec) before proceeding to the existing `client.attach()` call. Whichever is chosen, it must not start a second gateway network listener in the CLI process (activation, not binding, is all that is required - see the existing dry-run branch's `gateway.localEndpoint()` try/catch for the precedent that activation and listener-binding are already separate concerns in this codebase). After the adapter is reachable, dispatch continues exactly as today's registered-client path (endpoint resolution ladder unchanged, `client.attach()`, asset materialization). Test: an interactive-prompt-driven attach test (fixture stdin, no daemon) asserting decline exits 1 with no config/backup file written; a matching accept-path test (with a stubbed `enableClientAdapter` and a fake daemon status) asserting the client's settings file ends up attached, proving whichever mechanism was chosen actually reaches `client.attach()`; an exact-string test asserting the OpenClaw prompt copy differs from the Claude/Codex copy per the two quotes in design `#prompt`/`#openclaw`; a no-config-file fixture asserting the prompt is skipped and T3's `hyp init`-naming error is shown instead.
- id: T10  branch: task/attach-prompts-to-enable/T10  deps: [T5, T9]              complexity: 3  -- Wire the backfill consent step into T9's accept path, after a successful attach dispatch: ask T5's exported `defaultBackfillConsentPromptFactory`-produced question (same copy the init finale shows) for the just-attached client, and on yes call `runBackfillProvider` (`src/core/commands/backfill.js`, the same function `buildPickerBackfillRunner` in `src/core/commands/init.js` wraps) for that client's provider if one is registered in `ctx.backfills`; on no, or if the client has no registered backfill provider, leave history unimported with no further action, exactly matching the finale's decline behavior. This step never runs for a client whose adapter was already enabled (today's registered-state attach path is completely unchanged - this is reachable only from T9's accept branch). Test: an accept-then-yes fixture asserting the provider's `run` is invoked with the expected `{ provider, dryRun: false, retentionDays, until }` shape and its result is reported; an accept-then-no fixture asserting no backfill run occurs; a client-with-no-provider fixture (e.g. a hypothetical adapter with no `contributes.backfill`) asserting the question is not asked at all.
- id: T11  branch: task/attach-prompts-to-enable/T11  deps: [T9]                  complexity: 3  -- Harden T9's accept path with per-step failure reporting and resumability, per design `#prompt`'s "each step reports its own failure" paragraph: if T8's write succeeds but the restart or wait step fails, report exactly which step failed, state that the config change persists and name the `.bak-<ts>` backup path T8 returned, and say that re-running `hyp attach` resumes from the new state; if the write itself fails, report that and nothing else changed. Re-running `hyp attach <name>` after a partial failure must not re-ask the enable question (T3 now classifies the client as no-longer-`not_enabled` once the config write landed, even if the daemon never came back up - it falls through to the registered-client path and T7's extended endpoint give-up message, not back to T9's prompt). Test: a mocked sequence where the write succeeds but `restartServiceDaemon` throws, asserting the reported message names the restart step, the backup path, and the resume instruction, and does not attempt to enable a second time; a second-invocation fixture (config already carries the entry from the failed first run) asserting attach now takes the already-registered-or-daemon-unreachable path instead of prompting again.

## What phase 2 explicitly does not settle

Per the design's own non-goals, none of T5-T11 introduce a way to skip the
prompt (no flags), change what "enable" means (still exactly the config
entries T6 resolves, nothing bundled in), or touch `hyp join` / the
reconciler. T9's mechanism choice for in-process dispatch (`(a)` vs `(b)`
above) is the one place this plan leaves an implementation decision
genuinely open rather than settling it in advance; whichever is chosen,
land its own short rationale as an `@ref LLP 0174#prompt [implements]`
annotation directly above the new activation/redispatch call, per
CLAUDE.md's annotation rule, so the choice is discoverable without reading
this plan again.
