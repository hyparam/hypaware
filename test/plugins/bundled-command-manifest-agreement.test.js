// @ts-check

/**
 * Every bundled plugin's manifest and its `activate()` must advertise the same
 * commands, with the same wording.
 *
 * @ref LLP 0267#d2 [tests]: the bundled set is held to the same diff a plugin author runs
 *
 * Plugin command help has two independent sources. `hyp --help` renders before
 * `bootKernel` and reads `contributes.commands` out of `hypaware.plugin.json`
 * (LLP 0009 #top-level-help-lists-plugin-commands-without-booting: booting just
 * to populate the registry would import every entrypoint and bind listeners).
 * `hyp <group> --help` and `hyp <command> --help` render after boot and read
 * the command registry. Either can be edited alone.
 *
 * `@hypaware/context-graph-enrich` proved that costs real breakage: `hyp --help`
 * described `enrich` as "Context-graph enrichment (subcommands: propose, curate,
 * backfill, status)" while `hyp enrich --help` said "Context-graph enrichment",
 * and `enrich status` had two different one-liners. Nothing compared them.
 *
 * This runs `hyp plugin doctor`'s own diff over the whole bundled set, so the
 * check a plugin author gets on their own plugin is the check the bundled
 * plugins are held to. It covers verb-projected commands for free: a verb
 * registers its CLI command into the same registry (LLP 0034 #verbs), so
 * `graph neighbors` is compared exactly like an imperative command.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import { loadManifest } from '../../src/core/manifest.js'
import { diagnosePlugin } from '../../src/core/plugin_doctor/diagnose.js'

/**
 * @import { PluginDiagnostic } from '../../src/core/plugin_doctor/types.js'
 */

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')
const workspace = path.join(repoRoot, 'hypaware-core/plugins-workspace')

/**
 * The findings this file owns. Everything else the doctor reports (an
 * unprovided capability, a bad semver) belongs to a different contract and is
 * deliberately not asserted here.
 */
const COMMAND_KINDS = new Set(['contribution_not_registered', 'contribution_undeclared', 'command_help_drift'])

/** @param {PluginDiagnostic[]} diagnostics */
function commandFindings(diagnostics) {
  return diagnostics.filter((d) => COMMAND_KINDS.has(d.kind) && d.location === '/contributes/commands')
}

const dirs = (await fs.readdir(workspace, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

/**
 * Every capability any bundled plugin provides, so a plugin that calls
 * `ctx.requireCapability()` during `activate()` resolves a stub instead of
 * failing the dry run for a reason that has nothing to do with its commands.
 *
 * @type {Map<string, string[]>}
 */
const knownCapabilities = new Map()
for (const dir of dirs) {
  const loaded = await loadManifest(path.join(workspace, dir))
  if (!loaded.ok) continue
  for (const [name, version] of Object.entries(loaded.manifest.provides?.capabilities ?? {})) {
    knownCapabilities.set(name, [...(knownCapabilities.get(name) ?? []), version])
  }
}

test('every bundled plugin ships a loadable manifest', async () => {
  assert.ok(dirs.length > 0, `no plugin directories under ${workspace}`)
  for (const dir of dirs) {
    const loaded = await loadManifest(path.join(workspace, dir))
    assert.ok(loaded.ok, `${dir}/hypaware.plugin.json does not load: ${loaded.ok ? '' : loaded.message}`)
  }
})

for (const dir of dirs) {
  test(`${dir}: the manifest and activate() agree on commands`, async () => {
    const report = await diagnosePlugin(path.join(workspace, dir), { knownCapabilities })

    // A dry run that never reached `activate()` registers nothing, which would
    // make the diff below vacuously clean. Fail on the cause instead.
    const fatal = report.diagnostics.filter(
      (d) => d.kind === 'entrypoint_import_failed' || d.kind === 'activate_missing' || d.kind === 'manifest_invalid'
    )
    assert.deepEqual(fatal, [], `${dir}: the command diff cannot run:\n${render(fatal)}`)

    assert.deepEqual(
      commandFindings(report.diagnostics),
      [],
      `${dir}: hypaware.plugin.json and activate() disagree about commands.\n${render(commandFindings(report.diagnostics))}\n` +
        'Top-level help reads the manifest; group and leaf help read the registration. Both are shown to the same user.'
    )
  })
}

/** @param {PluginDiagnostic[]} diagnostics */
function render(diagnostics) {
  return diagnostics.map((d) => `  [${d.severity}] ${d.kind}: ${d.message}`).join('\n')
}
