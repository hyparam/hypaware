// @ts-check

import path from 'node:path'
import { parseCommandArgv } from '../cli/verb_codec.js'
import process from 'node:process'

import { Attr, getLogger } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import {
  installPlugin,
  listInstalledPlugins,
  loadLock,
  removePlugin,
  updatePlugin,
} from '../plugin_install/install.js'
import {
  buildTtyPrompt,
  buildWarnings,
  decideConfirmation,
  renderConfirmationSummary,
} from '../plugin_install/confirm.js'
import { diagnosePlugin } from '../plugin_doctor/diagnose.js'
import { renderReport } from '../plugin_doctor/render.js'
import { SCAFFOLD_KINDS, scaffoldPlugin } from '../plugin_doctor/scaffold.js'
import { isTty } from '../cli/stdio.js'

/**
 * @import { CommandRunContext, PluginName } from '../../../collectivus-plugin-kernel-types.js'
 * @import { PluginMetadata } from '../../../src/core/config/types.js'
 * @import { ConfirmInstall } from '../../../src/core/plugin_install/types.js'
 * @import { LoadedManifest } from '../../../src/core/types.js'
 */

/**
 * Resolve the kernel state directory the plugin install commands
 * write into. Mirrors `readObservabilityEnv` so `HYP_HOME` flows
 * through to plugin install just like it does for the cache.
 *
 * @param {CommandRunContext} ctx
 */
export function pluginStateDir(ctx) {
  return readObservabilityEnv(ctx.env).stateDir
}

/**
 * Build the `knownPlugins` map and `knownDatasets` set used by
 * `validateConfig`. Discovers bundled and installed plugin manifests
 * and derives capability metadata from the manifests themselves via
 * `buildPluginCatalog`, so config validation runs against the actual
 * declared capabilities rather than a hardcoded table.
 *
 * Discovery failures are absorbed silently: `hyp config validate`
 * keeps working when the lock is missing or any installed manifest is
 * corrupt; the underlying discovery layer logs its own diagnostics.
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<{ knownPlugins: Map<PluginName, PluginMetadata>, knownDatasets: Set<string> }>}
 */
