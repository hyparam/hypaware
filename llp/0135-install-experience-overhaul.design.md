# LLP 0135: Install-experience overhaul - technical design

**Type:** design
**Status:** Active
**Systems:** Onboarding, CLI, Config, Plugins
**Generated-by:** neutral
**Related:** LLP 0128, LLP 0129, LLP 0130, LLP 0131, LLP 0132, LLP 0133, LLP 0134, LLP 0005, LLP 0011, LLP 0025, LLP 0031, LLP 0037, LLP 0044, LLP 0058, LLP 0062, LLP 0063, LLP 0070, LLP 0100, LLP 0101, LLP 0114, LLP 0115, LLP 0116, LLP 0117, LLP 0120

> Buildable design for the six-phase `hyp init` wizard (Fork -> Join -> Pick ->
> Configure -> Privacy -> Finale), the plugin-contributed picker descriptor
> mechanism, and the source-scoped export withholding the managed-local-additions
> rule requires.
> @ref LLP 0128: realizes the RFC's fork/join/pick/configure/privacy/finale wizard shape as concrete modules and seams.
> @ref LLP 0129#fork [implements]: `runWizardFork` and the returning-gate split below.
> @ref LLP 0129#join-before-picker [implements]: `runWizardJoin`'s bounded org-config wait before the picker composes.
> @ref LLP 0129#failed-join-returns-to-fork [implements]: the join/fork loop in `runInitWizard`.
> @ref LLP 0129#returning-gate [implements]: the managed-vs-solo re-entry split.
> @ref LLP 0130#picker-block [implements]: `contributes.picker`, `buildPluginCatalog` picker descriptors, `detectPickerSources`.
> @ref LLP 0130#configure-command [implements]: in-process `configure_command` dispatch via `ctx.commands`.
> @ref LLP 0131#drop-on-failure [implements]: `runConfigurePhase`'s per-entry try/drop loop.
> @ref LLP 0131#idempotent-rerun [constrained-by]: configure commands own their own resume; the wizard does no step bookkeeping.
> @ref LLP 0131#attended-only [constrained-by]: `runConfigurePhase` never runs off `opts.picks` (non-interactive) paths.
> @ref LLP 0132#rule [implements]: the client-provenance helper and export-seam withholding below.
> @ref LLP 0132#source-scoped-withholding [implements]: `sourceWithholdResolver` extension to `readRowsSince`.
> @ref LLP 0132#never-silent [implements]: picker "stays on this machine" annotation and `hyp status` split line.
> @ref LLP 0133#one-surface [implements]: `hyp claude-desktop install` as the shared solo/fleet placement command.
> @ref LLP 0134#login-lane [implements]: `runWizardJoin` wraps `runRemoteLogin` rather than reimplementing enrollment.
> @ref LLP 0134#no-token-join [constrained-by]: the wizard never accepts a token; `hyp join` stays untouched.

## Module map

```
src/core/cli/wizard/
  index.js               // runInitWizard(opts): fork -> join -> pick -> configure -> finale -> first look -> privacy
  first_look.js           // runWizardFirstLook(opts): when the closing overview runs, and that it never fails setup
  fork.js                 // runWizardFork(opts), the returning-gate split (scoped vs full re-entry)
  join.js                  // runWizardJoin(opts): wraps runRemoteLogin, bounded org-config wait, locked-row set
  pick.js                   // runWizardPick(opts): the picker prompt + composePickerConfig (descriptor-driven, was walkthrough.js)
  configure.js               // runConfigurePhase(picked, ctx): needs_setup loop, drop-on-failure, --print-commands passthrough
  provenance.js               // classifyClientProvenance(name, layered): shared by pick.js, status.js, and the export seam
src/core/query/overview.js    // the shared block: probe, chooseOverviewWindow, buildOverviewSql, collectOverview, renderOverview
src/core/commands/query.js    // `hyp query overview [--json] [--sql] [--days <n>]`: the same block on demand
src/core/cli/detect.js        // detectPickerSources(catalog, env): replaces the hardcoded DETECTABLE_CLIENT_SOURCES table
src/core/plugin_catalog.js    // buildPluginCatalog gains pickerDescriptors alongside clientDescriptors
src/core/cache/storage.js     // readRowsSince gains an optional sourceWithholdResolver alongside usagePolicyResolver
src/core/daemon/status.js     // "syncing: X - local-only: Y" split line, reusing provenance.js
hypaware-plugin-kernel-types.d.ts // PluginManifest.contributes.picker; CommandRunContext.commands (invoke-by-name seam)
hypaware-core/plugins-workspace/claude-desktop/
  hypaware.plugin.json       // contributes.client + contributes.picker (needs_setup, configure_command)
  src/index.js                // activate(): registers "claude-desktop install", the client descriptor, backfill n/a
  src/install.js                // login chain, helper write, residue backup/clear, plist write (sudo), restart prompt
  src/verify.js                   // two-tier verify: automatic residue/plist check + post-wizard in-app hint
```

`src/core/commands/init.js`'s `runInit` changes its one call site from
`runPickerWalkthrough(...)` to `runInitWizard(...)`; the picker-only behavior
(`--yes`, `--dry-run`, presets, `--from-file`) becomes `runWizardPick` invoked
directly by `runInitWizard` with the fork/join/configure/privacy phases
short-circuited, preserving every existing non-interactive test's shape.

## Manifest extension: `contributes.picker` {#manifest}

Lands the shape [LLP 0130](./0130-declarative-picker-descriptors.decision.md)
specifies, as an addition to `hypaware-plugin-kernel-types.d.ts`'s
`PluginContributions`, sibling to the existing `client` field (LLP 0005):

```js
/**
 * @import { PluginPickerContribution } from '../../hypaware-plugin-kernel-types.js'
 */
```

