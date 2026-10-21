// @ts-check

import fsp from 'node:fs/promises'
import { constants } from 'node:fs'
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
 * uses via `catalog.pickerDescriptors`
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
 * @param {string} [cwd] current project directory, never an implicit home search
 * @returns {Promise<Set<string>>}
 */
export async function detectPickerSources(catalog, env, cwd = process.cwd()) {
  const homeDir = env.HOME ?? os.homedir()
  /** @type {Set<string>} */
  const detected = new Set()
  await Promise.all(
    [...catalog.pickerDescriptors.values()].map(async (descriptor) => {
      const probe = descriptor.detect
      if (!probe) return
      try {
        if (await probeIsPresent(descriptor.id, probe, env, homeDir, cwd)) {
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
 *   home) exist? Unchanged behavior for `claude`/`codex`. It is
 *   home-relative by contract; an absolute one throws and lands in the
 *   caller's best-effort catch as "not present". A picker row that wants
 *   an absolute literal declares `app_bundle` or `path` instead - those
 *   variants exist precisely so `settings_file` never has to be absolute.
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
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function probeIsPresent(sourceId, probe, env, homeDir, cwd) {
  // @ref LLP 0554#picker-probes: bounded metadata probes do not execute clients or applications
  if ('vscode_extension' in probe) {
    const roots = env.VSCODE_PORTABLE
      ? [path.join(env.VSCODE_PORTABLE, 'extensions')]
      : env.VSCODE_EXTENSIONS ? [env.VSCODE_EXTENSIONS]
        : ['.vscode', '.vscode-insiders'].map(dir => path.join(homeDir, dir, 'extensions'))
    for (const root of roots) {
      const text = await readProbeFile(path.join(root, 'extensions.json'))
      if (!text) continue
      try {
        const entries = JSON.parse(text)
        if (Array.isArray(entries) && entries.some(entry =>
          typeof entry?.identifier?.id === 'string' && entry.identifier.id.toLowerCase() === probe.vscode_extension.toLowerCase())) return true
      } catch { /* A broken catalog is not installation evidence. */ }
    }
    return false
  }
  if ('project_dependencies' in probe) {
    const { npm, python } = probe.project_dependencies
    if (npm) {
      try {
        const pkg = JSON.parse(await readProbeFile(path.join(cwd, 'package.json')))
        if (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(key =>
          pkg?.[key] && typeof pkg[key] === 'object' && !Array.isArray(pkg[key]) &&
          Object.hasOwn(pkg[key], npm) && typeof pkg[key][npm] === 'string')) return true
      } catch { /* Continue to Python declarations. */ }
    }
    if (python) {
      const requirements = await readProbeFile(path.join(cwd, 'requirements.txt'))
      if (requirements.split(/\r?\n/).some(line => requirementNames(line.trim(), python))) return true
      return pyprojectDependencies(await readProbeFile(path.join(cwd, 'pyproject.toml')))
        .some(value => requirementNames(value, python))
    }
    return false
  }
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
 * Read at most 256 KiB from a regular file, even if it grows after stat.
 * No following symlinks, directory walks, subprocesses, or retained cache.
 * @param {string} file
 */
async function readProbeFile(file) {
  let handle
  try {
    handle = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 256 * 1024) return ''
    const buffer = Buffer.alloc(256 * 1024 + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    return size > 256 * 1024 ? '' : buffer.toString('utf8', 0, size)
  } catch { return '' } finally { await handle?.close() }
}

/** @param {string} value @param {string} wanted */
function requirementNames(value, wanted) {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?=\s|\[|[<>=!~;@]|$)/.exec(value)
  const normalize = (/** @type {string} */ name) => name.toLowerCase().replace(/[-_.]+/g, '-')
  return !!match && normalize(match[1]) === normalize(wanted)
}

/**
 * Recognize the standard [project] dependencies string array only. This is
 * deliberately a conservative subset, not a TOML parser: multiline strings,
 * escapes, dynamic metadata, Poetry and include files are not inspected.
 * @param {string} text
 * @returns {string[]}
 */
function pyprojectDependencies(text) {
  if (text.includes('"""') || text.includes("'''")) return []
  // Preserve quoted values while stripping comments outside them.
  const clean = text.replace(/"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|#[^\r\n]*/g, value => value.startsWith('#') ? '' : value)
  const section = /(?:^|\n)\[project\][ \t]*\r?\n([\s\S]*?)(?=\n\[[a-zA-Z"']|$)/.exec(clean)?.[1]
  if (!section) return []
  const assignment = /(?:^|\n)dependencies[ \t]*=[ \t]*\[/.exec(section)
  if (!assignment) return []
  const values = []
  let index = assignment.index + assignment[0].length
  // Parse once from the first assignment. Retrying an unterminated array at
  // every later assignment makes malformed input quadratic in file size.
  while (index < section.length) {
    while (/\s/.test(section[index] ?? 'x')) index++
    if (section[index] === ']') return values
    const quote = section[index]
    if (quote !== '"' && quote !== "'") return []
    const end = section.indexOf(quote, index + 1)
    if (end < 0) return []
    const value = section.slice(index + 1, end)
    if (/[\\\r\n]/.test(value)) return []
    values.push(value)
    index = end + 1
    while (/\s/.test(section[index] ?? 'x')) index++
    if (section[index] === ']') return values
    if (section[index++] !== ',') return []
  }
  return []
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
