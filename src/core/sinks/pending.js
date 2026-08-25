// @ts-check

import { instanceWatermarkStateDir } from './incremental.js'
import { pluginStateDir } from '../runtime/paths.js'
import { createSinkWatermarkStore } from './watermarks.js'

/**
 * @import { HypAwareV2Config, QueryPartition, QueryRegistry } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExtendedSinkHandle } from '../../../src/core/registry/types.js'
 * @import { PendingPreviewOptions, PendingVolume } from '../../../src/core/sinks/types.js'
 */

/**
 * Rows one destination's count may scan before it reports a floor instead of an
 * exact total. Generous, because the answer is worth having; bounded, because
 * this runs in front of a prompt somebody is waiting at.
 */
const DEFAULT_ROW_LIMIT = 200000

/**
 * Wall-clock budget for the whole preview, shared across destinations. The row
 * limit bounds work, this bounds *waiting*: a cold page cache makes a small
 * backlog slow, and a consent prompt that looks hung is its own bug (#976).
 */
const DEFAULT_BUDGET_MS = 3000

/** How often the row loop checks the clock. Cheap, but not free. */
const CLOCK_CHECK_EVERY = 512

/**
 * Count what is queued for each destination, so `hyp sync` can say how much
 * leaves and how far back it reaches before it asks for consent.
 *
 * This walks the same seam the export walks - the per-`(sink instance,
 * partition)` watermark plus `storage.readRowsSince(tablePath, { since })` - so
 * the number quoted at the prompt is derived from the cursor that decides what
 * actually ships, not from a second, drifting notion of "pending".
 *
 * Three rules make the result safe to put in front of a consent decision:
 *
 * 1. **Withheld rows are counted separately, never folded in.** A dropped entry
 *    (a `local-only` directory, an opted-out source) advances the cursor but
 *    never ships, so counting it as pending would overstate the egress and
 *    counting it nowhere would hide a 100%-withhold from the one person looking
 *    at the sync path.
 * 2. **A count that ran out of budget is a floor, never a total.** `truncated`
 *    says so, and the caller renders "at least N".
 * 3. **A count that could not be taken is `unknown`, never `0`.** A false zero
 *    on a consent prompt is worse than an admitted gap.
 *
 * Nothing here writes: no flush, no mkdir, no watermark move. An un-flushed
 * spool therefore holds rows this cannot see, which is why a partition with
 * pending spool bytes downgrades the destination to a floor rather than being
 * silently omitted.
 *
 * @ref LLP 0101#no-release [implements]: "prints what would leave" - the magnitude half, read off the export cursor rather than asserted
 * @ref LLP 0040#watermark-contract [constrained-by]: the preview reads the same per-(sink instance, partition) watermark the export advances, so a rewound cursor shows up here
 * @ref LLP 0070#incremental [constrained-by]: withheld rows arrive as drop-only entries; they are tallied apart from the payload rows
 * @param {{
 *   handles: ExtendedSinkHandle[],
 *   query?: QueryRegistry,
 *   storage?: ExtendedQueryStorageService,
 *   stateRoot: string,
 *   config?: HypAwareV2Config,
 * } & PendingPreviewOptions} args
 * @returns {Promise<Map<string, PendingVolume>>}
 */
export async function previewPendingRows(args) {
  const { handles, query, storage, stateRoot, config } = args
  const rowLimit = args.rowLimit ?? DEFAULT_ROW_LIMIT
  const budgetMs = args.budgetMs ?? DEFAULT_BUDGET_MS
  const now = args.now ?? (() => Date.now())
  const deadline = now() + budgetMs

  /** @type {Map<string, PendingVolume>} */
  const out = new Map()
  if (!query?.listDatasets || !storage?.readRowsSince) {
    for (const handle of handles) out.set(handle.instanceName, unknownVolume('no cache reader is available'))
    return out
  }

  const discovered = await discoverCountablePartitions({ query, storage, config })
  if (discovered.partitions.length === 0 && discovered.failures > 0) {
    for (const handle of handles) out.set(handle.instanceName, unknownVolume('the cache partitions could not be listed'))
    return out
  }

  for (const handle of handles) {
    out.set(
      handle.instanceName,
      await countForHandle({ handle, discovered, storage, stateRoot, rowLimit, deadline, now })
    )
  }
  return out
}

/**
 * The partitions a count can actually read: materialized, deduplicated by table
 * path, in the same order the driver would hand them to a sink.
 *
 * Deliberately *not* the driver's discovery: `discoverReadyPartitions` flushes
 * every pending spool before its second pass, and a preview that mutates the
 * cache is not a preview. The cost is visibility, not correctness - rows still
 * in the spool are not in the table this reads - so `unflushed` records that the
 * total is a floor.
 *
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, config?: HypAwareV2Config }} args
 * @returns {Promise<{ partitions: QueryPartition[], unflushed: boolean, failures: number }>}
 */
