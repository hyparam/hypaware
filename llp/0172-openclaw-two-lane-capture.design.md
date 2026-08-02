# LLP 0172: OpenClaw two-lane capture, technical design

**Type:** design
**Status:** Active
**Systems:** Plugins, Gateway, Config, Sources
**Generated-by:** neutral
**Related:** LLP 0167, LLP 0171, LLP 0168, LLP 0169, LLP 0170

> Technical design for the one deliverable set LLP 0171 specifies: the
> reworked `@hypaware/openclaw` attach/detach module (Lane A), the daemon-side
> scheduled sweep (Lane B), the `json_path` core revival, the
> `openclaw-steering-plugin/` deletion, and the acceptance/onboarding
> rewrites. Named files, exact call shapes, and the two open forks the prior
> design (LLP 0161) left unresolved for this half: the attach-probe/status
> interaction with issue #544's fix (PR #553), and the scheduling seam for a
> periodic in-process backfill run.

## 0. Scope check {#scope-check}

LLP 0167 is the accepted RFC; LLP 0171 is its requirements spec and states
"one deliverable set"; LLP 0168/0169/0170 are the decisions already merged
between them. Reading all five confirms the orchestrator's premise: nothing
here partitions into separate change sets. Lane A (attach/detach) and Lane B
(the sweep) share one file (`hypaware-core/plugins-workspace/openclaw/src/backfill.js`
gets touched for the quiesce filter that Lane B needs and that Lane A's
dedupe story depends on), one manifest, one config section, and one
acceptance rewrite. Splitting them would mean landing a manifest with a
`json_path` probe that Lane A's detach code doesn't yet honor, or shipping
the sweep with no attach surface to net its overlap against. This design
stays a single change set.

## 1. Lane A: attach {#lane-a-attach}

### 1.1 What gets deleted first

`hypaware-core/plugins-workspace/openclaw/src/index.js` currently registers
`gateway.registerClient({ name: 'openclaw', defaultUpstream: 'anthropic',
async attach(attachCtx) {...} })` with an honest no-op body: it prints
`ROUTING_OWNED_BY_STEERING_PLUGIN_MESSAGE` and writes nothing. That whole
body, `STEERING_PLUGIN_NAME`, and `ROUTING_OWNED_BY_STEERING_PLUGIN_MESSAGE`
go. So does the `@ref LLP 0143#decision` comment block above it (lines
164-169 in the current tree) explaining why a no-op is correct: LLP 0169
supersedes that reasoning outright.

### 1.2 The new attach module

New file: `hypaware-core/plugins-workspace/openclaw/src/attach.js`, mirroring
the shape of `hypaware-core/plugins-workspace/claude/src/index.js`'s
`attach()` registration (same `AiGatewayClientAttachContext` parameter,
same `withSpan('client.attach', ...)` wrapper, same dry-run branch writing
through `attachCtx.stdout`/`attachCtx.json`). It exports
`createOpenclawAttach({ homeDir, fs })` returning an object with one method,
`attach(attachCtx)`, that `index.js`'s `activate()` wires into
`gateway.registerClient()` in place of the deleted no-op.

`attach(attachCtx)`:

1. Reads `~/.openclaw/openclaw.json` (or `$OPENCLAW_HOME/openclaw.json` if
   that env var is set, matching how the plugin already resolves the
   settings file elsewhere). A missing or unparseable file is a hard
   failure (`{status: 'failed', reason}`), not a refusal: attach can't
   reason about a config it can't read.
