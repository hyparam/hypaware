// @ts-check

import { createHash } from 'node:crypto'

/**
 * Deterministic, content-addressed graph ids. The same (type, key) always
 * hashes to the same id, which is what makes re-projection idempotent: a
 * node/edge already committed under its id is skipped by the pre-write
 * dedup (see project.js), and even without that, identical rows collapse
 * during cache compaction.
 *
 * Hash-input segments are joined with NUL (`\0`, written as the
 * two-character escape so this file stays plain text): NUL cannot appear
 * in the JS strings fed in here, so the join is collision-free, no
 * (type, key) pair can be confused with another by crafting keys that
 * contain the delimiter. Changing the delimiter changes every id, which
 * would orphan all committed graph rows; test/plugins/context-graph-ids.test.js
 * pins known digests to catch that.
 *
 * @param {string} value
 * @returns {string}
 * @ref LLP 0023#content-addressed-ids [implements]: changing the recipe orphans every committed graph row
 */
function sha(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

/**
 * @param {string} type
 * @param {string} naturalKey
 * @returns {string}
 */
export function nodeId(type, naturalKey) {
  return sha(`node\0${type}\0${naturalKey}`)
}

/**
 * @param {string} srcId
 * @param {string} type
 * @param {string} dstId
 * @returns {string}
 */
export function edgeId(srcId, type, dstId) {
  return sha(`edge\0${srcId}\0${type}\0${dstId}`)
}