export async function buildKnownPluginsForCtx(ctx) {
  /** @type {LoadedManifest[]} */
  let bundledLoaded = []
  /** @type {LoadedManifest[]} */
  let installedLoaded = []
  try {
    const bundled = await discoverBundledPlugins()
    bundledLoaded = [...bundled.loaded, ...bundled.excluded]
  } catch { /* bundled discovery failure is non-fatal */ }
  try {
    const stateDir = pluginStateDir(ctx)
    const installed = await discoverInstalledPlugins({ stateDir })
    installedLoaded = installed.loaded
  } catch { /* installed discovery failure is non-fatal */ }
  const catalog = buildPluginCatalog(bundledLoaded, installedLoaded)
  return { knownPlugins: catalog.pluginMetadata, knownDatasets: catalog.knownDatasets }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginInstall(argv, ctx) {
  const parsed = parsePluginInstallArgs(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp plugin install: ${parsed.message}\n`)
    return parsed.code
  }
  const stateDir = pluginStateDir(ctx)
  const confirm = buildPluginInstallConfirm({
    yes: parsed.yes,
    ctx,
    headerKind: 'install',
  })
  const result = await installPlugin({
    rawSource: parsed.rawSource,
    stateDir,
    cwd: ctx.cwd,
    opts: { ref: parsed.ref, subdir: parsed.subdir },
    confirm,
  })
  if (!result.ok) {
    ctx.stderr.write(`hyp plugin install: ${result.message}\n`)
    return result.errorKind === 'remote_install_confirmation_required' ? 2 : 1
  }
  ctx.stdout.write(
    `installed ${result.entry.name}@${result.entry.version} from ${result.entry.source.kind}\n`
  )
  ctx.stdout.write(`  install_dir: ${result.entry.install_dir}\n`)
  if (result.entry.resolved_ref) {
    ctx.stdout.write(`  resolved_ref: ${result.entry.resolved_ref}\n`)
  }
  return 0
}

/**
 * Build the install-time trust gate. The factory is shared between the
 * install and update CLI commands so both produce the same prompt and
 * the same telemetry outcomes.
 *
 * @param {{
 *   yes: boolean,
 *   ctx: CommandRunContext,
 *   headerKind: 'install' | 'update',
 * }} args
 * @returns {ConfirmInstall}
 */
function buildPluginInstallConfirm({ yes, ctx, headerKind }) {
  const stderr = ctx.stderr
  return async function confirm(staged) {
    const summary = renderConfirmationSummary(
      {
        manifest: staged.manifest,
        source: staged.source,
        resolvedRef: staged.resolvedRef,
        contentHash: staged.contentHash,
        manifestHash: staged.manifestHash,
      },
      {
        ...(staged.previous ? { previous: staged.previous } : {}),
        headerKind,
      }
    )
    const warnings = buildWarnings({
      manifest: staged.manifest,
      source: staged.source,
      resolvedRef: staged.resolvedRef,
      contentHash: staged.contentHash,
      manifestHash: staged.manifestHash,
    })
    for (const w of warnings) stderr.write(`${w}\n`)
    stderr.write(summary)
    // Prompt on stderr so stdout stays parseable. We require both
    // stderr and stdin to be a TTY before asking: piping either
    // direction means "no human watching, prompt is useless."
    const tty = isTty(stderr) && isTty(process.stdin)
    const ask = tty
      ? buildTtyPrompt({
        stdin: process.stdin,
        stdout: /** @type {NodeJS.WritableStream} */ (stderr),
      })
      : undefined
    const decision = await decideConfirmation({ yes, tty, ...(ask ? { ask } : {}) })
    return decision
  }
}

/**
 * Parse `hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]`.
 * Flags accept both `--flag value` and `--flag=value` forms. The
 * function does NOT verify mutual exclusion of `--ref` with a URL
 * fragment. That lives in the resolver so the same rule applies to
 * programmatic callers.
 *
 * @param {string[]} argv
 * @returns {(
 *   { ok: true, rawSource: string, ref?: string, subdir?: string, yes: boolean }
 *   | { ok: false, code: number, message: string }
 * )}
 */
const PLUGIN_INSTALL_USAGE = 'usage: hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]'

/**
 * @param {string[]} argv
 * @returns {{ ok: false, code: number, message: string } | { ok: true, rawSource: string, ref?: string, subdir?: string, yes: boolean }}
 */
function parsePluginInstallArgs(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      source: { type: 'string' },
      ref: { type: 'string' },
      path: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    positional: ['source'],
  }, { aliases: { '-y': '--yes' } })
  if ('help' in parsed) return { ok: false, code: 2, message: PLUGIN_INSTALL_USAGE }
  if (!parsed.ok) return { ok: false, code: 2, message: parsed.error }
  const p = /** @type {{ source?: string, ref?: string, path?: string, yes: boolean }} */ (parsed.params)
  // Block `-X` style values: `applyGitSourceFlags` enforces the same rule
  // but rejecting at the CLI layer gives a friendlier error before the
  // install span opens.
  for (const [flag, value] of [['--ref', p.ref], ['--path', p.path]]) {
    if (value !== undefined && value.startsWith('-')) {
      return { ok: false, code: 2, message: `flag ${flag} value must not start with '-'` }
    }
  }
  if (!p.source) return { ok: false, code: 2, message: PLUGIN_INSTALL_USAGE }
  return { ok: true, rawSource: p.source, ref: p.ref, subdir: p.path, yes: p.yes }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginList(argv, ctx) {
  const json = argv.includes('--json')
  const stateDir = pluginStateDir(ctx)
  const installed = await listInstalledPlugins(stateDir)
  const active = ctx.plugins ?? []

  if (json) {
    const installedByName = new Map(installed.map((e) => [e.name, e]))
    const activeByName = new Map(active.map((p) => [p.name, p]))
    const allNames = new Set([
      ...installedByName.keys(),
      ...activeByName.keys(),
    ])
    /** @type {Array<{name: string, version: string, source: 'bundled'|'installed', active: boolean, installed_at?: string, update?: unknown}>} */
    const plugins = []
    for (const name of Array.from(allNames).sort()) {
      const inst = installedByName.get(name)
      const act = activeByName.get(name)
      const version = act?.version ?? inst?.version ?? ''
      plugins.push({
        name,
        version,
        source: inst ? 'installed' : 'bundled',
        active: !!act,
        ...(inst ? { installed_at: inst.installed_at } : {}),
        ...(inst?.update !== undefined ? { update: inst.update } : {}),
      })
    }
    ctx.stdout.write(JSON.stringify({ plugins }, null, 2) + '\n')
    return 0
  }

  if (active.length === 0 && installed.length === 0) {
    ctx.stdout.write('No plugins active or installed.\n')
    return 0
  }
  if (active.length > 0) {
    ctx.stdout.write('Active plugins (from current boot):\n')
    for (const p of active) {
      ctx.stdout.write(`  ${p.name}@${p.version}  (bundled)\n`)
    }
  }
  if (installed.length > 0) {
    ctx.stdout.write('Installed plugins:\n')
    for (const entry of installed) {
      const available = entry.update?.available ? '  (update available)' : ''
      ctx.stdout.write(`  ${entry.name}@${entry.version}${available}\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginInfo(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin info <plugin>\n')
    return 2
  }
  const name = argv[0]
  const stateDir = pluginStateDir(ctx)
  const lock = await loadLock(stateDir)
  const entry = lock.plugins[name]
  if (!entry) {
    ctx.stderr.write(`hyp plugin info: '${name}' is not installed\n`)
    return 1
  }
  ctx.stdout.write(`${entry.name}@${entry.version}\n`)
  ctx.stdout.write(`  source:        ${entry.source.kind} (${entry.source.raw})\n`)
  ctx.stdout.write(`  install_dir:   ${entry.install_dir}\n`)
  ctx.stdout.write(`  content_hash:  ${entry.content_hash}\n`)
  ctx.stdout.write(`  manifest_hash: ${entry.manifest_hash}\n`)
  ctx.stdout.write(`  installed_at:  ${entry.installed_at}\n`)
  if (entry.update) {
    ctx.stdout.write(`  update_check:  ${entry.update.checked_at}\n`)
    ctx.stdout.write(`  available:     ${entry.update.available}\n`)
    if (entry.update.latest_version) {
      ctx.stdout.write(`  latest:        ${entry.update.latest_version}\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginOutdated(argv, ctx) {
  const json = argv.includes('--json')
  const stateDir = pluginStateDir(ctx)
  const entries = await listInstalledPlugins(stateDir)
  const outdated = entries.filter((e) => e.update?.available === true)
  if (json) {
    ctx.stdout.write(
      JSON.stringify(
        {
          plugins: outdated.map((e) => ({
            name: e.name,
            version: e.version,
            latest_version: e.update?.latest_version,
            checked_at: e.update?.checked_at,
          })),
        },
        null,
        2
      ) + '\n'
    )
    return 0
  }
  if (outdated.length === 0) {
    ctx.stdout.write('All plugins up to date.\n')
    return 0
  }
  for (const entry of outdated) {
    const latest = entry.update?.latest_version ?? '?'
    ctx.stdout.write(`  ${entry.name}: ${entry.version} -> ${latest}\n`)
  }
  return 0
}

/**
 * `hyp plugin update <plugin>` runs the full fetch → validate → diff →
 * confirm → swap pipeline for an installed plugin. The bare form
 * `hyp plugin update` (no plugin name) keeps the legacy "refresh
 * update_check state for every plugin" behavior so users have a way
 * to refresh the `outdated` view without committing to a re-install.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginUpdate(argv, ctx) {
  const parsed = parsePluginUpdateArgs(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp plugin update: ${parsed.message}\n`)
    return parsed.code
  }
  const stateDir = pluginStateDir(ctx)
  if (parsed.target) {
    const confirm = buildPluginInstallConfirm({
      yes: parsed.yes,
      ctx,
      headerKind: 'update',
    })
    const result = await updatePlugin({ name: parsed.target, stateDir, confirm })
    if (!result.ok) {
      ctx.stderr.write(`hyp plugin update: ${result.message}\n`)
      return result.errorKind === 'remote_install_confirmation_required' ? 2 : 1
    }
    ctx.stdout.write(
      `updated ${result.entry.name}@${result.entry.version}\n`
    )
    if (result.entry.resolved_ref) {
      ctx.stdout.write(`  resolved_ref: ${result.entry.resolved_ref}\n`)
    }
    ctx.stdout.write(`  content_hash: ${result.entry.content_hash}\n`)
    return 0
  }

  // No target: keep the "refresh update-check state for all" behavior so
  // users still have a way to recompute `outdated` without re-installing.
  const { checkForPluginUpdate } = await import('../plugin_install/update_check.js')
  const { upsertEntry, writeLock } = await import('../plugin_install/lock.js')
  const lock = await loadLock(stateDir)
  const entries = Object.values(lock.plugins)
  let next = lock
  for (const entry of entries) {
    const probeInput = { ...entry, update: undefined }
    const state = await checkForPluginUpdate({ entry: probeInput })
    next = upsertEntry(next, { ...entry, update: state })
  }
  await writeLock(stateDir, next)
  ctx.stdout.write(`refreshed update state for ${entries.length} plugin(s)\n`)
  return 0
}

/**
 * Parse `hyp plugin update [plugin] [--yes]`.
 *
 * @param {string[]} argv
 * @returns {(
 *   { ok: true, target?: string, yes: boolean }
 *   | { ok: false, code: number, message: string }
 * )}
 */
/**
 * @param {string[]} argv
 * @returns {{ ok: false, code: number, message: string } | { ok: true, target?: string, yes: boolean }}
 */
function parsePluginUpdateArgs(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      plugin: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    positional: ['plugin'],
  }, { aliases: { '-y': '--yes' } })
  if ('help' in parsed) return { ok: false, code: 2, message: 'usage: hyp plugin update [plugin] [--yes]' }
  if (!parsed.ok) return { ok: false, code: 2, message: parsed.error }
  const p = /** @type {{ plugin?: string, yes: boolean }} */ (parsed.params)
  return { ok: true, target: p.plugin, yes: p.yes }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginRemove(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin remove <plugin>\n')
    return 2
  }
  const name = argv[0]
  const stateDir = pluginStateDir(ctx)
  const result = await removePlugin({ name, stateDir })
  if (!result.ok) {
    ctx.stderr.write(`hyp plugin remove: ${result.message}\n`)
    return 1
  }
  ctx.stdout.write(`removed ${name}\n`)
  return 0
}

