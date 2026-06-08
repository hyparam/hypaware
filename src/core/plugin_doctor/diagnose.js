// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { loadManifest } from '../manifest.js'
import { isValidRange, isValidSemver, matchesSemverRange } from '../semver.js'
import { dryRunActivate } from './dry_run.js'

/**
 * @import { PluginManifest } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { DoctorReport, DryRunResult, PluginDiagnostic, RegisteredSnapshot } from './types.d.ts'
 */

const GUIDE = 'docs/PLUGIN_AUTHORING.md'

/**
 * Contribution categories that map a `manifest.contributes.<key>` array
 * to a registry snapshot bucket. Drives both the
 * `contribution_not_registered` and `contribution_undeclared` checks.
 *
 * `config_sections` is deliberately excluded: a manifest section is
 * metadata for help text, and calling `ctx.configRegistry.registerSection()`
 * to attach a validator is optional (most real plugins declare a section
 * without one). Flagging it would false-positive across the bundled set.
 *
 * @type {Array<{ key: keyof RegisteredSnapshot, nameField: 'name' | 'section', label: string, register: string, anchor: string }>}
 */
const CONTRIBUTIONS = [
  { key: 'sources', nameField: 'name', label: 'source', register: "ctx.sources.register({ name: '%s', plugin, start })", anchor: 'registering-sources' },
  { key: 'sinks', nameField: 'name', label: 'sink', register: "ctx.sinks.register({ name: '%s', plugin, supports, create })", anchor: 'registering-sinks' },
  { key: 'datasets', nameField: 'name', label: 'dataset', register: "ctx.query.registerDataset({ name: '%s', ... })", anchor: 'registering-datasets' },
  { key: 'commands', nameField: 'name', label: 'command', register: "ctx.commands.register({ name: '%s', plugin, run })", anchor: 'registering-commands' },
  { key: 'skills', nameField: 'name', label: 'skill', register: "ctx.skills.register({ name: '%s', plugin, clients, sourceDir })", anchor: 'skills' },
  { key: 'init_presets', nameField: 'name', label: 'init preset', register: "ctx.initPresets.register({ name: '%s', plugin, summary, run })", anchor: 'init-presets' },
]

/**
 * Run every doctor check against a plugin directory and return a single
 * aggregated report. All findings are collected (the function never
 * stops at the first), so an author sees the full picture in one pass.
 *
 * @param {string} rootDir Absolute path to the plugin directory.
 * @param {{ knownCapabilities?: Map<string, string[]> }} [opts]
 *   `knownCapabilities` maps each capability name any bundled/installed
 *   plugin provides to the versions it provides — used to resolve
 *   `requires.capabilities` against their declared semver ranges, and to
 *   pre-seed the dry run. Defaults to empty (every required capability is
 *   then flagged), so callers should pass the catalog map.
 * @returns {Promise<DoctorReport>}
 */
export async function diagnosePlugin(rootDir, opts = {}) {
  const knownCapabilities = opts.knownCapabilities ?? new Map()
  /** @type {PluginDiagnostic[]} */
  const diagnostics = []

  const loaded = await loadManifest(rootDir)
  if (!loaded.ok) {
    diagnostics.push({
      kind: 'manifest_invalid',
      severity: 'error',
      location: loaded.manifestPath,
      message: loaded.message,
      repair: [
        `See the manifest field reference: ${GUIDE}#manifest`,
        `Scaffold a known-good plugin to compare: hyp plugin new <name>`,
      ],
    })
    return finalize(rootDir, undefined, diagnostics)
  }

  const manifest = loaded.manifest
  await checkStatic(manifest, rootDir, diagnostics)

  const dry = await dryRunActivate(manifest, rootDir, { knownCapabilities })
  if (dry.error) {
    diagnostics.push(diagnoseDryRunError(manifest, dry.error))
  }

  // The declared-vs-registered diff only makes sense once activation
  // ran. On import/activate_missing failures the snapshot is empty and
  // the root error above already explains why nothing registered.
  const reachedActivation = dry.ok || dry.error?.kind === 'activate_threw'
  if (reachedActivation) {
    checkContributions(manifest, dry.registered, diagnostics)
  }
  if (dry.ok) {
    checkProvidedCapabilities(manifest, dry.registered, diagnostics)
  }

  checkRequiredCapabilities(manifest, knownCapabilities, diagnostics)

  return finalize(rootDir, manifest.name, diagnostics)
}

/* ---------- static checks ---------- */

/**
 * @param {PluginManifest} manifest
 * @param {string} rootDir
 * @param {PluginDiagnostic[]} out
 */