```ts
interface PluginPickerContribution {
  name: string
  label: string
  summary: string
  detect?: PickerDetectProbe
  needs_setup?: boolean
  configure_command?: string
}

type PickerDetectProbe =
  | { settings_file: string }   // reuses contributes.client.attach_probe shape
  | { app_bundle: string }       // new: stat-exists check on a .app path (macOS)
  | { path: string }              // new: stat-exists check on a directory (mirrors today's dir-exists rule)
```

`name` is the picker source id (e.g. `claude`, `codex`, `claude-desktop`,
`hermes`, `raw-anthropic`). It is required on every row, not on the plugin
manifest as a whole, because `contributes.picker` is array-shaped precisely so
one plugin can contribute more than one row (`@hypaware/ai-gateway` needs both
`raw-anthropic` and `raw-openai`); the plugin manifest's own top-level `name`
can't disambiguate between them. This mirrors every other array-shaped
`contributes.*` entry (`skills`, `commands`, `agents`, `datasets`,
`init_presets`), which all key off a per-row `name: string`.

`buildPluginCatalog` (`src/core/plugin_catalog.js`) reads `contributes.picker`
the same pass it already reads `contributes.client` (lines 61-77 today), first-
manifest-wins, into a new `pickerDescriptors: Map<string, PickerDescriptor>`
keyed by each row's `name`. `PICKER_SOURCES`
(`src/core/cli/walkthrough.js:308`) is deleted; its five entries become
`contributes.picker` blocks on `@hypaware/claude`, `@hypaware/codex`,
`@hypaware/ai-gateway` (for `raw-anthropic` / `raw-openai`, two descriptors from
one plugin's manifest since a manifest's `contributes.picker` is declared per
picker row, not per plugin: the field becomes an array,
`contributes.picker: PluginPickerContribution[]`, to let one plugin contribute
more than one row) and `@hypaware/otel`. `claude-desktop` and `hermes` get
descriptors for the first time, with `needs_setup: true` only on
`claude-desktop`.

## Detection {#detection}

`detectClientSources` becomes `detectPickerSources(catalog, env)`
(`src/core/cli/detect.js`), iterating `catalog.pickerDescriptors` instead of
the hardcoded `DETECTABLE_CLIENT_SOURCES` table, the exact migration the
file's own header comment anticipated ("If the picker is ever made
plugin-driven, move detection to iterate the client descriptors..."). Probe
dispatch is a small switch on the `PickerDetectProbe` variant:

- `settings_file` reuses the existing `resolveClientSettingsPath` + parent-dir-
  exists check (unchanged behavior for `claude`/`codex`).
- `app_bundle` stats the literal path (`/Applications/Claude.app`).
- `path` stats the literal path, honoring the same `$FOO_HOME`-style env
  override resolution `resolveClientSettingsPath` already does for the two
  existing sources: `hermes`'s `~/.hermes/` becomes a `path` probe rather
  than a bespoke check.

Still best-effort (a probe failure is "not present," never an error), still
seeds only the initial checkbox state
(`@ref LLP 0011#autodetect-vs-default [constrained-by]`, unchanged).

## Client/source provenance helper {#provenance}

A new `classifyClientProvenance(clientName, layered)` in `src/core/cli/wizard/
provenance.js` generalizes the central-vs-local check `dispatch.js`'s
`classifyInactiveState` already does for a single disabled-plugin case
(`src/core/cli/dispatch.js:788`), returning `'central' | 'local' | 'absent'`
for a picker source id by resolving it to its owning plugin (via
`pickerDescriptors`/`clientDescriptors`) and checking membership in
`layered.centralConfig.plugins` vs `layered.effective.plugins`. Three call
sites share it:

1. **Pick phase row locking** (`@ref LLP 0129#join-before-picker`): a `'central'`
   row renders checked and disabled with the `[central · locked]`
   provenance label ([LLP 0031](./0031-layered-config.decision.md#status-provenance)).
2. **`hyp status`**: the new split line groups picked clients by
   provenance: `syncing: claude · codex` (central or unenrolled-solo) and
   `local-only: hermes` (local on a machine with a central layer), never a
   silent state (`@ref LLP 0132#never-silent`).
3. **Export-seam withholding** (below): the set of `'local'`-classified
   client names on an enrolled machine is exactly the withhold set.

## Wizard orchestration {#orchestration}

`runInitWizard(opts)` (`src/core/cli/wizard/index.js`) replaces
`runPickerWalkthrough` as `runInit`'s entry point for the interactive case
(`opts.picks` absent). Non-interactive callers (`--yes`, `--dry-run`, presets,
`--from-file`) skip straight to `runWizardPick`, matching today's `interactive
= !opts.picks` split in `walkthrough.js:394` (`@ref LLP 0131#attended-only`).

```js
export async function runInitWizard(opts) {
  const gate = await evaluateReturningGate(opts)  // LLP 0011 gate, amended below
  if (gate.action === 'quit') return quitResult(opts)
  if (gate.action === 'status') return delegateToStatus(opts)

  let pathway = gate.action === 'scoped-reconfigure' ? 'scoped' : undefined
  let locked

  while (true) {
    if (!pathway) pathway = await runWizardFork(opts)      // @ref LLP 0129#fork
    if (pathway === 'quit') return cancelledResult(opts)

    if (pathway === 'team') {
      const join = await runWizardJoin(opts)               // @ref LLP 0134#login-lane
      if (join.status === 'failed' || join.status === 'abandoned') {
        printJoinFailure(opts, join)                        // @ref LLP 0129#failed-join-returns-to-fork
        pathway = undefined
        continue
      }
      locked = join.lockedSources                           // may be empty on timeout/404
    }
    break
  }

  const picked = await runWizardPick({ ...opts, locked, scoped: pathway === 'scoped' })
  if (picked.cancelled) return picked

  const configured = await runConfigurePhase(picked, opts)  // @ref LLP 0131
  const finale = await runWizardFinale({ picked, configured, joinedAlready: pathway === 'team', opts })
  await runWizardFirstLook(opts)                             // @ref LLP 0135#first-look, attended runs only
  await narratePrivacyIfTeamPath(opts, pathway)              // @ref LLP 0134#login-lane, unchanged mechanism
  return finale
}
```

As shipped, the privacy narration runs *after* the finale rather than
before it: the setup's last words state when the first upload happens and
that nothing has left the machine yet (the LLP 0128 experience goal), so
they must not scroll away under the finale's install/attach/backfill
output. The pick phase also renders every non-locked row with a
`· stays on this machine` suffix when the machine carries a central layer
(`@ref LLP 0132#never-silent`), threaded as a `managed` input computed by
the join phase (on convergence) or the returning gate (scoped re-entry).

`evaluateReturningGate` reads `hyp status`'s existing summary and central-
layer check; on a `'scoped-reconfigure'` machine (managed, per
`@ref LLP 0129#returning-gate`) the fork step is skipped entirely: `pathway`
is preset to `'scoped'`, `runWizardPick` renders org rows locked (via
`classifyClientProvenance`) and additions editable, and the finale runs
`configure` only for newly picked `needs_setup` entries, never re-running the
join lane. A solo machine's `Reconfigure` choice preset nothing: it re-enters
the loop at the fork exactly as first run does.

## Join phase {#join}

`runWizardJoin(opts)` (`src/core/cli/wizard/join.js`) is a thin narration
wrapper, not a second enrollment mechanism (`@ref LLP 0134#login-lane`):

```js
export async function runWizardJoin(opts) {
  opts.stdout.write('Joining your team...\n')
  const login = await runRemoteLogin([], loginCtxFrom(opts), {})  // existing hyp remote login machinery
  if (login.exitCode !== 0) return { status: classifyLoginFailure(login) }

  opts.stdout.write("Applying your org's configuration...\n")
  const converge = await waitForCentralConverge(opts, { timeoutMs: ORG_CONFIG_WAIT_MS })
  if (!converge.ok) {
    opts.stdout.write("Didn't hear back from your org's config in time; continuing with an unlocked picker.\n")
    return { status: 'ok', lockedSources: [] }
  }
  const layered = await resolveLayeredConfigFromDisk(opts)
  const lockedSources = [...opts.catalog.pickerDescriptors.keys()]
    .filter((id) => classifyClientProvenance(id, layered) === 'central')
  return { status: 'ok', lockedSources }
}
```

`waitForCentralConverge` reuses the bounded reconcile-wait
`runRemoteLogin` already performs internally
(`@ref LLP 0129#join-before-picker [implements]`) rather than adding a second
poll loop; it is exposed as a small exported helper from `remote_commands.js`
instead of re-implemented. `classifyLoginFailure` maps the login lane's
existing error taxonomy (`no_membership` / `org_not_permitted` per
[LLP 0058 D7](./0058-oidc-login-client.decision.md#d7), vs a
transient network error) to `'failed' | 'abandoned'` for
`runInitWizard`'s retry-or-local-or-quit prompt
(`@ref LLP 0129#failed-join-returns-to-fork`).

## Pick phase {#pick}

`runWizardPick` keeps `walkthrough.js`'s existing shape (prompt, write, guard,
overwrite confirm) but two things change:

1. **Options come from `catalog.pickerDescriptors`**, not `PICKER_SOURCES`.
   Each option's `checked` state is `detected.has(id) || locked.includes(id)`;
   a `locked` id renders `disabled: true` with the label suffixed
   `· managed by your fleet` (LLP 0031 provenance vocabulary). Locked ids are
   filtered out of the returned `sources` before composition: they are
   already in the central layer, so composing them again into the local
   layer would be the exact collision `@ref LLP 0129#join-before-picker`
   exists to avoid.
2. **`composePickerConfig` becomes descriptor-driven.** Today's switch
   statement (`wantsAnthropic`, `wantsCodex`, ... `walkthrough.js:654-729`)
   is replaced by folding over each picked descriptor's own composition
   contribution. Since composition rules (which upstream, which adapter
   plugin, gateway vs no-gateway) are genuinely per-plugin knowledge, the
   `picker` block gains one more optional field, `compose`, carrying the
   same shape as today's hardcoded rules do in data form:

   ```json
   "picker": {
     "label": "capture Claude Code conversations",
     "compose": {
       "plugin": { "name": "@hypaware/claude", "config": { "proxy": "@hypaware/ai-gateway" } },
       "requires_gateway": true,
       "gateway_upstream": { "name": "anthropic", "base_url": "https://api.anthropic.com", "path_prefix": "/v1/messages", "provider": "anthropic" }
     }
   }
   ```

   As shipped, `compose.plugin` is a full plugin instance (`{ name, config }`),
   not just a name, so a row carries its adapter's config (e.g. the gateway
   `proxy`) with it, and `gateway_upstream` accepts either a single upstream
   or an array (the Codex row contributes both its `openai` and `chatgpt`
   upstreams). A gateway-independent plugin (`@hypaware/otel`) is placed
   before the export sink plugins and a gateway-requiring one after, matching
   the retired switch's plugin order.

   `composePickerConfig` becomes a fold: union the requested gateway
   upstreams (deduped by `name`), include each picked descriptor's `plugin`,
   include `@hypaware/ai-gateway` iff any picked descriptor sets
   `requires_gateway`. This is the same output shape `walkthrough.js` writes
   today (verified by the existing `composePickerConfig` tests), just sourced
   from manifest data instead of a hardcoded switch, core keeps owning
   *composition*, exactly as [LLP 0130](./0130-declarative-picker-descriptors.decision.md#consequences)
   specifies. Export composition (`PICKER_EXPORTS`, `local-parquet` /
   `keep-local` / `configure-later`) is untouched: it is not plugin-picker
   territory, it is the sink-choice half already outside `PICKER_SOURCES`.

## Configure phase {#configure}

`runConfigurePhase(picked, opts)` (`src/core/cli/wizard/configure.js`) loops
picked descriptors with `needs_setup: true` and a `configure_command`, running
each one at a time with narration and the drop-on-failure rule
(`@ref LLP 0131#drop-on-failure`):

```js
export async function runConfigurePhase(picked, opts) {
  const results = []
  for (const d of picked.descriptors.filter((d) => d.needsSetup)) {
    opts.stdout.write(`\nSetting up ${d.label}...\n`)
    try {
      const exitCode = await opts.ctx.commands.run(d.configureCommand, printCommandsFlag(opts))
      results.push({ id: d.id, ok: exitCode === 0 })
      if (exitCode !== 0) printCatchUpHint(opts, d)
    } catch (err) {
      results.push({ id: d.id, ok: false, error: String(err) })
      printCatchUpHint(opts, d)
    }
  }
  return { results }
}
```

**In-process command dispatch.** `CommandRunContext` today (`hypaware-plugin-
kernel-types.d.ts:654`) exposes kernel-owned registries for skills, agents,
sources, sinks, backfills, but no way to invoke another registered *command*
by name. `dispatch.js` has exactly this internally
(`runCommandByName`, `dispatch.js:400`, used for the config-repair
redirect) but it is module-private and takes the raw `registry`/`kernel`
dispatch built internally, not the public `CommandRunContext` a command
implementation receives. This design adds one small, scoped seam rather than
exposing the full mutable registry to command code: `ctx.commands: { run(name:
string, argv: string[]): Promise<number> }`, populated by the dispatcher the
same way `ctx.skills`/`ctx.agents`/`ctx.backfills` already are, implemented as
a thin wrapper over the existing `runCommandByName`. `init` already boots with
`decideBootProfile(argv) === 'all-available'` (`dispatch.js:474`), so by the
time the wizard's configure phase runs, `claude-desktop install` (and any
other `needs_setup` plugin's command) is already registered, no additional
boot-profile change needed.

**`--print-commands`** threads through to the invoked command's own argv
(`printCommandsFlag`), so the standalone command's existing flag handles the
no-sudo escape hatch; the wizard adds no separate implementation
(`@ref LLP 0131#idempotent-rerun`).

## `hyp claude-desktop install` {#claude-desktop}

New bundled plugin `@hypaware/claude-desktop`
(`hypaware-core/plugins-workspace/claude-desktop/`), mirroring the hermes
plugin's shape ([LLP 0122](./0122-hermes-log-forwarding.design.md)) for
manifest/activation structure, contributing:

- `contributes.client`: `name: "claude-desktop"`, `skill_dir`/`agent_dir` per
  the existing client-descriptor contract, and an `attach_probe` reflecting
  the `entrypoint: "claude-desktop-3p"` attribution finding
  (`@ref LLP 0133#attribution [constrained-by]`: rows land `client_name:
  "claude"` with `entrypoint: "claude-desktop-3p"`, so `hyp status`/query
  surfaces query by `entrypoint`, not by a new `client_name`).
- `contributes.picker`: `label: "Claude Desktop"`, `detect: { app_bundle:
  "/Applications/Claude.app" }`, `needs_setup: true`, `configure_command:
  "claude-desktop install"`.
- `contributes.commands`: `claude-desktop install` (the same command both the
  wizard's configure phase and a standalone `hyp claude-desktop install`
  invoke) and `claude-desktop verify` for the post-wizard in-app hint.

`src/install.js`'s `run(argv, ctx)` implements, in order
(`@ref LLP 0133#one-surface`, `@ref LLP 0133#0115-corrections`):

1. Credential login chain ([LLP 0117](./0117-claude-account-credential-plugin.decision.md)).
2. Helper write ([LLP 0116](./0116-desktop-credential-client-presented.decision.md)).
3. **Residue check**: detect a pre-existing `Claude-3p` profile-directory
   config (`@ref LLP 0133#dialog-residue`), back it up, clear it. Runs on
   every install, solo and fleet, unconditionally: a silent shadowed plist
   is a per-machine no-op at fleet scale.
4. Plist write to `/Library/Managed Preferences/
   com.anthropic.claudefordesktop.plist` (`@ref LLP 0133#plist-surface`),
   via an inline `sudo` prompt on the solo path (`@ref LLP 0133#solo-sudo`);
   the fleet path replaces only this step with an MDM push, steps 1-3 and 5
   identical.
5. Desktop restart prompt (`killall cfprefsd` + relaunch hint).
6. Two-tier verify: the automatic half (plist present, residue cleared)
   returns in `exitCode`; the in-app half (send a message, confirm capture)
   is `claude-desktop verify`'s printed hint, never a blocking wizard step
   (`@ref LLP 0131#verify-is-a-hint`).

Every step re-checks its own already-done state first (residue already
cleared, plist already correct, helper already written), so re-running after
a bailed sudo prompt converges without re-prompting completed steps
(`@ref LLP 0131#idempotent-rerun`). A fleet config pinning an ephemeral
gateway listen (`127.0.0.1:0`) is refused before step 4 runs, unchanged
(`@ref LLP 0133#consequences`, [LLP 0114](./0114-gateway-default-listen-port-fixed.decision.md)).

## Export-seam source-scoped withholding {#export-seam}

Extends `readRowsSince` (`src/core/cache/storage.js:243`), which already
enforces `cwd`-derived `local-only` withholding via `usagePolicyResolver`
(`@ref LLP 0070#enforce`). A second, optional resolver is threaded the same
way:

```js
async *readRowsSince(tablePath, opts = {}) {
  // ...existing cwd-based filter...
  if (sourceWithholdResolver && sourceWithholdResolver.shouldWithhold(row)) {
    droppedRowCount += 1
    yield { after, dropped: true }
    continue
  }
  // ...
}
```

`sourceWithholdResolver` is built once at boot (alongside
`usagePolicyResolver`) from `classifyClientProvenance`
(`@ref LLP 0132#source-scoped-withholding`): the set of picker source ids
classified `'local'` on a machine with a central layer. Per-row matching needs
an **attribution column**, and that column is dataset-specific: for
`ai_gateway_messages` (where claude/codex/hermes rows all land, per
[LLP 0120](./0120-hermes-rows-are-ai-gateway-messages.decision.md)) it is
`client_name`, exactly the column `@ref LLP 0133#attribution` establishes is
authoritative for Desktop attribution too. Table ownership alone cannot carry
this (one shared table, several contributing sources), so this design adds a
small, additive manifest field on `contributes.datasets[]`,
`attribution_column`, declared once by the dataset's owning plugin
(`@hypaware/ai-gateway` declares `attribution_column: "client_name"` for
`ai_gateway_messages`). A dataset with no declared `attribution_column` is
simply never subject to source-scoped withholding, a conservative default
matching `local-only`'s original design (verdict derived from data already on
the row, never a capture-time marker). Withholding is drop-but-advance, the
same continuation semantics `@ref LLP 0070#incremental` already established
for the `cwd` filter, so a withheld row still moves the sink watermark past
it.

## Privacy narration {#privacy}

Unchanged mechanism ([LLP 0100](./0100-enrollment-privacy-review.spec.md),
[LLP 0101](./0101-first-sync-review-window.decision.md)): `narratePrivacyIfTeamPath`
prints the first-sync hold deadline and the `hypaware-privacy` skill hint
as the wizard's closing words (after the finale), on the team pathway only,
stating explicitly that nothing has been uploaded yet. No prompt, no picker:
`@ref LLP 0134#login-lane [constrained-by]`: the review window rides the
login lane exactly as before; the wizard only narrates it.

## Finale {#finale}

`runWizardFinale` is `runPickerFinale` (`walkthrough.js:757`) with one new
input, `joinedAlready`: when true (team pathway), the daemon-install and
attach steps are skipped if `hyp status` already reports them done from the
join lane, rather than re-running (`@ref LLP 0134#login-lane`, "the finale
detects and skips what enrollment already did"). Only the *install* is
skipped (a `skipDaemonInstall` finale flag distinct from `skipDaemon`): the
daemon restart still runs, because the pick phase just wrote a new local
layer the running daemon must pick up. Skills/agents install is
untouched: it already iterates `clientsPicked` against
`buildWalkthroughClientDescriptorMap()` (`walkthrough.js:873-923`), which is
generic over any client descriptor including the new `claude-desktop` one, so
Desktop's skills/agents installation ("the finale" thread from issue #302)
requires no new code beyond `claude-desktop`'s manifest declaring
`skills`/`agents` contributions the same way `@hypaware/claude` and
`@hypaware/codex` already do. Backfill consent stays solo-path-only
(per [LLP 0128 Design sketch](./0128-install-experience-overhaul.rfc.md#design-sketch), unchanged): an enrolled machine backfills
under [LLP 0037](./0037-backfill-on-join.decision.md) default-on doctrine.

## First look {#first-look}

Setup used to end on a hint: `next: hyp query sql 'select count(*) from
logs'`. That command fails on most installs, because `logs` only exists
when `@hypaware/otel` is configured, and it asks the user to do the work of
finding out whether anything was captured. The hint is removed;
`writeWalkthroughRunSummary` now prints only what the finale did.

In its place, the shared overview (`src/core/query/overview.js`) runs fixed
read-only queries over `ai_gateway_messages` and renders them as aligned
tables with proportional bars, in four sections: **models** (input/cached/
output tokens per provider and model), **daily** (the same three per day
alongside a session count), **repos** (which checkouts the sessions ran
in), and **tools** (which tools the models call).

Both callers render all four. The first cut gave the wizard only
`['models', 'daily']` on the theory that a ~60-line block (against ~35)
would bury the closing privacy narration; that was over-cautious, since the
narration is written *after* the block and stays the last thing on screen
either way (#privacy). `collectOverview` still takes a section list and runs
only those queries, so the seam for a shorter variant remains if setup
output ever needs trimming. Two shapes the data forced:

- **A ranked table sorts by exactly what its bar charts.** The models table
  originally ordered by `output_tokens` while the bar charted
  `input + output`, so a prompt-heavy row (`gpt-5.5`: 2.3M input, 172k
  output) drew a longer bar than the row above it. Both ranked token tables
  now `order by input_tokens + output_tokens desc`, and tools orders by
  `calls`, the metric it bars. Daily is the deliberate exception: it is
  chronological, so its bars are a time series rather than a rank and are
  expected to rise and fall. A test pins each table's sort key against its
  bar metric.
- **Repos group by repo alone, not repo + branch.** `git_branch` is set on
  15 of 431 sessions on the authoring machine (~3%), so a branch column
  would be almost entirely blank - and grouping by it splits one repo
  across a null-branch row and a named one, showing the same checkout
  twice as if it were two places.
- **Tools filter `part_type = 'tool_call'`.** The projector normalizes
  every provider's call shape onto one vocabulary (`text` / `reasoning` /
  `tool_call` / `tool_result` / `image` / `fallback`), so a provider's own
  wire name (`tool_use`) matches nothing and yields a silently empty
  section.

Sessions with no repo are folded into a count line rather than dropped or
drawn as a nameless row: they are 177 of 431 here, so hiding them would
misstate the split. The line reads "no repo recorded", **not** "outside a
repo", because the column cannot distinguish those and one of them would
be a false claim: `repo_root` is populated on 27,342 Claude rows and on
**zero** Codex rows, even though Codex rows do carry `cwd` (1,248) and
sometimes `git_branch` (464). Every Codex session therefore lands in that
count regardless of where it actually ran. The projector asymmetry is a
`@hypaware/codex` gap worth closing on its own; until it is, the overview
must not narrate absence of a field as absence of a repo. The block is the wizard's proof
of life: the run ends on the user's own numbers.

**Tokens, not rows.** A row is one *part* of a message
(`part_id = <message_id>#<part_index>`, [LLP 0026](./0026-claude-native-granularity.decision.md)), so a `count(*)`
headline names a unit nobody outside the schema recognizes, and inflates
wherever a model answers in several content blocks. Tokens are the unit
users already think in, and they sum honestly:
[LLP 0035 #one-carrier](./0035-token-usage-normalization.decision.md#one-carrier) puts response-level usage on exactly one row,
so a plain `SUM` needs no dedup and no `role` filter (non-carrier rows are
null) - which also keeps `sessions` counting every session, not only those
with an assistant reply.

**Bars chart input + output, split by shade, and cache is excluded.** On
real data cached is 99.0-99.9% of every day's total, so a total-token bar
is a cache-read chart: one long conversation re-reading a large prompt
outranks a day with 37 sessions, and every other bar flattens against it.
The bar therefore compares
`input + output` - the tokens that were actually new - and splits them by
shade (`▒` input, `█` output) so the mix is readable at a glance. The split
is encoded twice, shade *and* colour, so it survives a monochrome
terminal, a pipe, and colour-blind readers; a component that exists is
never rounded away to nothing.

Each table captions its own bar (`by input+output`, `by sessions`,
`by calls`) because the sections legitimately chart different things, and
an unlabelled bar two columns from what it measures gets read as the
column beside it - which is exactly how the daily bars were first taken
for session counts. In the token tables the caption's words carry their own
shades' colours, so the header *is* the key and no legend lookup is needed.

That forces one rendering rule: header cells are painted individually
rather than as one dim run, because a colour sequence inside a dim run ends
it early and leaves the remainder of the row undimmed. A test asserts no
colour start ever follows a dim start without an intervening reset.

**Cache is excluded from the bar but never from the columns.** An earlier
draft of this section justified the exclusion by calling cache "the
cheapest token there is" - true per token (reads price at 0.1x input), and
wrong as a claim about significance. Measured against this repo's own
history with the published multipliers (read 0.1x, write 1.25x, output
5x), the split is **cache read 55.8% of cost, output 22.0%, cache write
20.7%, fresh input 1.5%** - cached is **76.5% of spend** off 98.9% of
tokens. Cache writes especially: 2.9% of tokens, a fifth of the cost, at
12.5x a read's price.

So the exclusion is a *charting* decision, not a significance one. A
cache-dominated bar stops discriminating (every row saturates) and tracks
context size x turn count rather than work done. Every token table carries
input, cached and output as columns - including the repos table, which
would otherwise report ~1.5% of what a repo actually costs.

**Three columns: input, cached, output.** Input is stored net of cache
([#net-input](./0035-token-usage-normalization.decision.md#net-input)), so each column sums exactly the field it is named
after and `input + cached` is the whole prompt, with nothing
double-counted. Folding cache into input would hide where the volume
actually goes - on this repo's own history, cached runs ~500x net input -
and would leave the "input" header meaning something narrower elsewhere in
the schema. `cached` covers reads and writes together; the read/write
split is a cost question for the usage-report skills, not a first look.

Each cache term carries its own `coalesce`, which is load-bearing rather
than defensive: `cache_write_tokens` is Claude-only, so an unguarded
`cache_read_tokens + cache_write_tokens` evaluates to null on every OpenAI
row and silently drops that provider's cache reads from the sum (25.5M ->
0 on the authoring machine). A test pins it.

**Zero-token rows: two kinds, two treatments.** A `0  0  0` line reads
like a bug, so the table shows only measured rows - but whether their
absence deserves a word depends on what they are.

A group with no model label is not a model: it is the rows no model
answered (prompts, tool results), which cannot carry usage, because a
response's tokens are stamped on the response ([#one-carrier](./0035-token-usage-normalization.decision.md#one-carrier)) and the
prompt's cost is therefore already inside the answering model's `input`
and `cached`. These are omitted silently - nothing is missing to report.
The first cut got this wrong and counted them, so 14.5k of the reader's
own prompts were announced as "+ 2 models whose traffic was recorded
without token counts": correct arithmetic under a sentence that described
the reader's messages as something they are not.

A *labelled* model with zero tokens is the other kind: a real model whose
provider reported no usage. That is a genuine gap in what was recorded, so
it is still counted out loud. And an unlabelled group that ever does carry
tokens renders as `(model not recorded)` rather than being filtered, so
the omission rule can never silently drop a measured token.

The SQL sits behind `--sql`, not inline: the token statements are four
lines of `json_extract`/`cast` each, and printing both above the tables
would bury the numbers. A one-line footer names the flag, so the queries
stay one keystroke away - they are exactly the incantation a user cannot
guess. Printed with newlines preserved inside `hyp query sql "..."`, which
a shell pastes back verbatim.

**One block, two callers.** `runWizardFirstLook` (`wizard/first_look.js`)
owns only the wizard's half of the contract (when the step runs, and that
it never fails a finished install); `hyp query overview`
(`commands/query.js`, plus `--json` for scripting and `--sql` for the
statements) prints the same block on demand, and the wizard's closing line
names it. A view a user sees once
during setup and can never summon again is a worse deal than a command
they learn - so the render, the SQL, and the empty state live in one
module rather than being reproduced per surface. The two callers differ
only in heading, and in what an unregistered dataset means: the wizard
skips silently (nothing was picked that records gateway traffic), while
the command exits 1 with the fix on stderr (the user asked for AI traffic
and there is no source recording it).

Constraints that make it safe to run automatically:

- **Attended and non-dry-run only.** `--yes`, presets and `--from-file`
  produce no extra output (scripted callers keep a clean stdout), and a
  dry run has no writes to look at.
- **After the finale, before the privacy narration.** Backfill has already
  landed by then, so a first install with imported history shows real rows;
  and the privacy narration stays the wizard's last words (#privacy).
- **Never a gate.** In the wizard, no dataset (no gateway source picked)
  skips silently and a failure is recorded on the span and skipped. Setup
  already succeeded by the time this runs, so nothing here may fail it -
  and the guarantee is structural, not merely behavioral: `runInitWizard`
  **discards the step's result**, so it cannot reach the exit code, and the
  step's `try` wraps the *whole* body rather than just the queries. An
  earlier version caught only `collectOverview`, leaving rendering and
  `stdout.write` outside it - an unforeseen row shape, or an `EPIPE` from a
  closed pipe (`hyp init | head`), would have surfaced as `hyp: <error>`
  and a non-zero exit from an install that had already fully succeeded.
  Two tests pin it, one throwing from the writer and one from a row.
- **Never a hang, and never a blank.** The section queries are full
  aggregations whose cost is the cache's size (~3s over 48k rows / 158MB,
  and the step runs right after a backfill that may have imported months
  into a much bigger one). Rather than run them and hope, the block plans
  its own scope, described below.
- **No new visibility surface.** The runner routes through the `query sql`
  verb operation with the caller's cwd, so the LLP 0105 filter applies
  exactly as it would to the user typing the query
  (`@ref LLP 0105 [constrained-by]`).

Zero rows is a first-class state, not a blank: it names what has to happen
(start a session in an attached client) and repeats the command to run
afterwards.

### The window is planned, and always stated {#window}

A block whose cost grows without bound has two bad failure modes: it hangs
on a big cache, or it silently disappears. Instead the block **chooses a
period it can afford, and says which period that is.**

`collectOverview` first runs a deliberately narrow probe -
`select date, count(*) from ai_gateway_messages group by 1`, one column and
no JSON extraction, ~0.27s against the ~0.50s of a single token section.
Partitions are keyed by `source`, not `date`, so per-day counts cannot come
from Iceberg metadata; asking the data is the cheap option. From that
histogram `chooseOverviewWindow` walks days newest-first and takes the
widest span that satisfies **two** caps. Every section then carries the
same `date >= since` bound, so the block is one claim about one period
rather than four differently scoped ones.

**Time, measured rather than assumed.** The probe just read every row, so
how long *it* took is a fresh per-row rate for this machine, this disk and
this moment's load. Sections cost ~1.9x the probe per row (0.27s against
0.50s at 48k rows) - a ratio that is a property of the queries, where the
rate is a property of the hardware - so the affordable row count is
`remaining / (perRowMs x 1.9 x sections)`. `remaining` is the 5s budget
*minus what the probe already spent*: the probe is part of the user's wait,
and a plan that ignored it would let a slow probe consume the budget before
planning noticed it was spending anything (on a 20x-slow machine the probe
alone outlasts it). A floor keeps the newest day payable even then. A row-count target *alone* would bake in the
author's laptop: the same 150k rows on a machine 10x slower is the same
plan and ten times the wait, which is precisely the "huge logs, long wait"
case the window exists to prevent. Verified against this repo's real
per-day counts (31 active days, 48k rows): at the measured ~270ms probe the
plan takes all 31 days; simulating 3x, 10x and 50x slower machines narrows
it to 27, 6 and 2 days respectively, with no change to the data.

**Rows, as a memory backstop** (`OVERVIEW_ROW_TARGET`, 150k). Time says
nothing about heap, and a fast machine could otherwise pick a window
approaching the LLP 0056 execution ceiling that LLP 0057 measured at the
~200k-row scale. The tighter of the two caps wins, and `boundBy` records
which one did.

Three rules make this honest rather than merely fast:

- **The newest day is always included, even alone, even when it exceeds the
  target.** A block covering one busy day is a real answer; no block is
  not. Narrowing replaces skipping.
- **The window is always printed**, directly under the title. A total whose
  period is unstated is not an answer, and a smaller number must never be
  mistaken for less work. A narrowed window reports the scope and the lever
  - `showing 3 of 31 active days (2,918 of 48,405 rows); widen with --days
  31` - and never the reason. One wording whatever caused it: the row
  budget, a slow machine and an explicit `--days` are the tool's business,
  and a window the user asked for must not arrive with an apology attached.
  The count is "active days" because the bounds are calendar dates while
  the count is dates that recorded something.
- **An explicit `--days <n>` outranks the budget.** The user asking is
  worth more than the tool's guess about their patience.

### Same plan, different overrun behavior {#overrun}

Both callers plan identically - one budget constant, one probe, one window
- because "how much history can this machine summarize quickly?" has one
answer regardless of who asked. They diverge only when the plan turns out
wrong:

- **`hyp init`** wraps the step in a deadline of `budget + 3s`
  (`FIRST_LOOK_BUDGET_MS`, derived from the shared constant rather than
  chosen independently). The gap is deliberate: it fires only when
  measurement was wrong, never in ordinary operation, and if it starts
  firing routinely the fix is the planner's calibration rather than a
  longer deadline. Setup is where a stall does real damage - the last step
  of an install, after every durable action already succeeded, so a freeze
  reads as "the install broke" when nothing did.

  **Expiry keeps what finished.** `collectOverview` writes each section into
  the caller's object as it lands, so an expired deadline renders the
  completed sections instead of discarding them - three done and a fourth
  in flight is a shorter block, not a blank one. The unfinished sections are
  then named as *unfinished* ("the repos and tools sections did not
  finish"), never silently omitted: "no repos" and "the repos section did
  not finish" are different claims and only one is true. Only when nothing
  usable landed - the probe itself outlasting the budget - does the step
  fall back to skipping entirely (`skip_reason: 'slow'`) with a pointer to
  `hyp query overview`.
- **`hyp query overview`** has no deadline. The user asked and is watching;
  no answer is worse than a slow one, and they hold `--days` either way. At
  the extreme the LLP 0056 heap ceiling still refuses - and the command
  catches that refusal to name the lever the kernel's generic advice
  cannot ("add a WHERE/date filter, a LIMIT" is useless to a block that
  already has a date filter and takes no LIMIT).

The abandoned queries are in-process CPU work and cannot be cancelled; the
CLI's closing `process.exit` drops them. Threading the deadline into
`executeQuerySql`'s existing `signal` (LLP 0054 #signal-threading) would
make the abandonment a real cancellation, and is the obvious next step.

### Every truncation is counted, and counted honestly {#folds}

Three of the four sections show a head and fold the tail into a count line.
The count must be computed over the *whole* grouping, which is why the
`repos` and `daily` statements carry no `LIMIT`: a SQL limit silently
becomes the renderer's idea of the entire result, so "+ N more repos" would
report the tail of the limit rather than the tail of the truth (a 20-row
limit reports 12 hidden when 22 are). Worse for `repos`, where the
repo-less group sorts by token volume like any other row: past 20 repos it
falls off the end and takes its own disclosure line with it, so a machine
with many repos would be told nothing about the Codex sessions that have no
`repo_root` at all. The grouping is computed in full either way; the
`LIMIT` only decided how much of it the renderer got to see.

`daily` has the same shape with a sharper edge, because the block states
its window in the header. A 30-day window rendered as 14 rows under a
header that says 30 is a table that does not answer the question above it,
and anyone summing the column gets half the period without being told. The
renderer shows `MAX_DAY_ROWS` and states how many days it folded.

`tools` keeps its `LIMIT 10` and has no fold line: "the ten most-used
tools" is the whole question there, not a truncation of a larger one.

An empty result gets the same treatment. "Nothing recorded yet" is a claim
about the cache, and when the LLP 0105 filter took every row it is false -
the sessions are recorded, just not visible from here. The runner reports
whether it withheld anything, and the renderer picks the sentence that is
true.

### What the block omits, it says {#disclosure}

The overview runs through the same `executeQuerySql` every other surface
uses, so it inherits that seam's two out-of-band reports: LLP 0105's
withheld-row count, and the freshness line for a dataset with unflushed
writes. Neither belongs in the table - both are about the table.

Withheld rows are disclosed on **both** callers, to stderr. A block that
quietly drops rows and reads as a complete picture is precisely the failure
LLP 0105 exists to prevent, and it would land harder here than on a
hand-written query: the user typed no filter and has no reason to suspect
one. Being mid-install is not an exemption.

Freshness is disclosed by `hyp query overview` and dropped by the wizard
(`firstLookNoticeSink`). The line is true and actionable for someone asking
a question of their data; to someone finishing an install it names a
condition they did not cause and cannot act on, attached to a block whose
backfilled rows were force-flushed on the way in.

One further wrinkle: the block issues five statements, so a naive pass-
through would print the same sentence five times. The runner dedups by
line, which is also why the wording is `renderLocalOnlyNotice` from the
query verb rather than a second copy - two surfaces phrasing the same
disclosure differently is how one of them ends up subtly wrong.

The override the disclosure names has to exist. `hyp query overview` takes
`--include-local-only` for exactly one reason: the withheld-row notice
names that flag as the remedy, and so does the withheld empty state. A
block that tells the user to run a flag and then exits 2 on it is worse
than one that never mentioned it - it turns a disclosure into a dead end.
The wizard never passes it: nothing in a setup step should quietly widen
what a captured transcript can carry, and the person reading the notice can
run the command themselves.

## Telemetry

Per CLAUDE.md's log-driven-development conventions, each new phase gets its
own span, `component: 'wizard'`: `wizard.fork`, `wizard.join` (with
`join_status`, `wait_ms`, `converged: boolean`), `wizard.pick` (superseding
`walkthrough.pick`), `wizard.configure` (one span per descriptor:
`descriptor_id`, `status`, `error_kind` on drop), `wizard.finale`,
`wizard.first_look` (`provider_rows`, `day_rows`, or `status: 'skipped'`
with `skip_reason` when it did not run). `hyp query overview` emits its own
`query.overview` span (`component: 'query'`, `format`, the same row
counts). The
existing `walkthrough.start`/`write_config`/`finish` spans rename to their
`wizard.*` equivalents in the same change that moves the code, per CLAUDE.md's
"update or remove the `@ref` if not" rule for the `@ref LLP 0011#interactive-
walkthrough` annotation currently on `runPickerWalkthrough`.

## Open questions {#open-questions}

1. **Non-macOS `app_bundle` detection.** The `detect.app_bundle` probe kind is
   scoped to `/Applications/*.app` because Claude Desktop is the only
   `needs_setup` client today and it is Mac-only. Neither the RFC nor
   LLP 0129-0134 says what a Windows or Linux client's bundle-presence probe
   should look like (installer registry key? binary-on-PATH? a different
   probe kind entirely?). This is a real fork, not a detail to invent here:
   it stays open until a non-Mac `needs_setup` client is actually proposed.