/**
 * Diagnose a plugin directory in development: static manifest/entrypoint
 * checks plus a sandboxed dry-run `activate()` that confirms the code
 * registers what the manifest declares. Aggregates every finding into a
 * single report (human or `--json`). Exit 0 when there are no
 * error-severity diagnostics (warnings allowed), 1 otherwise.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginDoctor(argv, ctx) {
  /** @type {string|undefined} */
  let dir
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') json = true
    else if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp plugin doctor [dir] [--json]\n')
      return 0
    } else if (token.startsWith('-')) {
      ctx.stderr.write(`hyp plugin doctor: unknown flag '${token}'\n`)
      return 2
    } else if (dir === undefined) {
      dir = token
    } else {
      ctx.stderr.write(`hyp plugin doctor: unexpected argument '${token}'\n`)
      return 2
    }
  }

  const rootDir = path.resolve(ctx.cwd ?? process.cwd(), dir ?? '.')
  const { knownPlugins } = await buildKnownPluginsForCtx(ctx)
  const knownCapabilities = capabilitiesFromMetadata(knownPlugins)

  const report = await diagnosePlugin(rootDir, { knownCapabilities })

  getLogger('plugin-doctor').info('plugin.doctor', {
    component: 'plugin-doctor',
    operation: 'plugin.doctor',
    status: report.ok ? 'ok' : 'error',
    [Attr.PLUGIN]: report.pluginName ?? '',
    error_count: report.errorCount,
    warn_count: report.warnCount,
  })

  if (json) {
    ctx.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    ctx.stdout.write(renderReport(report))
  }
  return report.ok ? 0 : 1
}