2. Checks `config.models?.providers?.anthropic` and
   `config.models?.providers?.openai`. If **either** key holds an entry
   HypAware did not write, refuse: return `{status: 'failed', reason:
   'models.providers.<name> already exists in openclaw.json and was not
   written by HypAware; attach refuses to merge (LLP 0167#attach-detach).
   Remove it by hand or run hyp detach --client openclaw first.'}` (R2).
   Nothing is written; this is a pure read-then-decide, no partial write
   to roll back.

   The test is **ownership, not bare presence**, and the difference is
   load-bearing rather than cosmetic. 1.4 gives OpenClaw an
   `attach_probe`, which is what makes it eligible for attach-on-join
   (`action_attach.js`'s `desired()`), and `isCurrent()` returns false
   whenever `marker.endpoint !== ctx.endpoint` (an ephemeral-port
   rebind, LLP 0086) or the recorded `assets_key` drifts (LLP 0107). The
   reconciler then re-`perform()`s, and a presence-only refusal fails
   every one of those passes: the marker churns to `failed` with
   `attempts` climbing, `hyp attach openclaw` exits 1 (1.3's rethrow),
   and `openclaw.json` stays pinned to the dead port while
   `probeClientAttachFromDescriptor`'s `json_path` branch, which matches
   the marker header and never the base URL, keeps reporting
   `attached: true`. `isCurrent`'s own contract says the opposite
   ("`perform()` is idempotent in both halves"), so the write has to be
   idempotent over its own previous output.

   The entry attach writes is self-identifying: `baseUrl`,
   `headers['x-hypaware-upstream']` naming the key it sits at, and the
   empty `models` array. That is exactly the triple 2.2's detach already
   applies before it may delete an entry, so the two live in one shared
   predicate, `src/core/config/provider_entry_ownership.js`
   (`isOwnedProviderEntry` + `ownedBaseUrls`, moved out of
   `client_detach_disk.js`), rather than being restated on each side
   where they could drift into disagreeing about the same file. The
   predicate's base-URL set is optional and attach passes none: on a
   drift re-attach its own entry carries the *old* origin by
   construction, so pinning the check to the live endpoint would
   reintroduce the refusal it exists to avoid. Detach always passes the
   set, because there the wrong answer deletes a value HypAware never
   wrote. Anything failing the test still refuses, including a bare
   `"anthropic": null`, a user entry that happens to sit at the key, and
   a hand-edited one that merely kept the header.
3. Otherwise, computes the two entries from `attachCtx.endpoint` (the
   proven-bound local gateway base URL the daemon resolves in
   `src/core/daemon/runtime.js`'s `resolveClientSeam` today, or the
   configured-listen fallback the manual CLI path already uses for `hyp
   attach`) exactly per LLP 0167#override-entries:

   ```json
   {
     "models": {
       "providers": {
         "anthropic": {
           "baseUrl": "<endpoint>",
           "headers": { "x-hypaware-upstream": "anthropic" },
           "models": []
         },
         "openai": {
           "baseUrl": "<endpoint>/v1",
           "headers": { "x-hypaware-upstream": "openai" },
           "models": []
         }
       }
     }
   }
   ```

   The bare-origin vs `+/v1` asymmetry is load-bearing (LLP 0167
   #verify-results): OpenClaw's Anthropic client appends its own path,
   its OpenAI client does not. Writing the wrong shape for either
   produces a schema-valid but non-functional entry, so this exact split
   is the one place in the module worth a dedicated unit test rather than
   trusting the acceptance run alone.
4. Writes the merged config back (existing `models` keys the file already
   had, if any that aren't `providers.anthropic`/`.openai`, are preserved;
   nothing outside these two keys under `models.providers` is touched, R1).
5. Prints the `openclaw gateway restart` instruction on both the human and
   `--json` output paths (R4), the same way Claude's `attach()` already
   prints its own follow-on instructions when one applies.
6. Returns `{status: 'done'}`.

```
@ref LLP 0167#attach-detach [implements]: attach writes exactly the two
models.providers entries, refuses instead of merging when either already
exists, and prints the restart instruction; no undo record beyond the
entries themselves.
```

### 1.3 Refusal during join must not fail the join

R2's join-safety clause needs no new mechanism. `src/core/config/action_backfill.js`'s
`perform()` already establishes the contract every `ActionHandler` in this
reconciler follows: a `{status: 'failed', reason}` outcome is recorded and
retried next pass, it does not throw, and it does not abort the reconciler's
other actions for the same client. The effect in `attach.js` returns exactly
that shape on refusal (step 2 above), so attach-on-join downgrades a refusal
to a warning by the pre-existing generic contract, not by anything this
design adds. The design obligation is narrower than it first looks: make sure
the effect never throws on the refuse path (it returns a status object) and
never partially writes before deciding to refuse (step 2 runs before step 4).
Both are satisfied by the ordering above.

One translation step is load-bearing and easy to miss. The kernel types the
**registered** `attach()` as `Promise<void>`, so the effect's returned outcome
reaches no caller: `action_attach.js`'s `perform()` and `hyp attach`'s
`runClientLifecycle` both infer success from "did it throw". The registered
wrapper in `index.js` therefore rethrows a `failed` outcome
(`if (outcome.status === 'failed') throw new Error(outcome.reason)`), which is
what actually produces the `{status: 'failed', reason}` outcome above:
`perform()`'s catch converts it, and the reconciler records, warns, and
retries it without touching the join's other actions. Swallowing the outcome
instead is not the join-safety clause but its opposite: `perform()` would
record `done`, `isCurrent()` would match on both the endpoint and the
`assets_key` forever, and the refusal would never be retried even once the
user cleared the conflicting `models.providers` entry (while the `json_path`
attach probe kept reporting `not attached`). The same swallow made
`hyp attach --client openclaw` print a refusal and exit 0, so no script could
tell a refusal from a success. Rethrowing at the wrapper, rather than teaching
`perform()` to parse the adapter's `--json` payload, is what fixes both
callers: `runClientLifecycle` hands the adapter `ctx.stdout` directly and
never captures it, so it has no payload to inspect.

```
@ref LLP 0169#decision [implements]: a refuse during join warns and never
fails the join, via the existing ActionOutcome 'failed' contract, not a new
one.
```

### 1.4 Manifest registration

`hypaware-core/plugins-workspace/openclaw/hypaware.plugin.json`'s
`contributes.client` gains:

```json
"attach_probe": {
  "format": "json_path",
  "settings_file": ".openclaw/openclaw.json",
  "container_path": "models.providers",
  "provider_keys": ["anthropic", "openai"],
  "marker_header": "x-hypaware-upstream",
  "cache_glob": "agents/*/agent/models.json"
}
```

`description` and the `picker[0].summary` lose every reference to
`@hypaware/openclaw-steering-plugin` (LLP 0167#onboarding); see 5.2.

## 2. Lane A: detach {#lane-a-detach}

### 2.1 The `json_path` format returns to core

LLP 0143 removed the `probe.format === 'json_path'` branch from both
`src/core/config/client_detach_disk.js` and `src/core/daemon/status.js`,
because LLP 0152 (the now-superseded steering design) left nothing on disk
for that branch to reverse or read. LLP 0168 reverses that premise; LLP 0169
names the restoration explicitly ("core restores the `json_path` branches
removed by PR #510"). The restored branch is not a resurrection of the old
single-entry, single-`hypaware`-provider shape (that shape belonged to
LLP 0109's design, before LLP 0167 replaced one shadow provider per vendor
family with the two canonical entries of LLP 0168). It is a new
implementation shaped for two entries plus a cache purge, driven by the
manifest fields in 1.4.

`client_detach_disk.js`'s `detachClientFromDisk` dispatcher gains:

```js
if (probe.format === 'json_path') {
  return await detachJsonPathProviders({
    settingsPath,
    containerPath: probe.container_path,
    providerKeys: probe.provider_keys,
    markerHeader: probe.marker_header,
    cacheGlob: probe.cache_glob,
    homeDir,
    expectedBaseUrl,
    fs,
  })
}
```

`expectedBaseUrl` is the one new fact the dispatcher needs that it doesn't
already have: the gateway's own currently-resolved base origin, so the
routine can tell "this entry is ours" from "this entry merely looks like
ours." `detachClientFromDisk`'s caller, `detachClientViaCore` in
`src/core/commands/clients.js`, already receives a full `CommandRunContext`
(`ctx`), which carries `ctx.capabilities`. The daemon reconciler resolves
the same fact today via `boot.runtime.capabilities`'s `AiGatewayCapability`
(`clients.localEndpoint()`, described at `src/core/daemon/runtime.js` around
the `resolveClientSeam` helper); the manual CLI path already has a
configured-listen fallback for the case where no daemon is bound (the
comment at that call site notes the daemon's rule, proven-bound only, is
stricter than "that's the manual path's"). `detachClientViaCore` resolves
`expectedBaseUrl` the same way and threads it through. No new capability,
no new context field: this is the existing `AiGatewayCapability` lookup,
called from a second, already-instantiated location.

### 2.2 `detachJsonPathProviders`: ownership, backup, purge

New function, same file (`client_detach_disk.js`), generic over the
manifest fields (not OpenClaw-named in the implementation, though OpenClaw
remains the sole consumer exactly as LLP 0143 observed for the prior
format):

1. Read the settings file. Absent file: `{changed: false}` (nothing to
   reverse, matching every other format's absent-file behavior).
2. For each key in `providerKeys` (`anthropic`, `openai`): look up
   `containerPath.key` (i.e. `models.providers.anthropic`). Absent: skip
   this key, nothing to do.
3. **Present:** compare its `baseUrl` against `expectedBaseUrl` /
   `expectedBaseUrl + '/v1'` (the same asymmetry attach wrote) and confirm
   `headers[markerHeader]` equals the key name. Both match: this entry is
   ours, delete the key from the parsed object (R3's "delete only when its
   `baseUrl` is the gateway's").
4. **Present but mismatched** (wrong `baseUrl`, missing/different marker
   header, or a value shape attach wouldn't have produced, e.g. `models`
   not an empty array): back it up rather than discard it, following the
   `prev_malformed` precedent LLP 0163 established for Claude's malformed
   `env`/`hooks` blocks. The backup lands under a sibling key in the same
   file (e.g. `models.providers.anthropic` moves to a HypAware-owned
   `_hypaware_detach_backup.anthropic` before the live key is removed),
   not a side-channel state file, so the same `openclaw.json` a human
   reads after detach shows both "this key is gone" and "here is what was
   there, in case you need it back." LLP 0163 flagged this exact
   json/toml-vs-json_path asymmetry (json/toml back up in-place inside the
   marker; OpenClaw's prior format refused rather than backed up) as
   "worth its own look." This design closes that gap in the same
   direction LLP 0163 already took Claude: never discard a value HypAware
   didn't write.
5. Write the modified config back if any key changed or was backed up.
6. **Cache purge (R3, independent of step 3-5's outcome):** glob
   `homeDir/.openclaw/<cacheGlob>` (`agents/*/agent/models.json`), where
   the `.openclaw` half is the client's *config home*, derived back out of
   the already-resolved `settingsPath` rather than re-joined onto
   `homeDir`, so a `$OPENCLAW_HOME` relocation cannot leave the purge
   working in a different home than the settings write did. For
   each matched file, best-effort parse it and delete `providerKeys`
   entries if present, then write it back. A file that fails to parse is
   logged and skipped, not fatal: LLP 0169 notes these caches "do not
   self-heal," so a best-effort purge is strictly better than the status
   quo even when one file is unreadable, and detach must not fail the
   whole operation over one cache file.
7. Return `{changed: <any key removed or backed up>, settingsPath}`.

```
@ref LLP 0169#decision [implements]: detach deletes an entry only when its
baseUrl is the gateway's, backs up a present-but-not-ours or mangled entry
instead of discarding it, and deletes the written provider keys from every
agents/<id>/agent/models.json.
```

```
@ref LLP 0163#open-questions [implements]: LLP 0163 left "does OpenClaw
converge?" open, arguing it did not, on the ground that OpenClaw's own
config rejects a top-level marker; this design converges the *outcome*
(backup instead of discard) without adopting the marker-key mechanism LLP
0163 correctly ruled out for OpenClaw.
```

Step 5 (write back after step 3/4) and step 6 (cache purge) both end with
the same restart-instruction print as attach (R4). `detachClientViaCore`
already has an output-writing seam (`writeCoreDetachOutput`); the
instruction rides that, not a new print call scattered in the core routine.

**An unknown `expectedBaseUrl` refuses rather than defaults (added in T2).**
Steps 3 and 4 are one branch on ownership, so an absent gateway base URL
does not leave the routine with a safe default: treating every entry as
ours deletes values HypAware never wrote, and treating none as ours reports
a finished detach while the client stays routed at a port the daemon no
longer serves. There is no third answer available from disk, because this
format's undo record *is* the entry. So when at least one `providerKeys`
entry is present and no base URL was threaded in, `detachJsonPathProviders`
throws `ClientDetachError` (`code: 'EXPECTED_BASE_URL_UNKNOWN'`) instead of
picking one of the two wrong answers. Both callers already degrade
correctly: `reverse()` catches it into `{status:'failed'}` and keeps the
marker (which is the #212-safe outcome, not the orphaning one), and
`hyp detach` prints the reason and exits nonzero. An absent settings file
and a file with neither key present are unaffected: they reverse nothing,
so they need no base URL and stay `{changed:false}`.

**The ownership predicate is shared with attach (added in review round 2).**
Step 3's test is the same question 1.2's refusal asks, from the other side,
about the same two keys in the same file, so it lives in one module both
import: `src/core/config/provider_entry_ownership.js`, exporting
`isOwnedProviderEntry(entry, key, markerHeader, ours)` and
`ownedBaseUrls(expectedBaseUrl)`. Only the base-URL half differs, and the
parameter carries that difference explicitly: detach passes the set (see the
refusal above), attach passes `undefined` because a drift re-attach meets its
own entry at the *previous* origin. Two copies would have been free to drift
into disagreeing about whether a given entry is HypAware's, which is how the
presence-only refusal survived review round 1 while detach was already
ownership-aware.

**Where the backup key sits.** "Sibling" is meant literally: the backup
lands at `<containerPath>._hypaware_detach_backup.<key>`, inside the same
container the undo already navigates, not at the file's top level. LLP 0163
ruled a *top-level* HypAware key out for this client (its config schema
rejects one), and that ruling is the entire reason this format refused where
`json`/`toml` backed up; reintroducing the backup as a top-level key would
walk straight back into it.

### 2.3 `daemon/status.js`'s `json_path` read branch

The removed read branch (`probe.format === 'json_path' && probe.marker_header`)
is restored as a pure read, parallel to the existing `json`/`toml` branches
at lines 1066/1083 of the current tree: navigate `container_path` +
`provider_keys[0]` (`models.providers.anthropic`), read
`headers[marker_header]`, and report attached when it equals the expected
marker value for at least one of the two configured keys. This is read-only
and has no ownership/backup concerns; it exists purely to make
`probeClientAttachFromDescriptor` (and therefore `hyp status`'s
`client_attach` row and the `client_attach_missing` diagnostic) true again
for OpenClaw.

```
@ref LLP 0171#requirements [implements]: R5, the manifest registers
attach_probe in json_path format and core restores the json_path branches in
client_detach_disk.js and daemon/status.js.
```

## 3. The descriptor/attach-probe question (interaction 1) {#interaction-1}

**Answer, stated explicitly per the task's requirement:** after this change
set, OpenClaw's manifest declares a real `attach_probe` (1.4, format
`json_path`), so `descriptor.attachProbe` is truthy for OpenClaw for the
first time since LLP 0143 landed. Concretely, against PR #553's
`descriptor.attachProbe`-gated `hyp status` logic:

- **`attachable` flips back to `true`.** PR #553 made a probe-less client
  read as `attach n/a`; OpenClaw is no longer probe-less, so it exits that
  state and re-enters the same real `attached` / `not attached` derivation
  every other `json`/`toml` client already gets, computed by
  `probeClientAttachFromDescriptor` reading the 2.3 branch.
- **The `client actions: attach openclaw` row goes back to real
  `pending`/`done` semantics**, not the `inert` → n/a path PR #553 gave
  probe-less clients. Critically, this `pending` is not the permanently-
  stuck state issue #544 was filed against: #544's bug was a probe-less
  descriptor wedging in `pending` forever because there was truly nothing
  on disk to converge toward. Here, `action_attach.desired()` (which
  already skips probe-less descriptors, the exact condition PR #553's fix
  targeted) sees a real probe, the join reconciler runs `attach()` from
  1.2, and the marker resolves to `done` on a normal run or `failed`
  (retried) on a genuine refusal, same as every other client's row.
- **`client_attach_missing` fires meaningfully again**: since `hyp attach
  --client openclaw` now performs a real, reversible write (1.2), the
  diagnostic's repair suggestion is no longer a dead end, which was exactly
  LLP 0143's "should `hyp status` grow a plugin-registry-derived attach
  signal... worth its own LLP" open question. That question is answered by
  this change set: no separate plugin-registry signal is needed, because
  the disk-driven probe (which PR #553's fix generalized correctly) is
  sufficient once OpenClaw has something reversible on disk again.

No part of PR #553's logic needs to change or special-case OpenClaw: it
already does exactly the right thing for any descriptor with a real probe.
The risk this design has to avoid is only in the manifest and the
attach/detach implementation actually producing a working probe (sections
1.4, 2.1-2.3), not in the status/attach state-machine code itself.

## 4. Lane B: the scheduled sweep {#lane-b-sweep}

### 4.1 What Lane B reuses

`hypaware-core/plugins-workspace/openclaw/src/backfill.js` already
implements `createOpenclawBackfillProvider(opts)`, a `BackfillContribution`
with `plan()`/`run()`, registered via `ctx.backfills.register(...)` in
`index.js`. `src/core/commands/backfill.js` already exports
`runBackfillProvider({ctx, provider, dryRun, retentionDays?, since?, until?,
devRunId?})`, an **in-process** (no subprocess) runner used today by "the
onboarding finale" to import a picked client's history right after config is
written. Internally it calls `runProvider()`, which resolves entrypoint
ownership, builds a `BackfillRunContext` via `buildRunContext()`, iterates
`provider.run(runCtx)`, dispatches each yielded item to
`ctx.backfillMaterializers.get(item.kind)`, writes rows, and flushes every
touched dataset. This is the exact scan-materialize-write-flush pipeline
Lane B needs to run every five minutes; nothing about it is CLI-specific
except the full `CommandRunContext` its outward-facing entrypoint currently
demands.

### 4.2 Kernel type: an optional `sweep` field, not a new mechanism

`BackfillContribution` (in `hypaware-plugin-kernel-types.d.ts`) gains one
optional field:

```ts
sweep?: { cron: string }
```

Absent on every contribution today (Claude's, Codex's, and OpenClaw's own
prior to this change): zero behavior change for any provider that doesn't
opt in. OpenClaw's `createOpenclawBackfillProvider()` populates it from its
own validated config:

```js
sweep: { cron: config.backfill?.sweep_cron ?? '*/5 * * * *' }
```

(R7: "tunable in the plugin's `backfill` config section"). This keeps the
schedule a plugin-owned fact expressed through the kernel's own contribution
shape, not a config value the daemon has to know OpenClaw's name to find,
which is the same "kernel stays plugin-agnostic" discipline
`llp/0000-hypaware.explainer.md` states as a cross-cutting invariant.

`hypaware-core/plugins-workspace/openclaw/src/config.js`'s
`validateBackfillSection` gains a `sweep_cron` key (string, validated as a
5-field cron expression, same validator `cronMatches`'s caller already uses
to reject malformed schedules elsewhere) alongside the existing `on_join`
and `window_days` keys, with the same unknown-key rejection the section
already enforces.

### 4.3 Narrowing `runProvider`'s context type, not widening the daemon's

`runProvider()`, `resolveOwnersForRun()`, and the materialize/write/flush
helpers they call (all in `src/core/commands/backfill.js`) only ever read
`ctx.backfills`, `ctx.backfillMaterializers`, `ctx.env`, `ctx.storage`,
`ctx.query` (`writeRows`/`flushDataset` resolve a dataset's registered
table path through it before a row can be committed or a partition
flushed), and (via `resolveOwnersForRun`) `ctx.config` for
plugin-configured resolution. None of `CommandRunContext`'s other fields
(`stdout`, `commands`, `verbs`, `skills`, `agents`, `sources`, `sinks`,
`initPresets`, `capabilities`, `plugins`, `cwd`) are touched anywhere in
this call path. Rather than force the daemon to assemble a full,
mostly-unused `CommandRunContext` just to call `runBackfillProvider`, this
design narrows the type both functions declare their `ctx` parameter as,
to a new, smaller type:

```ts
// A structural subset of CommandRunContext; every existing
// CommandRunContext satisfies it, so every current call site
// (hyp backfill's CLI path, the onboarding finale) keeps typechecking
// unchanged.
interface BackfillRunnerContext {
  env: NodeJS.ProcessEnv
  config: HypAwareV2Config
  storage: QueryStorageService
  query: QueryRegistry
  backfills: BackfillRegistry
  backfillMaterializers: BackfillMaterializerRegistry
}
```

`runBackfillProvider`, `runProvider`, `resolveOwnersForRun`, and the
materialize/write/flush helpers' `ctx` parameters change from
`CommandRunContext` to `BackfillRunnerContext`. This is a pure narrowing:
`CommandRunContext` is structurally a superset, so no existing caller's
argument stops satisfying the (now smaller) parameter type. The daemon can
now build a `BackfillRunnerContext` object out of fields `boot.runtime`
already carries (`env`, `config`, `storage`, `query`, `backfills`,
`backfillMaterializers`, all already referenced at
`src/core/runtime/activation.js`) without touching `CommandRunContext` or
constructing stub versions of fields it doesn't need.

`query` was not part of this list until LLP 0173 T12's hermetic smoke (the
first caller to drive a real, non-dry-run write through the sweep
driver rather than a mocked `runBackfill` seam) found `writeRows` and
`flushDataset` crash on `ctx.query.getDataset` when the daemon-built
`BackfillRunnerContext` reached them: the field really is on this call
path, this design's original field enumeration just missed it because
T9's own tests never exercised a real write. `BackfillSweepDriverOptions`
(Section 4.4) and the daemon's `createBackfillSweepDriver(...)` call
(`src/core/daemon/runtime.js`) both require `query` now for the same
reason.

### 4.4 Wiring the tick

New file: `src/core/daemon/backfill_sweep.js`, exporting
`createBackfillSweepDriver({backfills, backfillMaterializers, env, config,
storage, query})` with one method, `tick({now})`:

```js
function tick({ now }) {
  for (const provider of backfills.list()) {
    if (!provider.sweep) continue
    if (!cronMatches(provider.sweep.cron, now)) continue
    void runBackfillProvider({
      ctx: { env, config, storage, query, backfills, backfillMaterializers },
      provider: provider.name,
      dryRun: false,
      devRunId: `sweep-${provider.name}-${now.getTime()}`,
    })
  }
}
```

`cronMatches` is imported from `src/core/sinks/driver.js`, the same
due-check the sink driver already uses (LLP 0170's framing: "the daemon
already runs cron-matched periodic work... so this is scheduling an
existing job, not building a new primitive"). `src/core/daemon/runtime.js`'s
`runTick()` already calls `await driver.tick({now, source: 'daemon'})` for
the sink driver inside its `withSpan('sink.tick', ...)` block on the
existing `DEFAULT_TICK_INTERVAL_MS = 60_000` interval; this design adds one
sibling call, `await sweepDriver.tick({now})`, in the same `runTick()`,
right after the sink tick. It rides the existing 60-second loop rather than
opening a second `setInterval` (as the cache-maintenance `maintenanceHandle`
does): a `*/5 * * * *` schedule only ever needs a due-check once a minute,
and reusing the loop means one fewer timer to start, drain, and account for
at shutdown. `runProvider`'s internal work (scan, materialize, write,
flush) is `await`-ed inside the tick but the sweep call itself is fired
without blocking the sink tick behind it (`void runBackfillProvider(...)`
matches the "must never wedge the daemon tick loop" discipline
`action_backfill.js` already documents for the subprocess case; here there
is no subprocess, but a slow provider `run()` still shouldn't stall
`refreshSourceDetails()`/`persist()` later in the same `runTick()`).

Not blocking has a consequence the sketch above leaves out: nothing stops a
provider being due again while its previous run is still going. A pass over a
large transcript tree can outlive the default `*/5 * * * *` interval, and
neither `runBackfillProvider` nor `runProvider` carries a lock, so a second
concurrent run would land on the same datasets and the same mid-flush spool.
The driver therefore keeps a `Set` of in-flight provider names in its closure:
a due provider already in the set is **skipped, not queued** (the sweep is
level-triggered, so the next tick that finds it due and idle picks up whatever
this one would have), logged as `backfill.sweep_skipped` with
`error_kind: 'already_running'` under the same `component`/`operation` pair as
every other sweep record, and the entry is cleared in both settlement handlers.
This is the `maintenanceInFlight` guard `src/core/daemon/runtime.js` already
applies to the sibling periodic job, widened to a set because this driver
fires one run per provider rather than one job.

```
@ref LLP 0170#decision [implements]: the daemon runs the OpenClaw backfill
provider on a cron-matched schedule by extending the existing sink-tick
cadence, not building a new scheduling primitive.
```

### 4.5 The quiesce window

Entirely internal to `backfill.js`, not threaded through
`BackfillRunnerContext` or any kernel type: it is a filter on which session
files a run considers, not a fact the runner or materializer registry needs
to know about. `listSessionFiles(agentsDir)` (currently: enumerate
`agents/*/sessions/*.jsonl` with no time filtering) gains an optional
`quiesceBeforeMs` parameter; `runOpenclawBackfill()` computes it once per
run as `Date.now() - quiesceMs` and skips any file whose `mtimeMs` is more
recent. `quiesceMs` resolves from `config.backfill?.quiesce_ms`, defaulting
to 180,000 (three minutes): the settlement flush interval
(`QUERY_FLUSH_DEBOUNCE_MS = 2 * 60 * 1000` in `src/core/cache/spool.js`)
plus a one-minute margin, so a sweep never races a session file OpenClaw is
still mid-write on, or a settlement pass still mid-flush against the same
turn (LLP 0170: "quiesce window = settlement flush interval + margin").
This default is a real, cited constant, not an invented number; the
`quiesce_ms` config key exists precisely so an operator with a slower disk
or a longer flush debounce can widen it.

```
@ref LLP 0170#decision [implements]: the sweep skips session files whose
mtime is inside the quiesce window, sized from the existing settlement flush
debounce plus margin, not a new invented constant.
```

R8 ("the sweep MUST NOT ship before the issue #543 envelope fix is merged")
is a sequencing constraint on this change set's landing order, not a design
decision: this design is written against the fixed reader (PR #552's
`openclawMessageEnvelope`, reading `role`/`content`/`provider`/`usage` under
a nested `message` key), and the sweep driver in 4.4 has no code path that
degrades gracefully if the old flat reader is still in place, it would
simply project nothing (R8's stated failure mode). The Impl-designer rung
that turns this into tasks needs to sequence the merge of #552 ahead of (or
in the same PR series as) this sweep wiring; this design does not need a
runtime guard for an already-fixed dependency.

## 5. Deletion inventory {#deletion}

Per LLP 0167#deletion-inventory and R9, deleted in the same change set:

- **`openclaw-steering-plugin/`** in full: `src/gateway_endpoint.js`,
  `src/index.js`, `src/runtime_auth.js`, `src/steering.js`,
  `src/warning_ledger.js`, `src/wire_parity.js`, its `package.json`,
  `openclaw.plugin.json`, `.d.ts` files, and its `test/` directory (five
  files). This is the credential-borrowing runtime auth shim
  (`runtime_auth.js`), the live wire-parity mirror (`wire_parity.js`), the
  steering decision logic (`steering.js`), the live warning ledger
  (`warning_ledger.js`), and the gateway endpoint resolver
  (`gateway_endpoint.js`) that only existed to feed them: none of it has a
  purpose once Lane A's config-override entries make OpenClaw route to the
  gateway on its own, with no in-process steering to perform. Roughly 1,900
  lines of source plus tests, matching LLP 0167's "~2,100 lines" estimate
  once the manifest/package.json/`.d.ts` scaffolding is counted.
- **`test/plugins/openclaw-steering-plugin.test.js`** (R9), the root-test
  suite's coverage of the deleted package.
- Inside `hypaware-core/plugins-workspace/openclaw/`: the honest no-op
  `attach()` and its `STEERING_PLUGIN_NAME`/
  `ROUTING_OWNED_BY_STEERING_PLUGIN_MESSAGE` constants (1.1), and every
  manifest/doc string naming `@hypaware/openclaw-steering-plugin` (1.4, 5.2).

**What must survive**, named explicitly because it is easy to mistake for
steering-plugin-only code: the exchange projector
(`createOpenclawExchangeProjector`, `anthropicUpstreamPreset`/
`openaiUpstreamPreset` in `projector.js`), the settlement enricher
(`createOpenclawSettlementEnricher` in `settle.js`), the match-key module
(`match_key.js`), the session-file reader (`session_file.js`, PR #552's
fixed version), and `backfill.js` in its entirety apart from the 4.5
addition. None of these read from or write to the steering plugin; they
read gateway-captured rows and local session files, both of which exist
independent of how routing gets set up. R10 states this in the requirements
language ("the gateway, the exchange projector, settlement, match key,
reader, and backfill projection MUST be unchanged"); this section is the
concrete list an implementer checks the deletion against.

```
@ref LLP 0167#deletion-inventory [implements]: the steering plugin package
and its test suite are deleted whole; the projector, settlement, match key,
reader, and backfill projection are unchanged survivors, not casualties.
```

## 6. Dedupe: R11 nets Lane A/B overlap to zero {#dedupe}

`backfill.js`'s `projectedMessageFromRecord()` already builds each row's
identity from the session file's own native `message.id` directly, with no
match-key indirection (match-key normalization exists for the live-capture
settlement path, not for backfill, because backfill always reads the
session file itself and so is never in fallback/content-hash identity to
begin with). A turn Lane A captured live and settled onto native identity
(LLP 0027/0159's settlement upgrade) and the same turn Lane B later sweeps
out of the session file resolve to the **same** `part_id` by construction:
both derive it from the identical native `message.id`. The existing
dataset-write dedupe on `part_id` (already relied on for re-running `hyp
backfill` idempotently, and for Lane A's own settlement-driven upgrade not
duplicating the fallback-identity row it replaces) nets this overlap to
zero new rows with no new dedupe code. This is why R11 reads as a
consequence of 4.1's reuse, not a separate mechanism to build: the moment
Lane B reuses the exact backfill pipeline that already writes
native-identity rows idempotently, the "sweep over already-captured turns
nets zero writes" requirement (R7's second sentence) and R11 (identity-
identical routes dedupe to zero) are the same fact observed from two
requirements.

```
@ref LLP 0171#requirements [implements]: R11, identity-identical routes from
lane A and lane B dedupe to zero via the existing part_id write-dedupe, since
both lanes resolve identity from the same native message.id.
```

## 7. Carried-over requirements from LLP 0157 {#carried-over}

Per LLP 0171#carried-over, R8/R9/R10/R11/R14 from the prior spec remain
binding, unchanged. Where each is satisfied in the current tree, none of it
touched by this change set:

- **R8** (projector shapes behind the header gate): `projector.js`'s
  `anthropicUpstreamPreset`/`openaiUpstreamPreset` and the exchange
  projector still gate on `x-hypaware-upstream`, now sourced from the
  config-override entries' static `headers` value (LLP 0168) rather than a
  steering-plugin-injected header. The gate itself, and the header name, are
  unchanged; only who writes the header changes, which is exactly R10's
  "unchanged by this change set" for the projector, read together with R8.
- **R9** (the one LLP 0158 reader): `session_file.js`'s
  `openclawMessageEnvelope` (PR #552's fix) stays the sole reader for both
  the settlement path and Lane B's sweep; nothing in this design adds a
  second reader.
- **R10** (backfill policy gate and CLI-backend exclusion):
  `backfill.js`'s `PROJECTABLE_PROVIDERS = new Set(['anthropic', 'openai'])`
  and `effectiveProviders()`'s forward/backward fill are untouched; Lane B
  reuses `runOpenclawBackfill()` as-is apart from the 4.5 quiesce filter,
  which composes with, not around, the existing CLI-backend exclusion.
- **R11**: satisfied per section 6 above, for both requirements sets (LLP
  0157's original R11 and LLP 0171's R11, the same requirement carried
  forward, not two separate obligations).
- **R14** (settlement resolves cwd and applies the policy drop):
  `settle.js`'s `createOpenclawSettlementEnricher` is untouched by this
  design; it still resolves the session's cwd and runs it through the usage
  policy resolver (`createUsagePolicyResolver`, `localOnlyListPath`) exactly
  as before Lane A/B existed in their current shape.

## 8. Acceptance and onboarding rewrites {#acceptance-onboarding}

### 8.1 `docs/ACCEPTANCE.md`'s `openclaw_capture` (R11 of LLP 0171)

The current procedure (lines 173 onward) requires linking and enabling the
steering plugin from the checkout under test
(`openclaw plugins install --link ./openclaw-steering-plugin --force`), and
its "what it proves" language names "live proxy capture through the
steering plugin's shadow providers." Both go. The rewrite:

- **Setup** drops the steering-plugin link/enable steps entirely; adds
  `hyp attach --client openclaw` followed by the `openclaw gateway restart`
  instruction the command itself prints (1.2 step 5), replacing the manual
  `openclaw.json` edit the old procedure walked through by hand.
- **A sweep step**: run a turn on a provider whose live capture window has
  already closed (or with the daemon's Lane A capture briefly disabled),
  confirm the row is absent immediately after, then confirm it lands within
  one sweep interval (default five minutes) once the quiesce window (4.5)
  has passed. This is the step the old procedure had no equivalent for,
  because the old design had no separate sweep, only steering-or-not.
- **A zero-duplicate assertion**: run a turn where both lanes will observe
  it (live capture succeeds AND the session file records it), wait past one
  sweep interval, and assert exactly one row for that turn's `part_id`,
  proving section 6's dedupe claim on a real binary rather than only in
  code review.
- **Re-confirmation of LLP 0167#verify-results items 1, 3, and 4** (the
  `models.providers` shape, the no-self-heal-on-detach cache behavior, and
  the restart-required behavior) on an OpenClaw binary at or above the
  2026.4.24 floor the old procedure already required, since those verified
  facts were established against 2026.3.13 and R11 asks for re-confirmation
  at the floor version the acceptance run actually gates on.
- Drops the version-gate language specific to `before_model_resolve` and
  `hooks.allowConversationAccess` (2026.4.21/2026.4.23 features the steering
  plugin depended on): Lane A depends on no OpenClaw hook API at all, only
  on `models.providers` being a schema-valid config key, which LLP
  0167#verify-results confirms is stable back to 2026.3.13.
- Per R11, a human must still run this before the adapter ships; nothing in
  this design substitutes an automated check for that gate.

```
@ref LLP 0171#requirements [implements]: R11 (formerly R12 of LLP 0157,
"replaced" per 0171's carried-over note), the acceptance rewrite: attach-flow
steps, a sweep step, a zero-duplicate assertion, and re-confirmation of the
verified facts on the floor version.
```

### 8.2 Picker copy (R12 of LLP 0171, LLP 0167#onboarding)

`hypaware-core/plugins-workspace/openclaw/hypaware.plugin.json`'s
`picker[0].summary` drops "Routing is set up on the OpenClaw side by
installing the @hypaware/openclaw-steering-plugin package" and states the
two capture tiers directly: live capture through the local gateway (once
attached) plus periodic transcript sweep, no separate package to install.
Claude's own picker entry (`hypaware-core/plugins-workspace/claude/hypaware.plugin.json`)
gains the LLP 0167#onboarding line naming the `claude-cli/<model>` case
OpenClaw's own CLI-backend exclusion (R10, LLP 0147) produces explicitly, so
a user who runs Claude Code through OpenClaw understands which picker entry
their turns actually belong to.

## 9. Hermetic smoke gap {#smoke-gap}

No hermetic smoke currently writes an OpenClaw session file in any shape:
there is no `backfill_openclaw_fixture` analog to the Codex/Claude flows
under `hypaware-core/smoke/flows`. This is a real, pre-existing gap, flagged
during review of PR #552, and Lane B makes it more consequential: the sweep
path (4.4/4.5) has no hermetic-smoke coverage today, so a regression in
`listSessionFiles`'s new `quiesceBeforeMs` filter, or in the sweep driver's
`cronMatches` wiring, would only surface in the manual acceptance run (8.1),
not in PR-level smoke confidence. This design does not build that fixture
(out of scope for a design document), but names the gap for the
Impl-designer rung: a `backfill_openclaw_fixture` helper, writing a
minimal OpenClaw v3 session JSONL (nested `message` envelope, matching PR
#552's fixed reader) under a temp `agents/<id>/sessions/` tree with a
controllable mtime, would let a hermetic smoke exercise the quiesce filter
and the sweep-then-dedupe path deterministically, the same tier distinction
`/work/hypaware/CLAUDE.md`'s Smoke Test Model section draws between
hermetic smokes (PR confidence) and the acceptance smoke (release gate,
8.1). Whether to build it in this change set or a follow-on is a scoping
call for the plan, not this design; the design only establishes that Lane
B's correctness currently rests entirely on 8.1's human-run procedure.

## 10. Open questions left for a human {#open-questions}

None of the decisions in this design required inventing an answer where the
cited RFC/decisions were silent; every fork identified during research
(the attach-probe/status interaction, the scheduling seam, the ownership-
check base URL source, the backup-vs-refuse asymmetry) resolved to an
existing mechanism or a directly-cited decision. Two items are worth a
human's attention regardless, both already flagged in the requirements
rather than newly discovered here:

- **R11's acceptance rewrite (section 8.1) requires a human run before the
  adapter ships.** This design specifies what that run must cover; it does
  not and cannot perform the run itself.
- **The hermetic smoke gap (section 9)** is a real coverage hole this
  design chooses not to close, on the grounds that building a new smoke
  fixture is implementation work for a later rung, not a design decision.
  If a human reviewing this design set disagrees with deferring it, that is
  the one scoping judgment call in this document worth reconsidering before
  planning starts.

## References

- LLP 0167, LLP 0171, LLP 0168, LLP 0169, LLP 0170
- LLP 0157 (carried-over R8/R9/R10/R11/R14), LLP 0158, LLP 0159, LLP 0161
  (prior technical design; steering-plugin sections retired here, projector/
  settlement/backfill sections remain the record of what shipped)
- LLP 0163 (malformed-block backup precedent), LLP 0143 (superseded;
  json_path retirement, reversed here), LLP 0144 (shadow-provider-per-shape
  rationale, carried over as Lane A's rationale)
- LLP 0044, LLP 0045 (attach/detach design)
- `docs/ACCEPTANCE.md`, issue #543 (PR #552), issue #544 (PR #553)
