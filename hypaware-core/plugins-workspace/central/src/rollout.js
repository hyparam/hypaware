// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson } from '../../../../src/core/util/fs_atomic.js'
import { sha256Hex } from 'hypaware/core/util'

/**
 * @import { BoundDestinationState, DatasetRolloutRecord, DatasetRolloutStore, DestinationBindingRecord, RemoteDestination } from './types.js'
 * @import { PluginPaths } from '../../../../hypaware-plugin-kernel-types.js'
 */

const RECORD_VERSION = 1
const ROLLOUTS_DIR = 'open-dataset-rollouts'
const SINK_INSTANCES_DIR = 'sink-instances'
const DESTINATIONS_DIR = 'destinations'
const DESTINATION_BINDING_FILE = 'destination.json'

/**
 * Select the durable state scope for one authenticated remote destination.
 * The first destination owns the historical unscoped instance directory so
 * existing installations can adopt their current progress without replay.
 * Later destinations use deterministic hashed subdirectories, while returning
 * to either destination finds the same scope again.
 *
 * A scope with no prior progress is bound in `initializing-history` before any
 * rollout watermark is written. A crash therefore resumes retained-history
 * initialization instead of falling back to the software-rollout baseline.
 *
 * @ref LLP 0315#destination-identity [implements]: export progress is scoped by server origin and organization, not by sink name or gateway credential
 * @ref LLP 0315#rollout-distinction [implements]: the durable phase distinguishes a new destination replay from an existing-destination dataset rollout
 * @param {{ paths: PluginPaths, instanceName: string, destination: RemoteDestination }} opts
 * @returns {Promise<BoundDestinationState>}
 */
export async function bindDestinationState({ paths, instanceName, destination }) {
  if (!paths?.stateDir) throw new Error('bindDestinationState: paths.stateDir is required')
  if (!instanceName) throw new Error('bindDestinationState: instanceName is required')
  const normalized = normalizeDestination(destination)
  const baseStateDir = path.join(paths.stateDir, SINK_INSTANCES_DIR, sanitizeInstance(instanceName))
  const baseBinding = await readDestinationBinding(baseStateDir)

  if (baseBinding && sameDestination(baseBinding.destination, normalized)) {
    return {
      stateDir: baseStateDir,
      destination: normalized,
      phase: baseBinding.phase,
      adoptedLegacy: false,
    }
  }

  if (!baseBinding) {
    const adoptedLegacy = await hasLegacyProgress(baseStateDir)
    const phase = adoptedLegacy ? 'ready' : 'initializing-history'
    await writeDestinationBinding(baseStateDir, normalized, phase, null)
    return { stateDir: baseStateDir, destination: normalized, phase, adoptedLegacy }
  }

  const destinationHash = sha256Hex(JSON.stringify([normalized.origin, normalized.org])).slice(0, 32)
  const stateDir = path.join(baseStateDir, DESTINATIONS_DIR, destinationHash)
  const scopedBinding = await readDestinationBinding(stateDir)
  if (scopedBinding && !sameDestination(scopedBinding.destination, normalized)) {
    throw new Error('central.forward: destination state hash collision')
  }
  if (!scopedBinding) {
    await writeDestinationBinding(stateDir, normalized, 'initializing-history', null)
  }
  return {
    stateDir,
    destination: normalized,
    phase: scopedBinding?.phase ?? 'initializing-history',
    adoptedLegacy: false,
  }
}

/**
 * Mark retained-history rollout initialization complete for a destination.
 * The binding is re-read before the write so a corrupt or mismatched record
 * cannot be silently replaced.
 *
 * @param {BoundDestinationState} bound
 * @returns {Promise<BoundDestinationState>}
 */
export async function markDestinationStateReady(bound) {
  const current = await readDestinationBinding(bound.stateDir)
  if (!current || !sameDestination(current.destination, bound.destination)) {
    throw new Error('central.forward: destination binding changed during initialization')
  }
  if (current.phase !== 'ready') {
    await writeDestinationBinding(bound.stateDir, bound.destination, 'ready', current)
  }
  return { ...bound, phase: 'ready' }
}

/**
 * Persist the set of logical partitions that belonged to an open dataset when
 * central forwarding was enabled, or were durably admitted later. Record
 * absence means rollout has not been initialized. A malformed record throws:
 * it must never be confused with a first rollout and silently move a baseline.
 *
 * @param {{ paths?: PluginPaths, instanceName?: string, stateDir?: string }} opts
 * @returns {DatasetRolloutStore}
 */