/**
 * Map every capability name any known plugin provides to the versions
 * provided, used to resolve a plugin's `requires.capabilities` against
 * their declared semver ranges (not just by name).
 *
 * @param {Map<PluginName, PluginMetadata>} knownPlugins
 * @returns {Map<string, string[]>}
 */
function capabilitiesFromMetadata(knownPlugins) {
  /** @type {Map<string, string[]>} */
  const caps = new Map()
  for (const meta of knownPlugins.values()) {
    if (!meta.provides) continue
    for (const [name, version] of Object.entries(meta.provides)) {
      if (typeof version !== 'string') continue
      const versions = caps.get(name)
      if (versions) versions.push(version)
      else caps.set(name, [version])
    }
  }
  return caps
}

/**
 * Scaffold a new plugin directory that passes `hyp plugin doctor`
 * out of the box.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runPluginNew(argv, ctx) {
  /** @type {string|undefined} */
  let name
  let kind = 'source'
  /** @type {string|undefined} */
  let dirFlag
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--kind') {
      kind = argv[i + 1]
      i += 1
      if (!kind) {
        ctx.stderr.write('hyp plugin new: --kind expects a value\n')
        return 2
      }
    } else if (token === '--dir') {
      dirFlag = argv[i + 1]
      i += 1
      if (!dirFlag) {
        ctx.stderr.write('hyp plugin new: --dir expects a path\n')
        return 2
      }
    } else if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp plugin new <name> [--kind source|sink|dataset] [--dir <path>]\n')
      return 0
    } else if (token.startsWith('-')) {
      ctx.stderr.write(`hyp plugin new: unknown flag '${token}'\n`)
      return 2
    } else if (name === undefined) {
      name = token
    } else {
      ctx.stderr.write(`hyp plugin new: unexpected argument '${token}'\n`)
      return 2
    }
  }

  if (!name) {
    ctx.stderr.write('usage: hyp plugin new <name> [--kind source|sink|dataset] [--dir <path>]\n')
    return 2
  }
  if (!SCAFFOLD_KINDS.includes(/** @type {any} */ (kind))) {
    ctx.stderr.write(`hyp plugin new: unknown kind '${kind}' (expected ${SCAFFOLD_KINDS.join('|')})\n`)
    return 2
  }

  const targetDir = path.resolve(ctx.cwd ?? process.cwd(), dirFlag ?? '.')
  try {
    const result = await scaffoldPlugin({ name, kind: /** @type {any} */ (kind), targetDir })
    ctx.stdout.write(`created ${result.pluginName} (${kind}) at ${result.pluginDir}\n`)
    for (const file of result.files) {
      ctx.stdout.write(`  ${path.relative(targetDir, file)}\n`)
    }
    ctx.stdout.write(`\nnext: hyp plugin doctor ${result.pluginDir}\n`)
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp plugin new: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
