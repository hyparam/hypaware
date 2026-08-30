// @ts-check

import { instanceWatermarkStateDir } from './incremental.js'
import { pluginStateDir } from '../runtime/paths.js'
import { createSinkWatermarkStore } from './watermarks.js'

/**
 * @import { DatasetDisposition, DatasetRegistration, HypAwareV2Config, QueryPartition, QueryRegistry } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExtendedSinkHandle } from '../../../src/core/registry/types.js'
 * @import { Discovered, PendingPreviewOptions, PendingVolume, SinkWatermarkRecord } from '../../../src/core/sinks/types.js'
 */

/**
 * Rows one destination's count may scan before it reports a floor instead of an
 * exact total. Generous, because the answer is worth having; bounded, because
 * this runs in front of a prompt somebody is waiting at.
 */
const DEFAULT_ROW_LIMIT = 200000

/**
 * Wall-clock budget for the whole preview. The row limit bounds work, this
 * bounds *waiting*: a cold page cache makes a small backlog slow, and a
 * consent prompt that looks hung is its own bug (#976). Spent as cumulative
 * per-destination deadlines anchored after discovery, never as one shared clock
 * a first destination can exhaust (see `previewPendingRows`).
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
 *    on a consent prompt is worse than an admitted gap. This extends to
 *    throwing: the plan is the consent surface, so a preview that could not run
 *    at all resolves to `unknown` for every destination rather than propagating
 *    and taking the whole prompt down with it. `previewPendingRows` never
 *    rejects.
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
  const start = now()

  /** @type {Map<string, PendingVolume>} */
  const out = new Map()
  if (!query?.listDatasets || !storage?.readRowsSince) {
    for (const handle of handles) out.set(handle.instanceName, unknownVolume('no cache reader is available'))
    return out
  }

  // Rule 3 taken to its conclusion. Everything below reaches into plugin-owned
  // registries and on-disk state, so "it threw" is a live outcome, and the
  // caller is a `--dry-run` whose entire job is to print. Fill whatever the
  // count reached, then backfill the rest as `unknown`: a destination with no
  // answer is disclosed as having none, never omitted from the plan and never
  // rendered as zero.
  try {
    const discovered = await discoverCountablePartitions({ query, storage, config })
    if (discovered.partitions.length === 0 && discovered.failures > 0) {
      for (const handle of handles) out.set(handle.instanceName, unknownVolume('the cache partitions could not be listed'))
      return out
    }

    // The budget is spent as cumulative per-destination deadlines: destination
    // i of n counts until `scanStart + remaining * (i + 1) / n`. What this buys
    // on a slow machine is fairness: the release the plan feeds is
    // all-or-nothing, so the plan's worth is bounded by its worst-informed
    // line, and letting the first destination spend the whole clock left
    // `unknown` on destinations the confirmation forwards anyway.
    //
    // The slices are anchored *after* discovery, not at `start`. Discovery is
    // one shared cost every destination benefits from, paid before any of them
    // counts, so charging it to the first slice is how the first destination
    // inherits an already-spent deadline and reports `unknown` while every
    // later one reports a floor - the failure this exists to remove, relocated
    // rather than removed. Measured: 4 destinations, a 3000ms budget and a
    // 900ms discovery ends slice 0 a full 150ms before its first row is read.
    //
    // Absolute deadlines make rollover free (a destination that finishes early
    // donates its remainder to every later one), and the last deadline is
    // `scanStart + remaining`, which is `start + budget` exactly, so the
    // preview's total wall-clock bound is unchanged and a single destination
    // collapses to today's lone `start + budget`.
    const scanStart = now()
    // Signed on purpose. Discovery alone can outlast the budget, and then every
    // deadline is already in the past and every destination reports `unknown`,
    // exactly as one shared spent deadline does today. Clamping *this* to zero
    // would instead hand every destination a fresh partition read and a first
    // 512-row block on a budget that is already gone, in front of the prompt
    // whose whole reason for having a budget is not looking hung.
    const remaining = start + budgetMs - scanStart
    // @ref LLP 0325#slices [implements]: labelled floors on every line beat an exact first count beside an absent answer
    // @ref LLP 0325#discovery-off-the-top [implements]: the shared discovery cost is charged to no slice, so slice 0 is not the one that starts already spent
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i]
      // The floor is what makes "already in the past" true at every `n`, and a
      // no-op whenever `remaining >= 0`, since a share of a non-negative
      // remainder never reaches past the last deadline. A share smaller than
      // half a ULP of a `Date.now()` magnitude rounds away entirely, so a
      // *negative* remainder divided across enough destinations hands the early
      // ones a deadline of exactly `scanStart`, which is not in the past at
      // all: measured at n = 20000 against a budget discovery had already
      // overrun by 1ms, the first two destinations ran a complete exact count
      // on a spent clock. `start + budgetMs` is the single spent deadline this
      // is supposed to be indistinguishable from, so floor at it.
      // @ref LLP 0325#spent-is-spent [implements]: a budget discovery already overran puts every deadline in the past at every n, not only where the share survives rounding
      const deadline = Math.min(scanStart + remaining * (i + 1) / handles.length, start + budgetMs)
      out.set(
        handle.instanceName,
        await countForHandle({ handle, discovered, storage, stateRoot, rowLimit, deadline, now })
      )
    }
  } catch (err) {
    const reason = `the count failed: ${describeError(err)}`
    for (const handle of handles) {
      if (!out.has(handle.instanceName)) out.set(handle.instanceName, unknownVolume(reason))
    }
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
 * The registration each partition came from travels with it, because the count
 * is per destination and a destination is entitled to refuse a dataset: the
 * disposition seam needs the same `DatasetRegistration` the sink's own export
 * rule reads, and discovery is the only place the kernel still has it.
 *
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, config?: HypAwareV2Config }} args
 * @returns {Promise<Discovered>}
 */
