// @ts-check

/**
 * Cache maintenance partitions that were skipped: summarized when the daemon
 * records them and read back for `hyp status`.
 *
 * @import { DaemonStatus, MaintenanceSkippedPartition, MaintenanceSkipReason, MaintenanceSkipSnapshot } from '../../../../src/core/daemon/types.js'
 * @import { MaintenancePartitionReport, MaintenanceReport } from '../../../../src/core/cache/types.js'
 */

import { isPlainObject, sanitizeLabel } from '../../util/json_util.js'
import { nonNegativeInt } from './values.js'

/**
 * How many skipped partitions the standing surface names. The counts beside
 * the list are exact, so this bounds the terminal block and the status file
 * without hiding the size of the problem; `hyp query maintain` is where an
 * operator enumerates every one. Eight is a screenful, and a cache with more
 * than eight frozen partitions has a story the count already tells.
 */
export const MAX_SKIPPED_PARTITIONS_REPORTED = 8

/** Every reason id, in the order the render lists them. */
const MAINTENANCE_SKIP_REASONS = Object.freeze(
  /** @type {MaintenanceSkipReason[]} */ (['compaction_ineffective', 'compaction_attempt_failed'])
)

/**
 * The reason breakdown as one phrase, e.g. `2 compaction_ineffective, 1
 * compaction_attempt_failed`. Reasons no partition was skipped for are left
 * out rather than printed as zeros, and the ids are printed verbatim: they
 * are the span attribute names, so this phrase is also the trace query
 * (LLP 0228#reason-ids-are-span-attribute-names).
 *
 * Both call sites interpolate this unconditionally into a sentence that
 * already committed to a parenthetical, so an empty phrase would render as a
 * bare `()`. That is unreachable from a snapshot this build wrote (every
 * skip has one of the two known reasons by construction), but not from a
 * `status.json` a later build wrote: LLP 0228#consequences names a third
 * reason id as exactly the kind of extension this shape absorbs, and a
 * snapshot whose only nonzero reasons are ones this build does not
 * recognize is precisely `skippedTotal > 0` with every known count at zero.
 * The fallback names that case instead of leaving the parenthetical empty.
 *
 * @param {Record<MaintenanceSkipReason, number>} reasons
 * @returns {string}
 */
export function describeMaintenanceSkipReasons(reasons) {
  const phrase = MAINTENANCE_SKIP_REASONS
    .filter((reason) => (reasons[reason] ?? 0) > 0)
    .map((reason) => `${reasons[reason]} ${reason}`)
    .join(', ')
  return phrase === '' ? 'reasons this build does not recognize' : phrase
}

/**
 * The partition tuple as one label: exactly the shape `hyp query maintain`
 * prints after the dataset name, so the same partition reads identically on
 * both surfaces.
 *
 * @param {Record<string, string> | undefined} partition
 * @returns {string}
 */
