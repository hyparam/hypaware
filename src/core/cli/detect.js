// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveClientSettingsPath } from '../daemon/client_settings_path.js'

/**
 * @import { PickerDetectProbe } from '../../../hypaware-plugin-kernel-types.js'
 * @import { PluginCatalog } from '../../../src/core/types.js'
 */

/**
 * Inspect the system for the tools/apps a plugin's `contributes.picker`
 * row declares a presence probe for, and return the set of picker
 * source ids that are present. Fully descriptor-driven: no source is
 * hardcoded here, the plugin manifest owns which probe variant its row
 * uses (`settings_file`, `app_bundle`, `path`) via `catalog.pickerDescriptors`
 * (`@ref LLP 0130#picker-block [implements]`).
 *
 * This is the migration the file's own header comment used to
 * anticipate ("If the picker is ever made plugin-driven, move
 * detection to iterate the client descriptors..."): detection now
 * iterates `catalog.pickerDescriptors` instead of a hardcoded table.
 *
 * Best-effort: any probe failure (stat error, missing env override,
 * unrecognized probe variant, etc) is "not present," never thrown. The
 * result only seeds the picker's initial checkbox state; the user can
 * still toggle every box.
 *
 * @param {PluginCatalog} catalog
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Set<string>>}
 */
export async function detectPickerSources(catalog, env) {
  const homeDir = env.HOME ?? os.homedir()
  /** @type {Set<string>} */
  const detected = new Set()
  await Promise.all(
    [...catalog.pickerDescriptors.values()].map(async (descriptor) => {
      const probe = descriptor.detect
      if (!probe) return
      try {
        if (await probeIsPresent(descriptor.id, probe, env, homeDir)) {
          detected.add(descriptor.id)
        }
      } catch {
        // ENOENT (or any probe failure) → source not present; leave unset.
      }
    })
  )
  return detected
}

/**
 * Evaluate a single picker row's presence probe.
 *
 * - `settings_file` reuses the existing {@link resolveClientSettingsPath}
 *   check: does the *directory* holding this file (the client's config
 *   home) exist? Unchanged behavior for `claude`/`codex`.
 * - `app_bundle` stats the literal path (e.g. `/Applications/Claude.app`).
 * - `path` stats the literal path, honoring the same `$FOO_HOME`-style
 *   env override {@link resolveClientSettingsPath} already applies for
 *   `settings_file` probes: `${SOURCE_ID}_HOME`, when set, replaces the
 *   manifest's literal path outright.
 *
 * @param {string} sourceId
 * @param {PickerDetectProbe} probe
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homeDir
 * @returns {Promise<boolean>}
 */
async function probeIsPresent(sourceId, probe, env, homeDir) {
  if ('settings_file' in probe) {
    const settingsPath = resolveClientSettingsPath(sourceId, probe.settings_file, env, homeDir)
    const configHome = path.dirname(settingsPath)
    const stat = await fsp.stat(configHome)
    return stat.isDirectory()
  }
  if ('app_bundle' in probe) {
    await fsp.stat(probe.app_bundle)
    return true
  }
  if ('path' in probe) {
    const target = resolvePathProbeTarget(sourceId, probe.path, env)
    await fsp.stat(target)
    return true
  }
  return false
}

/**
 * Resolve a `path` probe's literal path, honoring a `$FOO_HOME`-style
 * env override the same way `resolveClientSettingsPath` does for
 * `settings_file` probes, except the override replaces the literal
 * path outright rather than being joined onto a home-relative one.
 *
 * @param {string} sourceId
 * @param {string} literalPath
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolvePathProbeTarget(sourceId, literalPath, env) {
  const envKey = `${sourceId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_HOME`
  const override = env[envKey]
  return typeof override === 'string' && override.length > 0 ? override : literalPath
}
