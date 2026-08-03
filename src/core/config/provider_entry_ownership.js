// @ts-check

import { isPlainObject } from '../util/json_util.js'

/**
 * The ownership test for a `json_path` provider entry, shared by the two sides
 * that have to agree about it: the plugin's `attach()` (which overwrites its
 * own entry and refuses over anyone else's) and core's `detachClientFromDisk`
 * (which deletes its own entry and backs up anyone else's). Kept in one module
 * rather than copied, because the failure mode of the two drifting apart is
 * asymmetric and silent: attach would refuse to rewrite an entry detach is
 * happy to delete, or delete-on-detach an entry attach believes is the user's.
 *
 * The entry attach writes is self-identifying by construction: the gateway
 * origin in `baseUrl`, a marker header naming the provider key it sits at, and
 * the empty `models` array OpenClaw's schema requires. Nothing else writes that
 * triple - the marker header is HypAware's own name.
 *
 * @ref LLP 0167#attach-detach [implements]: one ownership predicate behind both
 *   halves, so "is this entry ours" has a single answer
 */

/**
 * The two `baseUrl` spellings a `json_path` attach writes for one gateway
 * origin, or `undefined` when the origin is unknown. Trailing slashes are
 * trimmed on the way in for the same reason attach trims them: `+ '/v1'` on a
 * slash-terminated origin is a different string that names the same URL, and
 * the comparison here is textual.
 *
 * @param {string | undefined} expectedBaseUrl
 * @returns {Set<string> | undefined}
 */
export function ownedBaseUrls(expectedBaseUrl) {
  if (typeof expectedBaseUrl !== 'string') return undefined
  const origin = expectedBaseUrl.trim().replace(/\/+$/, '')
  if (origin.length === 0) return undefined
  return new Set([origin, `${origin}/v1`])
}

/**
 * Whether a provider entry is one this gateway wrote: its marker header names
 * its own key, its shape is the one attach produces (a `baseUrl` string and an
 * empty `models` array), and - when `ours` is given - it points at one of the
 * gateway's own origins. Every other outcome (a missing or renamed marker
 * header, a hand-edited `models` list, no `baseUrl` at all) is somebody else's
 * entry that merely sits at our key.
 *
 * `ours` is `undefined` only on the **attach** side, and deliberately so: attach
 * re-runs precisely when the endpoint has moved (an ephemeral-port rebind,
 * LLP 0086), so the entry it is about to overwrite carries the *old* origin by
 * construction and pinning the check to the live one would make every
 * re-attach-on-drift refuse. Overwriting our own entry with a fresh URL is what
 * that pass is for, and it destroys nothing the user authored. **Detach** always
 * passes the set, because there the wrong answer deletes a value HypAware never
 * wrote (`detachJsonPathProviders` refuses outright rather than run without it).
 *
 * @param {unknown} entry
 * @param {string} key
 * @param {string} markerHeader
 * @param {Set<string> | undefined} ours  gateway origins, or `undefined` to accept any `baseUrl`
 * @returns {boolean}
 */
export function isOwnedProviderEntry(entry, key, markerHeader, ours) {
  if (!isPlainObject(entry)) return false
  if (typeof entry.baseUrl !== 'string') return false
  if (ours !== undefined && !ours.has(entry.baseUrl)) return false
  const headers = entry.headers
  if (!isPlainObject(headers) || headers[markerHeader] !== key) return false
  return Array.isArray(entry.models) && entry.models.length === 0
}
