// @ts-check

import { isPlainObject } from '../util/json_util.js'

/**
 * The ownership test for a `json_path` provider entry, shared by the three
 * sides that have to agree about it: the plugin's `attach()` (which overwrites
 * its own entry and refuses over anyone else's), core's `detachClientFromDisk`
 * (which deletes its own entry and backs up anyone else's), and the read-only
 * ownership probes either side runs. Kept in one module rather than copied,
 * because the failure mode of the halves drifting apart is asymmetric and
 * silent: attach would refuse to rewrite an entry detach is happy to delete,
 * or delete-on-detach an entry attach believes is the user's.
 *
 * The entry attach writes is self-identifying by construction: a marker header
 * naming the provider key it sits at, a `baseUrl` string, and the empty
 * `models` array OpenClaw's schema requires. Nothing else writes that triple -
 * the marker header is HypAware's own name. That signature is the whole test,
 * on both sides: attach has always trusted it alone (a re-attach after an
 * ephemeral-port rebind overwrites an entry carrying the *old* origin, so a
 * URL check there would break every re-attach-on-drift), and detach now
 * matches it, so the undo reads everything it needs off the settings file
 * itself, like every other format. An origin comparison would add nothing the
 * signature does not already say, and it would make the undo depend on a fact
 * (the gateway's live base URL) that dies with the daemon.
 *
 * @ref LLP 0167#attach-detach [implements]: one ownership predicate behind both
 *   halves, so "is this entry ours" has a single answer
 * @ref LLP 0210#d1 [implements]: the signature is the whole ownership test; no
 *   origin comparison, so detach needs no live gateway fact
 */

/**
 * Whether a provider entry is one this gateway wrote: its marker header names
 * its own key, and its shape is the one attach produces (a `baseUrl` string
 * and an empty `models` array). Every other outcome (a missing or renamed
 * marker header, a hand-edited `models` list, no `baseUrl` at all) is somebody
 * else's entry that merely sits at our key.
 *
 * @param {unknown} entry
 * @param {string} key
 * @param {string} markerHeader
 * @returns {boolean}
 */
export function isOwnedProviderEntry(entry, key, markerHeader) {
  if (!isPlainObject(entry)) return false
  if (typeof entry.baseUrl !== 'string') return false
  const headers = entry.headers
  if (!isPlainObject(headers) || headers[markerHeader] !== key) return false
  return Array.isArray(entry.models) && entry.models.length === 0
}
