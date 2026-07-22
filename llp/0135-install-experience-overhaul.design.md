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
  index.js               // runInitWizard(opts): fork -> join -> pick -> configure -> privacy -> finale
  fork.js                 // runWizardFork(opts), the returning-gate split (scoped vs full re-entry)
  join.js                  // runWizardJoin(opts): wraps runRemoteLogin, bounded org-config wait, locked-row set
  pick.js                   // runWizardPick(opts): the picker prompt + composePickerConfig (descriptor-driven, was walkthrough.js)
  configure.js               // runConfigurePhase(picked, ctx): needs_setup loop, drop-on-failure, --print-commands passthrough
  provenance.js               // classifyClientProvenance(name, layered): shared by pick.js, status.js, and the export seam
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
  await narratePrivacyIfTeamPath(opts, pathway)              // @ref LLP 0134#login-lane, unchanged mechanism
  return await runWizardFinale({ picked, configured, joinedAlready: pathway === 'team', opts })
}
```

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
       "plugin": "@hypaware/claude",
       "requires_gateway": true,
       "gateway_upstream": { "name": "anthropic", "base_url": "https://api.anthropic.com", "path_prefix": "/v1/messages", "provider": "anthropic" }
     }
   }
   ```

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
after the configure phase, on the team pathway only. No prompt, no picker:
`@ref LLP 0134#login-lane [constrained-by]`: the review window rides the
login lane exactly as before; the wizard only narrates it.

## Finale {#finale}

`runWizardFinale` is `runPickerFinale` (`walkthrough.js:757`) with one new
input, `joinedAlready`: when true (team pathway), the daemon-install and
attach steps are skipped if `hyp status` already reports them done from the
join lane, rather than re-running (`@ref LLP 0134#login-lane`, "the finale
detects and skips what enrollment already did"). Skills/agents install is
untouched: it already iterates `clientsPicked` against
`buildWalkthroughClientDescriptorMap()` (`walkthrough.js:873-923`), which is
generic over any client descriptor including the new `claude-desktop` one, so
Desktop's skills/agents installation ("the finale" thread from issue #302)
requires no new code beyond `claude-desktop`'s manifest declaring
`skills`/`agents` contributions the same way `@hypaware/claude` and
`@hypaware/codex` already do. Backfill consent stays solo-path-only
(per [LLP 0128 Design sketch](./0128-install-experience-overhaul.rfc.md#design-sketch), unchanged): an enrolled machine backfills
under [LLP 0037](./0037-backfill-on-join.decision.md) default-on doctrine.

## Telemetry

Per CLAUDE.md's log-driven-development conventions, each new phase gets its
own span, `component: 'wizard'`: `wizard.fork`, `wizard.join` (with
`join_status`, `wait_ms`, `converged: boolean`), `wizard.pick` (superseding
`walkthrough.pick`), `wizard.configure` (one span per descriptor:
`descriptor_id`, `status`, `error_kind` on drop), `wizard.finale`. The
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