// @ref LLP 0307#durable-manifest [implements]: store one atomic rollout manifest beside each sink instance's watermarks
export function createDatasetRolloutStore({ paths, instanceName, stateDir }) {
  if (!stateDir && !paths?.stateDir) throw new Error('createDatasetRolloutStore: paths.stateDir is required')
  if (!stateDir && !instanceName) throw new Error('createDatasetRolloutStore: instanceName is required')
  const instanceStateDir = stateDir ?? path.join(
    /** @type {PluginPaths} */ (paths).stateDir,
    SINK_INSTANCES_DIR,
    sanitizeInstance(/** @type {string} */ (instanceName))
  )
  const root = path.join(instanceStateDir, ROLLOUTS_DIR)

  /** @param {string} dataset */
  function filePath(dataset) {
    return path.join(root, `${sanitizeDataset(dataset)}.json`)
  }

  return {
    filePath,

    async read(dataset) {
      let raw
      try {
        raw = await fs.readFile(filePath(dataset), 'utf8')
      } catch (err) {
        if (err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT') {
          return null
        }
        throw err
      }

      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        throw new Error(`central.forward: rollout state for '${dataset}' is corrupt`, { cause: err })
      }
      if (
        parsed?.v !== RECORD_VERSION ||
        !Array.isArray(parsed.partitions) ||
        parsed.partitions.some((key) => typeof key !== 'string' || key.length === 0) ||
        typeof parsed.initializedAt !== 'string' ||
        typeof parsed.updatedAt !== 'string'
      ) {
        throw new Error(`central.forward: rollout state for '${dataset}' is invalid`)
      }
      let partitionKeys
      try {
        partitionKeys = parsed.partitions.map((key) => safePartitionKey(key))
      } catch (err) {
        throw new Error(`central.forward: rollout state for '${dataset}' is invalid`, { cause: err })
      }
      return {
        v: RECORD_VERSION,
        partitions: [...new Set(partitionKeys)].sort(),
        initializedAt: parsed.initializedAt,
        updatedAt: parsed.updatedAt,
      }
    },

    async write(dataset, partitionKeys, previous) {
      const now = new Date().toISOString()
      /** @type {DatasetRolloutRecord} */
      const record = {
        v: RECORD_VERSION,
        partitions: [...new Set(partitionKeys.map((key) => safePartitionKey(key)))].sort(),
        initializedAt: previous?.initializedAt ?? now,
        updatedAt: now,
      }
      await atomicWriteJson(filePath(dataset), record)
      return record
    },
  }
}

/** @param {RemoteDestination} destination */
function normalizeDestination(destination) {
  if (!destination || typeof destination.org !== 'string') {
    throw new Error('central.forward: destination org must be a string')
  }
  let origin
  try {
    origin = new URL(destination.origin).origin
  } catch {
    throw new Error(`central.forward: destination origin '${destination.origin}' is invalid`)
  }
  if (origin === 'null') {
    throw new Error(`central.forward: destination origin '${destination.origin}' is invalid`)
  }
  return { origin, org: destination.org }
}

/** @param {RemoteDestination} left @param {RemoteDestination} right */
function sameDestination(left, right) {
  return left.origin === right.origin && left.org === right.org
}

/**
 * @param {string} stateDir
 * @returns {Promise<DestinationBindingRecord | null>}
 */
async function readDestinationBinding(stateDir) {
  const filePath = path.join(stateDir, DESTINATION_BINDING_FILE)
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT') return null
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error('central.forward: destination binding is corrupt', { cause: err })
  }
  if (
    parsed?.v !== RECORD_VERSION ||
    typeof parsed.destination?.origin !== 'string' ||
    typeof parsed.destination?.org !== 'string' ||
    (parsed.phase !== 'initializing-history' && parsed.phase !== 'ready') ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string'
  ) {
    throw new Error('central.forward: destination binding is invalid')
  }
  const destination = normalizeDestination(parsed.destination)
  return {
    v: RECORD_VERSION,
    destination,
    phase: parsed.phase,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  }
}

/**
 * @param {string} stateDir
 * @param {RemoteDestination} destination
 * @param {DestinationBindingRecord['phase']} phase
 * @param {DestinationBindingRecord | null} previous
 */
async function writeDestinationBinding(stateDir, destination, phase, previous) {
  const now = new Date().toISOString()
  /** @type {DestinationBindingRecord} */
  const record = {
    v: RECORD_VERSION,
    destination,
    phase,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  await atomicWriteJson(path.join(stateDir, DESTINATION_BINDING_FILE), record)
  return record
}

/**
 * Legacy progress is any prior watermark or rollout entry. Directory presence
 * alone is not enough because constructors may create empty state directories.
 *
 * @param {string} stateDir
 */
async function hasLegacyProgress(stateDir) {
  for (const name of ['watermarks', ROLLOUTS_DIR]) {
    try {
      const entries = await fs.readdir(path.join(stateDir, name), { recursive: true })
      if (entries.length > 0) return true
    } catch (err) {
      if (err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT') continue
      throw err
    }
  }
  return false
}

/** @param {string} name */
function sanitizeInstance(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.length > 0 ? cleaned : '_instance'
}

/** @param {string} dataset */
function sanitizeDataset(dataset) {
  if (typeof dataset !== 'string' || dataset.length === 0) {
    throw new Error('central.forward: rollout dataset must be non-empty')
  }
  const cleaned = dataset.replace(/[^A-Za-z0-9._=,-]/g, '_')
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : '_dataset'
}

/**
 * @param {string} value
 * @param {string} field
 */
function safeSegment(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..') {
    throw new Error(`central.forward: rollout ${field} must be a safe non-empty segment`)
  }
  if (!/^[A-Za-z0-9._=,-]+$/.test(value)) {
    throw new Error(`central.forward: rollout ${field} '${value}' is not sanitized`)
  }
  return value
}

/** @param {string} key */
function safePartitionKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('central.forward: rollout partition key must be non-empty')
  }
  const segments = key.split('/')
  for (const segment of segments) safeSegment(segment, 'partition key')
  return segments.join('/')
}