async function checkStatic(manifest, rootDir, out) {
  const entrypointAbs = path.resolve(rootDir, manifest.entrypoint)
  const isFile = await fs.stat(entrypointAbs).then((s) => s.isFile(), () => false)
  if (!isFile) {
    out.push({
      kind: 'entrypoint_missing',
      severity: 'error',
      location: '/entrypoint',
      message: `entrypoint '${manifest.entrypoint}' does not resolve to a file (looked at ${entrypointAbs})`,
      repair: [
        `Create the file or fix the "entrypoint" path in hypaware.plugin.json`,
        `Conventionally plugins use "./src/index.js"`,
      ],
    })
  }

  if (!isValidSemver(manifest.version)) {
    out.push({
      kind: 'semver_invalid',
      severity: 'error',
      location: '/version',
      message: `version '${manifest.version}' is not a valid X.Y.Z semantic version`,
      repair: [`Set "version" to a semver string, e.g. "1.0.0"`],
    })
  }
  if (!isValidRange(manifest.hypaware_api)) {
    out.push({
      kind: 'semver_invalid',
      severity: 'error',
      location: '/hypaware_api',
      message: `hypaware_api '${manifest.hypaware_api}' is not a range the kernel understands`,
      repair: [`Use a caret range against the kernel API, e.g. "^1.0.0"`],
    })
  }

  if (!/^@[^/]+\/[^/]+$/.test(manifest.name)) {
    out.push({
      kind: 'name_convention',
      severity: 'warn',
      location: '/name',
      message: `name '${manifest.name}' does not follow the '@scope/slug' convention`,
      repair: [`Rename to a scoped form, e.g. "@yourorg/${slugFromName(manifest.name)}"`],
    })
  }

  checkContributesShape(manifest, out)
}

/**
 * Categories validated for *shape* only: each entry must be an object
 * with a non-empty name field. A superset of CONTRIBUTIONS — it also
 * covers `config_sections` (keyed on `section`), which is excluded from
 * the declared-vs-registered diff but still must be well-formed, as the
 * authoring guide promises.
 *
 * @type {Array<{ key: string, nameField: 'name' | 'section', label: string }>}
 */
const SHAPE_CHECKS = [
  ...CONTRIBUTIONS.map(({ key, nameField, label }) => ({ key, nameField, label })),
  { key: 'config_sections', nameField: 'section', label: 'config section' },
]

/**
 * Each `contributes.<category>` entry must be an object with a non-empty
 * name (or `section` for config sections). Malformed entries are
 * reported and excluded from the registration diff.
 *
 * @param {PluginManifest} manifest
 * @param {PluginDiagnostic[]} out
 */
function checkContributesShape(manifest, out) {
  const contributes = manifest.contributes
  if (!contributes) return
  for (const { key, nameField, label } of SHAPE_CHECKS) {
    const entries = /** @type {unknown} */ (contributes[/** @type {keyof typeof contributes} */ (key)])
    if (entries === undefined) continue
    if (!Array.isArray(entries)) {
      out.push({
        kind: 'contributes_malformed',
        severity: 'error',
        location: `/contributes/${key}`,
        message: `contributes.${key} must be an array`,
        repair: [`See ${GUIDE}#manifest for the contributes shape`],
      })
      continue
    }
    entries.forEach((entry, i) => {
      const name = isObject(entry) ? entry[nameField] : undefined
      if (typeof name !== 'string' || name.length === 0) {
        out.push({
          kind: 'contributes_malformed',
          severity: 'error',
          location: `/contributes/${key}/${i}`,
          message: `contributes.${key}[${i}] is missing a non-empty "${nameField}"`,
          repair: [`Give every ${label} entry a "${nameField}"`],
        })
      }
    })
  }
}

/* ---------- dry-run-derived checks ---------- */

/**
 * @param {PluginManifest} manifest
 * @param {NonNullable<DryRunResult['error']>} error
 * @returns {PluginDiagnostic}
 */
function diagnoseDryRunError(manifest, error) {
  if (error.kind === 'entrypoint_import_failed') {
    return {
      kind: 'entrypoint_import_failed',
      severity: 'error',
      location: '/entrypoint',
      message: `importing '${manifest.entrypoint}' failed:\n${error.message}`,
      repair: [
        `Fix the import/syntax error above`,
        `Declare type imports with @import JSDoc, not inline import('...') types`,
      ],
    }
  }
  if (error.kind === 'activate_missing') {
    return {
      kind: 'activate_missing',
      severity: 'error',
      location: '/entrypoint',
      message: error.message,
      repair: [
        `Add: export async function activate(ctx) { /* register contributions */ }`,
        `See ${GUIDE}#the-activatectx-contract`,
      ],
    }
  }
  return {
    kind: 'activate_threw',
    severity: 'error',
    location: 'activate()',
    message: `activate(ctx) threw during the dry run:\n${error.message}`,
    repair: [
      `activate() should register contributions and defer config reads to start()/create()`,
      `See ${GUIDE}#the-activatectx-contract`,
    ],
  }
}