async function discoverCountablePartitions({ query, storage, config }) {
  /** @type {QueryPartition[]} */
  const partitions = []
  /** @type {Set<string>} */
  const seen = new Set()
  let unflushed = false
  let failures = 0
  for (const dataset of query.listDatasets()) {
    try {
      const parts = await dataset.discoverPartitions({
        config: config ?? /** @type {HypAwareV2Config} */ ({ version: 2 }),
        scope: { limit: 1000 },
        cacheDir: storage.cacheRoot,
      })
      for (const part of parts ?? []) {
        const tablePath = part.tablePath
        // A partition with no backing table has no rows to read through the
        // incremental seam, so it contributes nothing to a count either way.
        if (!tablePath || seen.has(tablePath) || !storage.tableExists(tablePath)) continue
        seen.add(tablePath)
        partitions.push(part)
        if (storage.hasPendingSync?.(tablePath)) unflushed = true
      }
    } catch {
      failures += 1
    }
  }
  return { partitions, unflushed, failures }
}

/**
 * @param {{
 *   handle: ExtendedSinkHandle,
 *   discovered: { partitions: QueryPartition[], unflushed: boolean, failures: number },
 *   storage: ExtendedQueryStorageService,
 *   stateRoot: string,
 *   rowLimit: number,
 *   deadline: number,
 *   now: () => number,
 * }} args
 * @returns {Promise<PendingVolume>}
 */
async function countForHandle({ handle, discovered, storage, stateRoot, rowLimit, deadline, now }) {
  /** @type {ReturnType<typeof createSinkWatermarkStore>} */
  let watermarks
  try {
    watermarks = createSinkWatermarkStore({
      stateDir: instanceWatermarkStateDir(pluginStateDir(stateRoot, handle.plugin), handle.instanceName),
    })
  } catch (err) {
    return unknownVolume(describeError(err))
  }

  let rows = 0
  let withheldRows = 0
  let scanned = 0
  let read = 0
  let failed = 0
  let truncated = false
  /** @type {number | null} */
  let oldestResumeMs = null
  let anyFromBeginning = false

  for (const partition of discovered.partitions) {
    // Checked before the partition as well as inside it, so a destination that
    // inherits an already-spent budget reports nothing rather than a floor of
    // however many rows fit before the first in-loop clock check.
    if (truncated || now() > deadline) { truncated = true; break }
    const tablePath = /** @type {string} */ (partition.tablePath)
    try {
      const record = await watermarks.read(watermarks.keyFor(storage.cacheRoot, tablePath))
      const since = record?.continuation
      if (record === null) {
        // No durable cursor for this partition: the destination would export it
        // from the beginning, so no timestamp bounds this destination's range.
        anyFromBeginning = true
      } else {
        const at = Date.parse(record.updatedAt)
        if (Number.isFinite(at) && (oldestResumeMs === null || at < oldestResumeMs)) oldestResumeMs = at
      }
      // @ref LLP 0040#storage-api-extension [constrained-by]: `includeLegacy` is
      // derived exactly as every sink derives it, so a preview never counts a
      // pre-upgrade null-seq backlog the destination has already shipped.
      const includeLegacy = since === undefined
      for await (const entry of storage.readRowsSince(tablePath, { since, includeLegacy })) {
        if (entry.dropped) withheldRows += 1
        else rows += 1
        scanned += 1
        if (scanned >= rowLimit) { truncated = true; break }
        if (scanned % CLOCK_CHECK_EVERY === 0 && now() > deadline) { truncated = true; break }
      }
      read += 1
    } catch {
      failed += 1
    }
  }

  if (read === 0 && failed > 0) return unknownVolume('a cache partition could not be read')
  const shortfall = truncated
    ? 'the count hit its scan budget'
    : failed > 0 || discovered.failures > 0
      ? 'part of the cache could not be read'
      : discovered.unflushed
        ? 'rows are still buffered and were not counted'
        : null
  // A floor of zero is not a floor, it is the absence of an answer. Saying
  // "nothing pending" here would be the false zero this whole preview exists
  // to avoid, so an empty short count reports as unknown instead.
  if (shortfall !== null && rows === 0 && withheldRows === 0) return unknownVolume(shortfall)

  return {
    status: shortfall !== null ? 'partial' : 'counted',
    ...(shortfall !== null ? { reason: shortfall } : {}),
    rows,
    withheldRows,
    resume: anyFromBeginning
      ? { kind: 'beginning' }
      : oldestResumeMs !== null
        ? { kind: 'since', at: new Date(oldestResumeMs).toISOString() }
        : { kind: 'unknown' },
  }
}

/**
 * @param {string} reason
 * @returns {PendingVolume}
 */
function unknownVolume(reason) {
  return { status: 'unknown', rows: 0, withheldRows: 0, resume: { kind: 'unknown' }, reason }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}
