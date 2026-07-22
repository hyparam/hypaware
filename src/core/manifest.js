// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger, withSpan } from './observability/index.js'
import { isPlainObject } from './util/json_util.js'

/**
 * @import { PluginManifest, PluginRequirements, PluginProvides, PluginPermission, PluginContributionManifest } from '../../hypaware-plugin-kernel-types.js'
 * @import { FailedManifest, LoadedManifest, ManifestErrorKind } from '../../src/core/types.js'
 */

const MANIFEST_BASENAME = 'hypaware.plugin.json'

/**
 * Read and validate the `hypaware.plugin.json` from a plugin directory.
 * Emits a `manifest.load` span carrying `hyp_plugin`, `hyp_manifest_path`,
 * `status`, and (on failure) `error_kind`. On failure also emits a
 * `manifest.reject` log so query callers can find rejections without
 * walking the trace tree.
 *
 * @param {string} rootDir
 * @returns {Promise<LoadedManifest|FailedManifest>}
 */
export async function loadManifest(rootDir) {
  const manifestPath = path.join(rootDir, MANIFEST_BASENAME)
  try {
    const manifest = await withSpan(
      'manifest.load',
      {
        [Attr.OPERATION]: 'manifest.load',
        hyp_manifest_path: manifestPath,
      },
      async (span) => {
        let raw
        try {
          raw = await fs.readFile(manifestPath, 'utf8')
        } catch (err) {
          const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
          const detail = code === 'ENOENT'
            ? `manifest not found at ${manifestPath}`
            : `failed to read manifest ${manifestPath}: ${describeError(err)}`
          throw newManifestError('manifest_invalid', detail)
        }

        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          throw newManifestError('manifest_invalid', `manifest is not valid JSON: ${describeError(err)}`)
        }

        const validation = validateManifest(parsed)
        if (!validation.ok) {
          throw newManifestError(validation.errorKind, validation.message)
        }

        span.setAttribute(Attr.PLUGIN, validation.manifest.name)
        span.setAttribute('status', 'ok')
        return validation.manifest
      },
      { component: 'manifest' }
    )
    return { ok: true, manifest, manifestPath, rootDir }
  } catch (err) {
    const errorKind = /** @type {ManifestErrorKind} */ (
      (err && /** @type {{hypErrorKind?: string}} */ (err).hypErrorKind) || 'manifest_invalid'
    )
    const message = err instanceof Error ? err.message : String(err)
    getLogger('manifest').error('manifest.reject', {
      hyp_manifest_path: manifestPath,
      [Attr.ERROR_KIND]: errorKind,
      message,
    })
    return { ok: false, errorKind, message, manifestPath, rootDir }
  }
}

/**
 * Load several manifests in parallel. The result splits into the loaded
 * and failed bins so callers can short-circuit dep resolution when any
 * manifest is invalid.
 *
 * @param {string[]} rootDirs
 * @returns {Promise<{ loaded: LoadedManifest[], failed: FailedManifest[] }>}
 */
export async function loadManifests(rootDirs) {
  const results = await Promise.all(rootDirs.map((d) => loadManifest(d)))
  /** @type {LoadedManifest[]} */
  const loaded = []
  /** @type {FailedManifest[]} */
  const failed = []
  for (const r of results) {
    if (r.ok) loaded.push(r)
    else failed.push(r)
  }
  return { loaded, failed }
}

/**
 * Pure validator over a parsed JSON value. Used directly by tests and
 * by `loadManifest`. Checks the V1 fields the kernel relies on; the
 * extended `contributes` block is accepted opaquely and validated by
 * the registries that consume it.
 *
 * @param {unknown} value
 * @returns {{ ok: true, manifest: PluginManifest } | { ok: false, errorKind: ManifestErrorKind, message: string }}
 * @ref LLP 0005#declarative [implements]: one manifest shape declares requires/provides/contributes; category is emergent, not a variant
 */