async function discoverCountablePartitions({ query, storage, config }) {
  /** @type {QueryPartition[]} */
  const partitions = []
  /** @type {Map<string, DatasetRegistration>} */
  const datasets = new Map()
  /** @type {Set<string>} */
  const seen = new Set()
  let unflushed = false
  let failures = 0
  /** @type {ReturnType<QueryRegistry['listDatasets']>} */
  let listed
  try {
    // Listing is plugin-backed too, so it is as capable of throwing as the
    // per-dataset discovery below. An unlistable catalog is a count that could
    // not be taken, not a count of zero.
    listed = query.listDatasets()
  } catch {
    return { partitions: [], datasets, unflushed: false, failures: 1 }
  }
  for (const dataset of listed) {
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
        datasets.set(tablePath, dataset)
        if (storage.hasPendingSync?.(tablePath)) unflushed = true
      }
    } catch {
      failures += 1
    }
  }
  return { partitions, datasets, unflushed, failures }
}

/**
 * What `handle` would do with `dataset`, asked of the sink itself.
 *
 * The kernel does not interpret the answer beyond its three names, and it does
 * not learn why: the eligibility rule stays declared on the dataset and
 * enforced in the sink, which is the coupling LLP 0305 refused to move into the
 * kernel. All this adds is the ability to ask.
 *
 * Every degraded case lands on `forwards`, and that direction is chosen, not
 * incidental. `forwards` is today's behaviour and the over-disclosing answer;
 * the failure this whole seam must not have is a prompt promising less egress
 * than the export performs, so a sink that cannot be asked, or whose answer
 * cannot be understood, is counted in full.
 *
 * @ref LLP 0324#fail-open-loud [implements]: absence, a throw, and an unrecognized answer all read as `forwards`
 * @param {ExtendedSinkHandle} handle
 * @param {DatasetRegistration} dataset
 * @returns {DatasetDisposition}
 */
function askDisposition(handle, dataset) {
  const sink = handle.sink
  if (typeof sink?.datasetDisposition !== 'function') return 'forwards'
  /** @type {unknown} */
  let answer
  try {
    answer = sink.datasetDisposition(dataset)
  } catch {
    return 'forwards'
  }
  return answer === 'skips' || answer === 'starts-from-now' ? answer : 'forwards'
}

/**
 * One destination's disposition for every discovered partition, keyed the way
 * discovery keys partitions. Asked once per dataset rather than once per
 * partition: the answer is a property of the dataset contract, and a plugin
 * call per partition on a machine with thousands of them is wall clock spent in
 * front of the prompt for an answer that cannot differ.
 *
 * @ref LLP 0324#disposition-seam [implements]: the preview asks each destination what it would do with each dataset, instead of the kernel filtering generically
 * @param {ExtendedSinkHandle} handle
 * @param {Discovered} discovered
 * @returns {Map<string, DatasetDisposition>}
 */
function resolveDispositions(handle, discovered) {
  /** @type {Map<string, DatasetDisposition>} */
  const byTable = new Map()
  /** @type {Map<string, DatasetDisposition>} */
  const byDataset = new Map()
  for (const partition of discovered.partitions) {
    const tablePath = /** @type {string} */ (partition.tablePath)
    const dataset = discovered.datasets.get(tablePath)
    // A partition with no registration behind it is one nothing can be asked
    // about, so it counts in full, same as a sink that answers nothing.
    if (!dataset) { byTable.set(tablePath, 'forwards'); continue }
    let answer = byDataset.get(dataset.name)
    if (answer === undefined) {
      answer = askDisposition(handle, dataset)
      byDataset.set(dataset.name, answer)
    }
    byTable.set(tablePath, answer)
  }
  return byTable
}