/**
 * Diff declared contributions against what actually registered.
 * Missing-from-code is an error; registered-but-undeclared is a warning
 * (the manifest powers help text and discovery).
 *
 * @param {PluginManifest} manifest
 * @param {RegisteredSnapshot} registered
 * @param {PluginDiagnostic[]} out
 */
function checkContributions(manifest, registered, out) {
  const contributes = manifest.contributes ?? {}
  for (const { key, nameField, label, register, anchor } of CONTRIBUTIONS) {
    const declared = declaredNames(contributes, key, nameField)
    const actual = new Set(registered[key])

    for (const name of declared) {
      if (!actual.has(name)) {
        out.push({
          kind: 'contribution_not_registered',
          severity: 'error',
          location: `/contributes/${key}`,
          message: `manifest declares ${label} '${name}' but activate() never registered it`,
          repair: [
            `In activate(), add: ${register.replace('%s', name)}`,
            `See ${GUIDE}#${anchor}`,
          ],
        })
      }
    }

    const declaredSet = new Set(declared)
    for (const name of registered[key]) {
      if (!declaredSet.has(name)) {
        out.push({
          kind: 'contribution_undeclared',
          severity: 'warn',
          location: `/contributes/${key}`,
          message: `activate() registered ${label} '${name}' but the manifest does not declare it`,
          repair: [
            `Add it to contributes.${key} in hypaware.plugin.json so it shows up in help/discovery`,
          ],
        })
      }
    }
  }
}

/**
 * @param {PluginManifest} manifest
 * @param {RegisteredSnapshot} registered
 * @param {PluginDiagnostic[]} out
 */
function checkProvidedCapabilities(manifest, registered, out) {
  const provides = manifest.provides?.capabilities
  if (!provides) return
  const actual = new Set(registered.capabilities)
  for (const name of Object.keys(provides)) {
    if (!actual.has(name)) {
      out.push({
        kind: 'capability_unprovided',
        severity: 'warn',
        location: '/provides/capabilities',
        message: `manifest declares it provides '${name}' but activate() never called provideCapability()`,
        repair: [
          `In activate(), add: ctx.provideCapability('${name}', '${provides[name]}', impl)`,
          `See ${GUIDE}#capabilities`,
        ],
      })
    }
  }
}

/**
 * `requires.capabilities` is a name → semver-range contract, so a
 * provider satisfies it only when one of its provided versions falls in
 * the required range. A name with no provider at all, and a name whose
 * providers all fall outside the range, are both `capability_unresolved`
 * — runtime resolution would reject either.
 *
 * @param {PluginManifest} manifest
 * @param {Map<string, string[]>} knownCapabilities
 * @param {PluginDiagnostic[]} out
 */
function checkRequiredCapabilities(manifest, knownCapabilities, out) {
  const requires = manifest.requires?.capabilities
  if (!requires) return
  for (const [name, range] of Object.entries(requires)) {
    const provided = knownCapabilities.get(name)
    if (!provided || provided.length === 0) {
      out.push({
        kind: 'capability_unresolved',
        severity: 'error',
        location: '/requires/capabilities',
        message: `requires capability '${name}', but no bundled or installed plugin provides it`,
        repair: [
          `Install a plugin that provides '${name}', or remove the requirement`,
          `List providers with: hyp plugin list`,
        ],
      })
      continue
    }
    if (!provided.some((version) => matchesSemverRange(version, range))) {
      out.push({
        kind: 'capability_unresolved',
        severity: 'error',
        location: '/requires/capabilities',
        message: `requires capability '${name}' '${range}', but the only provider(s) offer ${provided.join(', ')}`,
        repair: [
          `Widen the required range, or install a provider of '${name}' matching '${range}'`,
          `List providers with: hyp plugin list`,
        ],
      })
    }
  }
}

/* ---------- helpers ---------- */

/**
 * @param {NonNullable<PluginManifest['contributes']>} contributes
 * @param {keyof RegisteredSnapshot} key
 * @param {'name' | 'section'} nameField
 * @returns {string[]}
 */
function declaredNames(contributes, key, nameField) {
  const entries = /** @type {unknown} */ (contributes[/** @type {keyof typeof contributes} */ (key)])
  if (!Array.isArray(entries)) return []
  /** @type {string[]} */
  const names = []
  for (const entry of entries) {
    const name = isObject(entry) ? entry[nameField] : undefined
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}

/**
 * @param {string} rootDir
 * @param {string | undefined} pluginName
 * @param {PluginDiagnostic[]} diagnostics
 * @returns {DoctorReport}
 */
function finalize(rootDir, pluginName, diagnostics) {
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warnCount = diagnostics.length - errorCount
  return {
    ok: errorCount === 0,
    ...(pluginName ? { pluginName } : {}),
    rootDir,
    diagnostics,
    errorCount,
    warnCount,
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** @param {string} name */
function slugFromName(name) {
  const tail = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  return tail.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'my-plugin'
}