export function validateManifest(value) {
  if (!isPlainObject(value)) {
    return invalid('manifest must be a JSON object')
  }
  const m = /** @type {Record<string, unknown>} */ (value)
  if (m.schema_version !== 1) return invalid('schema_version must be 1')
  if (!isNonEmptyString(m.name)) return invalid('name (string) is required')
  if (!isNonEmptyString(m.version)) return invalid('version (string) is required')
  if (!isNonEmptyString(m.hypaware_api)) return invalid('hypaware_api (string semver range) is required')
  if (m.runtime !== 'node') return invalid("runtime must be 'node'")
  if (!isNonEmptyString(m.entrypoint)) return invalid('entrypoint (string) is required')
  if (m.description !== undefined && typeof m.description !== 'string') {
    return invalid('description must be a string when present')
  }
  if (m.node_engine !== undefined && typeof m.node_engine !== 'string') {
    return invalid('node_engine must be a string when present')
  }
  if (m.requires !== undefined) {
    if (!isPlainObject(m.requires)) return invalid('requires must be an object')
    const r = /** @type {Record<string, unknown>} */ (m.requires)
    if (r.plugins !== undefined && !isStringMap(r.plugins)) {
      return invalid('requires.plugins must be a map of plugin name -> semver range')
    }
    if (r.capabilities !== undefined && !isStringMap(r.capabilities)) {
      return invalid('requires.capabilities must be a map of capability name -> semver range')
    }
  }
  if (m.provides !== undefined) {
    if (!isPlainObject(m.provides)) return invalid('provides must be an object')
    const p = /** @type {Record<string, unknown>} */ (m.provides)
    if (p.capabilities !== undefined && !isStringMap(p.capabilities)) {
      return invalid('provides.capabilities must be a map of capability name -> version')
    }
  }
  if (m.permissions !== undefined && !isStringArray(m.permissions)) {
    return invalid('permissions must be a string array')
  }
  if (m.contributes !== undefined && !isPlainObject(m.contributes)) {
    return invalid('contributes must be an object when present')
  }
  if (isPlainObject(m.contributes)) {
    const pickerCheck = validatePickerContributions(
      /** @type {Record<string, unknown>} */ (m.contributes).picker
    )
    if (!pickerCheck.ok) return pickerCheck
  }
  /** @type {PluginManifest} */
  const manifest = {
    schema_version: 1,
    name: m.name,
    version: m.version,
    hypaware_api: m.hypaware_api,
    runtime: 'node',
    entrypoint: m.entrypoint,
  }
  if (typeof m.description === 'string') manifest.description = m.description
  if (typeof m.node_engine === 'string') manifest.node_engine = m.node_engine
  if (isPlainObject(m.requires)) manifest.requires = /** @type {PluginRequirements} */ (m.requires)
  if (isPlainObject(m.provides)) manifest.provides = /** @type {PluginProvides} */ (m.provides)
  if (isStringArray(m.permissions)) manifest.permissions = /** @type {PluginPermission[]} */ (m.permissions)
  if (isPlainObject(m.contributes)) manifest.contributes = /** @type {PluginContributionManifest} */ (m.contributes)
  return { ok: true, manifest }
}

/**
 * Recognized `PickerDetectProbe` variant keys. Exactly one must be
 * present, carrying a non-empty string path.
 * @ref LLP 0130#picker-block: the declarative picker probe variants.
 */
const PICKER_PROBE_KEYS = ['settings_file', 'app_bundle', 'path']

/**
 * Validate `contributes.picker`. It is optional; when present it must be
 * an array of picker rows, each with a `label` string and, optionally, a
 * `summary` string, a single-variant `detect` probe, a `needs_setup`
 * boolean, and a `configure_command` string. Unknown fields are accepted
 * (kept opaque like the rest of the `contributes` block) so later
 * additions such as `compose` pass through untouched.
 *
 * @param {unknown} picker
 * @returns {{ ok: true } | { ok: false, errorKind: ManifestErrorKind, message: string }}
 */
function validatePickerContributions(picker) {
  if (picker === undefined) return { ok: true }
  if (!Array.isArray(picker)) {
    return invalid('contributes.picker must be an array when present')
  }
  for (const row of picker) {
    if (!isPlainObject(row)) {
      return invalid('contributes.picker entries must be objects')
    }
    const r = /** @type {Record<string, unknown>} */ (row)
    if (!isNonEmptyString(r.label)) {
      return invalid('contributes.picker entries require a label (string)')
    }
    if (r.summary !== undefined && typeof r.summary !== 'string') {
      return invalid('contributes.picker summary must be a string when present')
    }
    if (r.needs_setup !== undefined && typeof r.needs_setup !== 'boolean') {
      return invalid('contributes.picker needs_setup must be a boolean when present')
    }
    if (r.configure_command !== undefined && typeof r.configure_command !== 'string') {
      return invalid('contributes.picker configure_command must be a string when present')
    }
    if (r.detect !== undefined) {
      const detectCheck = validatePickerProbe(r.detect)
      if (!detectCheck.ok) return detectCheck
    }
  }
  return { ok: true }
}

/**
 * Validate a single `PickerDetectProbe`: a plain object carrying exactly
 * one recognized variant key (`settings_file` / `app_bundle` / `path`)
 * whose value is a non-empty string.
 *
 * @param {unknown} detect
 * @returns {{ ok: true } | { ok: false, errorKind: ManifestErrorKind, message: string }}
 */
function validatePickerProbe(detect) {
  if (!isPlainObject(detect)) {
    return invalid('contributes.picker detect must be an object when present')
  }
  const d = /** @type {Record<string, unknown>} */ (detect)
  const present = PICKER_PROBE_KEYS.filter((k) => d[k] !== undefined)
  if (present.length !== 1) {
    return invalid(
      `contributes.picker detect must set exactly one of ${PICKER_PROBE_KEYS.join(', ')}`
    )
  }
  if (!isNonEmptyString(d[present[0]])) {
    return invalid(`contributes.picker detect.${present[0]} must be a non-empty string`)
  }
  return { ok: true }
}

/**
 * @param {ManifestErrorKind} errorKind
 * @param {string} message
 */
function newManifestError(errorKind, message) {
  const err = /** @type {Error & { hypErrorKind?: string }} */ (new Error(message))
  err.hypErrorKind = errorKind
  return err
}

/** @param {string} message */
function invalid(message) {
  return /** @type {const} */ ({ ok: false, errorKind: 'manifest_invalid', message })
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}
/** @param {unknown} v */
function isStringMap(v) {
  if (!isPlainObject(v)) return false
  for (const value of Object.values(/** @type {Record<string, unknown>} */ (v))) {
    if (typeof value !== 'string') return false
  }
  return true
}

/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** @param {unknown} err */
function describeError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}
