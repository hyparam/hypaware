// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson } from '../../../../src/core/util/fs_atomic.js'

/**
 * @import { DatasetRolloutRecord, DatasetRolloutStore } from './types.js'
 * @import { PluginPaths } from '../../../../hypaware-plugin-kernel-types.js'
 */

const RECORD_VERSION = 1
const ROLLOUTS_DIR = 'open-dataset-rollouts'

/**
 * Persist the set of logical partitions that belonged to an open dataset when
 * central forwarding was enabled, or were durably admitted later. Record
 * absence means rollout has not been initialized. A malformed record throws:
 * it must never be confused with a first rollout and silently move a baseline.
 *
 * @param {{ paths: PluginPaths, instanceName: string }} opts
 * @returns {DatasetRolloutStore}
 */
// @ref LLP 0307#durable-manifest [implements]: store one atomic rollout manifest beside each sink instance's watermarks
export function createDatasetRolloutStore({ paths, instanceName }) {
  if (!paths?.stateDir) throw new Error('createDatasetRolloutStore: paths.stateDir is required')
  if (!instanceName) throw new Error('createDatasetRolloutStore: instanceName is required')
  const root = path.join(
    paths.stateDir,
    'sink-instances',
    sanitizeInstance(instanceName),
    ROLLOUTS_DIR
  )

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