/**
 * @param {{
 *   handle: ExtendedSinkHandle,
 *   discovered: Discovered,
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

  // What this destination says it would do with each discovered dataset,
  // resolved before either pass so both read one answer. Preview-only: nothing
  // below writes, and no caller of this file is the export path.
  // @ref LLP 0324#preview-only [implements]: only the preview consults the disposition; the driver, the hold, and the export path are untouched
  const dispositions = resolveDispositions(handle, discovered)

  // ---- Pass 1: every partition's resume point, before a single row is read.
  //
  // "How far back does this reach" is half of what the prompt discloses, and it
  // must not be derived from whichever partitions happened to fit inside the
  // scan budget. A partition the row pass never reaches may be the one with no
  // durable cursor at all - the destination would forward the machine's entire
  // history through it - and reporting the *visited* partitions' oldest cursor
  // would then understate the reach in the one direction a consent surface must
  // never understate. A watermark record is one small JSON file, so this pass is
  // bounded by partition count rather than by row count.
  /** @type {Map<string, SinkWatermarkRecord | null>} */
  const records = new Map()
  /** @type {number | null} */
  let oldestResumeMs = null
  let anyFromBeginning = false
  // False once any partition's cursor could not be established, so a precise
  // "captured since <t>" is never claimed over an incomplete survey.
  let resumeComplete = true
  // The survey ran out of wall clock, rather than failing on one partition. The
  // two are different disclosures and must not be conflated: a spent budget
  // leaves every later partition unsurveyed, so the row pass has nothing left to
  // count from, while one partition whose cursor will not resolve costs only
  // itself.
  let budgetSpent = false
  for (const partition of discovered.partitions) {
    if (now() > deadline) { resumeComplete = false; budgetSpent = true; break }
    const tablePath = /** @type {string} */ (partition.tablePath)
    // A dataset this destination refuses leaves its count entirely: no cursor
    // read, no rows, no withheld tally, and no claim on the resume range. It is
    // not a partition whose survey failed, so it must not mark the survey
    // incomplete either.
    // @ref LLP 0324#skips [implements]: a skipped dataset contributes to neither tally, and its cursor never advances, so it is not policy activity
    if (dispositions.get(tablePath) === 'skips') continue
    try {
      const record = await watermarks.read(watermarks.keyFor(storage.cacheRoot, tablePath))
      records.set(tablePath, record)
      if (record === null) {
        // No durable cursor for this partition: the destination would export it
        // from the beginning, so no timestamp bounds this destination's range.
        // A start-now destination is the exception: it ships none of that
        // history, so the missing cursor bounds nothing and announcing "the
        // full local history" would overstate a range that does not exist.
        // @ref LLP 0324#starts-from-now [implements]: a missing watermark means zero for a start-now dataset, not the beginning
        if (dispositions.get(tablePath) !== 'starts-from-now') anyFromBeginning = true
      } else {
        const at = Date.parse(record.updatedAt)
        // A cursor whose timestamp will not parse bounds nothing. Passing over
        // it silently would leave the *other* partitions' oldest cursor standing
        // as the destination's whole range, understating the reach for exactly
        // the reason an unsurveyed partition would.
        if (!Number.isFinite(at)) resumeComplete = false
        else if (oldestResumeMs === null || at < oldestResumeMs) oldestResumeMs = at
      }
    } catch {
      resumeComplete = false
    }
  }

  // ---- Pass 2: the rows, reusing pass 1's cursors.
  let rows = 0
  let withheldRows = 0
  let scanned = 0
  let read = 0
  let failed = 0
  // Only a spent budget starts pass 2 already truncated: pass 1 stopped where it
  // stopped, so nothing past that point has a cursor to count from. A partition
  // that failed pass 1 on its own is charged to `failed` below instead, which
  // keeps the rest of the count as an honestly labelled floor rather than
  // discarding a whole destination's answer and blaming a budget that was never
  // spent.
  let truncated = budgetSpent

  for (const partition of discovered.partitions) {
    // Checked before the partition as well as inside it, so a destination that
    // inherits an already-spent budget reports nothing rather than a floor of
    // however many rows fit before the first in-loop clock check.
    if (truncated || now() > deadline) { truncated = true; break }
    const tablePath = /** @type {string} */ (partition.tablePath)
    const disposition = dispositions.get(tablePath) ?? 'forwards'
    if (disposition === 'skips') continue
    if (!records.has(tablePath)) { failed += 1; continue }
    const record = records.get(tablePath) ?? null
    // The start-now boundary, counted rather than assumed: with no durable
    // cursor this destination's first export ships nothing from this partition,
    // so it contributes zero. Charged to `read` and not to `failed`, because
    // zero is the destination's real answer for a dataset it does forward, and
    // a counted zero is not the false zero the preview guards against.
    // @ref LLP 0324#starts-from-now [implements]: a missing-watermark start-now partition contributes zero pending rows
    if (disposition === 'starts-from-now' && record === null) { read += 1; continue }
    try {
      const since = record?.continuation
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
    // `beginning` survives an incomplete survey because it is the loudest of the
    // three and cannot be walked back by a partition still unseen; a precise
    // `since` does not, because an unsurveyed partition could reach further
    // back than any cursor pass 1 managed to read.
    resume: anyFromBeginning
      ? { kind: 'beginning' }
      : resumeComplete && oldestResumeMs !== null
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