function partitionLabel(partition) {
  if (!isPlainObject(partition)) return 'all'
  const parts = Object.entries(partition)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}=${v}`)
  return parts.length > 0 ? parts.join('/') : 'all'
}

/**
 * Why this tick left the partition fragmented, or undefined when it did not.
 *
 * A partition the tick *rewrote* is not on this surface even when the rewrite
 * achieved nothing: that is a run that did work, and the verdict it recorded
 * puts the partition on the next tick's snapshot as a skip. What this names is
 * the standing state, the partition the kernel has stopped rewriting.
 *
 * @param {MaintenancePartitionReport} p
 * @returns {MaintenanceSkipReason | undefined}
 * @ref LLP 0218#verdict-outranks-error [constrained-by]: maintenance already makes the two mutually exclusive, so this order only has to agree about which one a reader is owed if that ever stops holding
 */
function skipReasonOf(p) {
  if (p.compacted || p.rebaselined) return undefined
  if (p.compactionIneffective) return 'compaction_ineffective'
  if (p.compactionAttemptFailed) return 'compaction_attempt_failed'
  return undefined
}

/**
 * Summarize a maintenance tick's report into the snapshot the daemon persists
 * (`DaemonStatus.maintenance`). Pure, and deliberately cheap: it reads the
 * report the walk already produced and stats nothing, because proving a
 * skipped partition is also still fragmented is the per-tick cost the LLP 0199
 * baseline gate exists to avoid.
 *
 * A tick that skipped nothing still produces a snapshot (all-zero counts, an
 * empty list). The snapshot is the *current* answer, so a partition that
 * thawed has to be able to leave it.
 *
 * @param {MaintenanceReport} report
 * @param {{ at?: string }} [opts]
 * @returns {MaintenanceSkipSnapshot}
 * @ref LLP 0228#last-tick-only [implements]: one bounded snapshot per tick, named partitions capped and taken in the walk's own neediest-first order
 */
export function summarizeMaintenanceSkips(report, opts = {}) {
  const visited = Array.isArray(report?.partitions) ? report.partitions : []
  /** @type {Record<MaintenanceSkipReason, number>} */
  const reasons = { compaction_ineffective: 0, compaction_attempt_failed: 0 }
  /** @type {MaintenanceSkippedPartition[]} */
  const partitions = []
  let skippedTotal = 0
  for (const p of visited) {
    const reason = skipReasonOf(p)
    if (reason === undefined) continue
    reasons[reason] += 1
    skippedTotal += 1
    // No sort: the report is already in walk order, which is descending live
    // data-file count (LLP 0199#neediest-first), so the first entries past the
    // cap are the most fragmented ones by construction.
    if (partitions.length >= MAX_SKIPPED_PARTITIONS_REPORTED) continue
    partitions.push({
      // Sanitized here too, not only on read: LLP 0228#last-tick-only says the
      // cap and the sanitizing are both re-applied on read, which only holds
      // if the write side already produced a clean label. `dataset` and
      // `partition` are kernel-side identifiers in the ordinary case, but
      // `partition`'s values come off a captured row's `client_name` by way
      // of `resolveSourceSegments` -> `sanitizePathSegment`, which strips only
      // path-hostile bytes and applies no length clamp or bidi/zero-width
      // filtering. Unsanitized here, the daemon log line at
      // `runtime.js`'s `worst` field (which reads `partitions[0]` straight)
      // would be the one surface on this path with nothing downstream to
      // clean it.
      // @ref LLP 0228#last-tick-only [implements]: the write side sanitizes and clamps, not only the read side
      dataset: sanitizeLabel(p.dataset) ?? 'unknown',
      partition: sanitizeLabel(partitionLabel(p.partition)) ?? 'all',
      reason,
      // The count the recorded rewrite ran over, not the live one: the same
      // distinction `hyp query maintain` draws, for the same reason.
      ...(reason === 'compaction_ineffective' && typeof p.compactionIneffectiveFiles === 'number'
        ? { dataFiles: p.compactionIneffectiveFiles }
        : {}),
      ...(reason === 'compaction_attempt_failed' && typeof p.compactionAttemptFailedAt === 'string'
        ? { failedAt: p.compactionAttemptFailedAt }
        : {}),
    })
  }
  return {
    tickAt: opts.at ?? new Date().toISOString(),
    partitionsVisited: visited.length,
    skippedTotal,
    reasons,
    partitions,
  }
}

/**
 * Lift the maintenance snapshot out of a status file, or null when no daemon
 * has reported a tick for this state root.
 *
 * Validated, sanitized and re-capped on read as well as on write, for the
 * reason `recentEntrypointsFromSources` states: `status.json` is a file, this
 * build did not necessarily write it, and everything here is about to be
 * printed to a terminal. Dataset and partition labels are the only free-form
 * strings on the path and both are kernel-side identifiers, but they are
 * cleaned anyway rather than trusted.
 *
 * Not liveness-gated, for LLP 0164's reason: "these partitions were frozen as
 * of the tick at T" stays true after the daemon exits, and the rendered age
 * carries the staleness.
 *
 * @param {DaemonStatus | null} status
 * @returns {MaintenanceSkipSnapshot | null}
 * @ref LLP 0228#status-file-is-the-surface [implements]: hyp status answers from status.json rather than running a second maintenance walk
 */
export function maintenanceSkipsFromStatus(status) {
  const raw = status?.maintenance
  if (!isPlainObject(raw)) return null
  const tickAt = raw.tickAt
  // No timestamp, no snapshot: every render of this block is relative to when
  // the tick ran, and "frozen, at some unknown time" is not worth printing.
  if (typeof tickAt !== 'string' || Number.isNaN(Date.parse(tickAt))) return null

  const rawReasons = isPlainObject(raw.reasons) ? raw.reasons : {}
  /** @type {Record<MaintenanceSkipReason, number>} */
  const reasons = { compaction_ineffective: 0, compaction_attempt_failed: 0 }
  for (const reason of MAINTENANCE_SKIP_REASONS) {
    reasons[reason] = nonNegativeInt(rawReasons[reason]) ?? 0
  }

  /** @type {MaintenanceSkippedPartition[]} */
  const partitions = []
  const rawPartitions = Array.isArray(raw.partitions) ? raw.partitions : []
  for (const item of rawPartitions) {
    if (partitions.length >= MAX_SKIPPED_PARTITIONS_REPORTED) break
    if (!isPlainObject(item)) continue
    const reason = item.reason
    // An unknown reason id is dropped rather than printed: a name this build
    // cannot explain is worse than a shorter list, and the counts above still
    // account for it.
    if (typeof reason !== 'string' || !MAINTENANCE_SKIP_REASONS.includes(/** @type {MaintenanceSkipReason} */ (reason))) continue
    const dataset = sanitizeLabel(item.dataset)
    const partition = sanitizeLabel(item.partition)
    if (dataset === undefined || partition === undefined) continue
    const dataFiles = nonNegativeInt(item.dataFiles)
    const failedAt = sanitizeLabel(item.failedAt)
    partitions.push({
      dataset,
      partition,
      reason: /** @type {MaintenanceSkipReason} */ (reason),
      ...(dataFiles !== undefined ? { dataFiles } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
    })
  }

  // Each count is floored at the partitions this list names for it: a foreign
  // file with zeroed `reasons` beside named `compaction_ineffective` entries
  // would otherwise render "reasons this build does not recognize" directly
  // above lines this build does recognize (issue #764). A snapshot this build
  // wrote counts every skip and names at most a capped subset, so the floor
  // is a no-op there.
  /** @type {Record<MaintenanceSkipReason, number>} */
  const named = { compaction_ineffective: 0, compaction_attempt_failed: 0 }
  for (const p of partitions) named[p.reason]++
  let reasonsTotal = 0
  for (const reason of MAINTENANCE_SKIP_REASONS) {
    reasons[reason] = Math.max(reasons[reason], named[reason])
    reasonsTotal += reasons[reason]
  }

  // Floored at both the capped list and the reasons it reports: a total below
  // either renders a sentence no tick could produce, "2 partitions" above
  // three lines of them, or "0 partitions fragmented (2
  // compaction_attempt_failed)" (issue #2360). A snapshot this build wrote
  // has the total at exactly the reason sum, so both floors are no-ops there.
  const skippedTotal = Math.max(nonNegativeInt(raw.skippedTotal) ?? 0, reasonsTotal, partitions.length)
  return {
    tickAt,
    // Floored at the skipped total: "visited" can never be smaller than
    // "skipped", or the render says "5 of 0 partitions" for a snapshot no
    // tick could have produced. A file this build did not write can claim
    // whatever it wants here, so the floor is enforced rather than trusted.
    partitionsVisited: Math.max(nonNegativeInt(raw.partitionsVisited) ?? 0, skippedTotal),
    skippedTotal,
    reasons,
    partitions,
  }
}
