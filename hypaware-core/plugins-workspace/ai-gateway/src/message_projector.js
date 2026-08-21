// @ts-check

import { isUsagePolicyDrop } from '../../../../src/core/usage-policy/index.js'
import { canonicalJson, isPlainObject, parseMaybeJson, sha256Hex, stringValue, stripVolatileBlockFields } from 'hypaware/core/util'

export const SCHEMA_VERSION = 7

/**
 * @import { AiGatewayExchangeInput, AiGatewayProjectedExchange, AiGatewayProjectedMessage, CachePartitionMeta, ColumnSpec, PluginLogger, QueryStorageService } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { UsagePolicyDrop } from '../../../../src/core/usage-policy/types.js'
 * @import { RegisteredProjector, ThreadChain } from './types.js'
 */

const DATASET_NAME = 'ai_gateway_messages'

/**
 * HypAware's normalized AI gateway message-part query schema.
 *
 * The row shape is the contract the dataset advertises and downstream
 * queries lock onto. The gateway always emits this column set, regardless
 * of which adapter projector produced the messages (projector-defined
 * fields map onto these named columns directly). `schema_version` 7 added
 * the `git_remote` / `head_sha` / `repo_root` capture columns (LLP 0032);
 * the additions are nullable and no partition-label bump is needed. An old
 * partition physically lacks them; `withSchemaColumns` in `dataset.js` is the
 * only reason they stay addressable at all, and the exact value a read of one
 * yields depends on the read path (LLP 0015#multi-partition-union).
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const AI_GATEWAY_MESSAGE_COLUMNS = Object.freeze([
  { name: 'gateway_id', type: 'STRING', nullable: false },
  { name: 'schema_version', type: 'INT32', nullable: false },
  // @ref LLP 0030#decision: session_id is the partition key and the
  // session container (Claude session / Codex metadata.session_id),
  // always present; conversation_id is the thread WITHIN it (Codex
  // thread; null for Claude) and is therefore nullable.
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'user_id', type: 'STRING', nullable: true },
  { name: 'provider', type: 'STRING', nullable: false },
  { name: 'model', type: 'STRING', nullable: true },
  { name: 'system_text', type: 'STRING', nullable: true },
  { name: 'tools', type: 'JSON', nullable: true },
  { name: 'conversation_started_at', type: 'TIMESTAMP', nullable: false },
  { name: 'conversation_source', type: 'STRING', nullable: true },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'git_branch', type: 'STRING', nullable: true },
  // @ref LLP 0032#capture: captured repo identity for the GitHub↔LLM graph
  // bridge: the git remote URL, full HEAD sha, and repo root (the prefix that
  // relativizes a touched file's absolute path). Nullable: a session may run
  // outside a git repo, and older partitions predate these columns (read null).
  { name: 'git_remote', type: 'STRING', nullable: true },
  { name: 'head_sha', type: 'STRING', nullable: true },
  { name: 'repo_root', type: 'STRING', nullable: true },
  { name: 'client_version', type: 'STRING', nullable: true },
  { name: 'entrypoint', type: 'STRING', nullable: true },
  { name: 'user_type', type: 'STRING', nullable: true },
  { name: 'permission_mode', type: 'STRING', nullable: true },
  { name: 'is_sidechain', type: 'BOOLEAN', nullable: true },
  { name: 'agent_id', type: 'STRING', nullable: true },
  { name: 'parent_thread_id', type: 'STRING', nullable: true },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'previous_message_id', type: 'JSON', nullable: true },
  { name: 'provider_uuid', type: 'STRING', nullable: true },
  { name: 'parent_uuid', type: 'STRING', nullable: true },
  { name: 'logical_parent_uuid', type: 'STRING', nullable: true },
  { name: 'source_tool_assistant_uuid', type: 'STRING', nullable: true },
  { name: 'request_id', type: 'STRING', nullable: true },
  { name: 'prompt_id', type: 'STRING', nullable: true },
  { name: 'message_index', type: 'INT32', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'role', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'part_index', type: 'INT32', nullable: false },
  { name: 'part_type', type: 'STRING', nullable: false },
  { name: 'provider_type', type: 'STRING', nullable: true },
  { name: 'provider_subtype', type: 'STRING', nullable: true },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'tool_name', type: 'STRING', nullable: true },
  { name: 'tool_call_id', type: 'STRING', nullable: true },
  { name: 'tool_args', type: 'JSON', nullable: true },
  { name: 'caller_type', type: 'STRING', nullable: true },
  { name: 'tool_result_for', type: 'STRING', nullable: true },
  { name: 'thinking_signature', type: 'STRING', nullable: true },
  { name: 'attachment_type', type: 'STRING', nullable: true },
  { name: 'hook_event', type: 'STRING', nullable: true },
  { name: 'is_error', type: 'BOOLEAN', nullable: true },
  { name: 'is_compact_summary', type: 'BOOLEAN', nullable: true },
  { name: 'compact_metadata', type: 'JSON', nullable: true },
  { name: 'status', type: 'JSON', nullable: true },
  { name: 'attributes', type: 'JSON', nullable: true },
  { name: 'raw_frame', type: 'JSON', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
])

const SCHEMA_COLUMN_NAMES = new Set(AI_GATEWAY_MESSAGE_COLUMNS.map((column) => column.name))

/**
 * Build the exchange-projector dispatcher. The dispatcher is owned by
 * the source layer (one instance per started listener); every
 * finalized exchange is fed through `projectExchange`, which:
 *
 *  1. Selects projectors whose `match()` returns true for the input.
 *  2. Sorts them by descending `priority` then registration order
 *     (the `_seq` tiebreaker the API records when the projector was
 *     registered).
 *  3. Walks the sorted list and calls `project()`; the first
 *     successful, non-empty projection wins. Projectors that throw,
 *     return `undefined`, or return an invalid shape are warned and
 *     skipped.
 *  4. Applies fallback identity (hash `message_id`) ONLY when the
 *     chosen projection omitted identity (projector-supplied IDs are
 *     authoritative). `previous_message_id` is gateway-owned either
 *     way: unless the projector supplied explicit history, every row
 *     gets its IMMEDIATE predecessor in the THREAD (a 0/1-element
 *     array), scoped to `(conversation_id ?? session_id, agent_id)` so
 *     a Claude subagent's chain (conversation_id null, scopes by
 *     session) and a Codex thread (scopes by its own conversation_id)
 *     stay separate from the main loop's, so enriched and fallback
 *     rows stay query-compatible. The full
 *     ancestry is the transitive closure of these links (storing it per
 *     row was quadratic).
 *  5. Expands each projected message into the per-part rows the
 *     `ai_gateway_messages` schema advertises, merges
 *     `attributes.gateway.*` provenance, and strips to schema columns.
 *
 * If no projector matches or every match fails, the dispatcher
 * returns an empty row array (the source still emits pass-through
 * telemetry (`aigw.exchange` log + `aigw.exchange_bytes` meter), it
 * just does not write any rows).
 *
 * @param {{
 *   gatewayId: string,
 *   projectors: RegisteredProjector[],
 *   storage?: ExtendedQueryStorageService | QueryStorageService,
 *   log?: PluginLogger | { warn(message: string, fields?: Record<string, unknown>): void, info?: (m: string, f?: Record<string, unknown>) => void },
 *   isSessionIgnored?: (sessionId: string) => boolean,
 *   now?: () => number,
 * }} opts
 */
export function createAiGatewayMessageProjector(opts) {
  const gatewayId = opts.gatewayId || 'hypaware-local'
  const projectors = Array.isArray(opts.projectors) ? opts.projectors : []
  const storage = opts.storage
  const log = opts.log
  // The gateway hands adapters a read-only membership test against its
  // in-memory ignored-session set; the adapter (which knows the canonical
  // session_id) does the actual drop. Absent (backfill materialization,
  // unit-test stubs) → nothing is ignored, so existing behavior is intact.
  // @ref LLP 0066#enforcement
  const isSessionIgnored = typeof opts.isSessionIgnored === 'function'
    ? opts.isSessionIgnored
    : () => false

  // One persistent conversation state per listener: identity history
  // and dedup span the whole session, matching pre-extraction behavior.
  const state = createAiGatewayConversationState()

  // In-flight (or settled) committed-row seed promise per session_id.
  // A live listener is rebuilt fresh on every daemon start/reload
  // (source.js launchListener), so without seeding the seen-set starts
  // empty and a replay of already-committed history re-emits
  // duplicate-part_id rows. Memoizing the PROMISE (not just a "seeded"
  // flag) is load-bearing: two concurrent first exchanges for one
  // session must await the same scan before projecting, or the second
  // races past a still-empty seen-set and re-emits the rows this guards
  // against.
  /** @type {Map<string, Promise<void>>} */
  const seedPromises = new Map()

  // Which session_ids have committed rows at all. Directory partitioning
  // is by `source=` only, so the per-session seed scan cannot prune by
  // path and reads the WHOLE table; autonomous clients mint fresh session
  // ids constantly, and for a fresh id that full scan finds nothing. This
  // index is built lazily and shared by every session, so an unseen
  // session skips its seed scan outright; because a fresh session id is
  // always a miss in this workload, the index still pays one whole-table
  // `session_id` scan per `SESSION_INDEX_REBUILD_MS` window, indefinitely,
  // rather than the single build the name suggests.
  // @ref LLP 0204#fix [implements]: new sessions must not pay a whole-table scan
  const sessionIndex = createCommittedSessionIndex(storage, log, opts.now)

  return {
    /**
     * @param {AiGatewayExchangeInput | Record<string, unknown>} exchange
     * @param {{ journal?: (() => void)[] }} [projectOpts] Pass a `journal`
     *   array to have every dedupe-state mutation this projection makes
     *   record its undo, so a caller whose append fails can hand it to
     *   `rollbackAiGatewayStateJournal` instead of leaving the shared state
     *   claiming rows that never landed.
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async projectExchange(exchange, projectOpts = {}) {
      const input = /** @type {AiGatewayExchangeInput} */ (exchange)
      const projection = await dispatchProjector(projectors, input, log, isSessionIgnored)
      // An intentional `.hypignore` usage-policy drop is a TERMINAL success, not
      // a projection miss: the adapter already logged the rich
      // `plugin.<adapter>.usage_policy_drop` event at the seam, so the gateway
      // records the drop at info level (NOT the `no_projector_match` warn below,
      // which would mislabel a privacy drop as a failure) and writes no rows.
      // @ref LLP 0050 [implements]
      if (isUsagePolicyDrop(projection)) {
        log?.info?.('aigw.usage_policy_drop', {
          exchange_id: stringValue(input.exchange_id) ?? '',
          upstream: stringValue(input.upstream) ?? '',
          reason: 'usage_policy_drop',
        })
        return []
      }
      if (!projection) {
        // Carry enough to identify WHAT went unrecorded: an operator
        // reading only this line must be able to tell a foreign wire
        // dialect (a path no projector decodes) from a failing client.
        // Observed cost of the leaner event: OpenClaw's /v1/responses
        // traffic proxied for hours reading as "client never attached"
        // (LLP 0176).
        // @ref LLP 0176#fix-direction [implements]: fix 3, an undecoded
        //   proxied exchange names its upstream, path, and status
        log?.warn?.('aigw.message_projection_skipped', {
          exchange_id: stringValue(input.exchange_id) ?? '',
          upstream: stringValue(input.upstream) ?? '',
          reason: 'no_projector_match',
          // Pathname only: the row's `path` is the full request URL, and a
          // TOML-configured upstream authenticating via a query parameter
          // would otherwise put that credential into a warn line.
          path: (stringValue(input.path) ?? '').split('?')[0],
          method: stringValue(input.method) ?? '',
          status_code: typeof input.status_code === 'number' ? input.status_code : null,
          is_sse: input.is_sse === true,
        })
        return []
      }

      // @ref LLP 0030#decision: seed by session_id (the partition key,
      // always present). Claude `conversation_id` is null, so seeding on it
      // would never dedup a replayed Claude session.
      await seedSeenMessagesForSession(
        projection.session_id,
        state,
        seedPromises,
        storage,
        log,
        sessionIndex
      )

      return aiGatewayRowsFromProjectedExchange(projection, {
        gatewayId,
        gatewayAttributes: buildGatewayAttributes(input),
        tsStart: stringValue(input.ts_start) ?? new Date().toISOString(),
        state,
        ...(projectOpts.journal ? { journal: projectOpts.journal } : {}),
      })
    },
  }
}

// @ref LLP 0026#consequences [implements]: closes the "durable live dedup
// across daemon restarts (seed the seen-set from committed part_ids)" gap:
// the in-memory seen-set is rebuilt empty on every restart/reload, so a
// replay of already-committed history would re-emit same-part_id rows.
/**
 * Lazily pre-populate `state.seenMessages` with the `message_id`s already
 * committed for one session, the FIRST time that session is projected in
 * this listener's lifetime. Seeds one session at a time (a large cache
 * holds millions of part_ids (a global preload is a memory and scan
 * problem), and only once per session per listener.
 *
 * Scopes on `session_id`: the partition key (LLP 0030), always present.
 * Claude `conversation_id` is null, so a conversation-scoped seed would
 * never dedup a replayed Claude session; the session partition holds all
 * of a session's committed rows across its threads.
 *
 * The scan promise is memoized SYNCHRONOUSLY in `seedPromises` before the
 * first `await`, so concurrent first exchanges for the same session await
 * the same scan instead of racing past an unseeded `seenMessages` and
 * re-emitting the duplicates this guards against. The proxy fires
 * `onExchangeFinished` without serializing (proxy.js stores the returned
 * promise but does not await it), so this overlap is real.
 *
 * This is also where the seed path's "a seeding miss must never cost a row"
 * guarantee is ENFORCED rather than merely documented: whatever the seed
 * rejects with is absorbed here, for the whole path, including the parts of
 * it that reach storage the leaf scan does not own.
 *
 * @param {string} sessionId
 * @param {ReturnType<typeof createAiGatewayConversationState>} state
 * @param {Map<string, Promise<void>>} seedPromises
 * @param {ExtendedQueryStorageService | QueryStorageService | undefined} storage
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 * @param {ReturnType<typeof createCommittedSessionIndex>} [sessionIndex]
 * @returns {Promise<void>}
 */
function seedSeenMessagesForSession(sessionId, state, seedPromises, storage, log, sessionIndex) {
  if (!sessionId) return Promise.resolve()
  let pending = seedPromises.get(sessionId)
  if (!pending) {
    // This body runs to here synchronously (no prior await), so the map is
    // populated before any concurrent caller can observe a missing entry.
    //
    // `projectExchange` awaits this and `source.js` drops the row for
    // whatever it rejects with, so a seed that could not run must settle as
    // "seeded nothing", never as a rejection: a seeding miss risks only the
    // duplicate the seed exists to prevent (which settlement/compaction
    // still collapse), while a rejection costs a real row.
    //
    // Nothing ever REWRITES a memo entry, so absorbing the rejection alone
    // would cache "could not seed" as this session's verdict for the
    // listener's lifetime. That is right for a scan that RAN and came back
    // empty-handed, and wrong for one that broke: every later exchange
    // would short-circuit onto the memo and inherit a verdict no scan ever
    // produced. So drop the memo too, and let the next exchange retry and
    // re-warn. The retry costs a scan that fails the way this one did (the
    // caching in LLP 0204 is there to spare the daemon whole-table scans
    // that SUCCEED), and buys back the operator signal whose absence made
    // this silent: without it, one broken session logged once and then went
    // quiet while every row for it was dropped.
    // @ref LLP 0204#fix [constrained-by]: the per-session seed exists to
    //   save a scan, so nothing in it may end an exchange or outlive itself
    pending = seedSessionIfCommitted(sessionId, state, storage, log, sessionIndex).catch((err) => {
      log?.warn?.('aigw.seed_seen_messages_failed', {
        session_id: sessionId,
        error_kind: 'seed_rejected',
        error: err instanceof Error ? err.message : String(err),
      })
      // Guarded so a concurrent caller's newer memo is not evicted by this
      // one's failure.
      if (seedPromises.get(sessionId) === pending) seedPromises.delete(sessionId)
    })
    seedPromises.set(sessionId, pending)
  }
  return pending
}

/**
 * Seed one session's seen-set, consulting the committed-session index
 * first: a session with no committed rows anywhere has nothing to seed,
 * so the (whole-table) per-session scan is skipped. Same best-effort
 * posture as the scan itself: an index that cannot answer errs toward
 * scanning.
 *
 * @param {string} sessionId
 * @param {ReturnType<typeof createAiGatewayConversationState>} state
 * @param {ExtendedQueryStorageService | QueryStorageService | undefined} storage
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 * @param {ReturnType<typeof createCommittedSessionIndex>} [sessionIndex]
 * @returns {Promise<void>}
 */
async function seedSessionIfCommitted(sessionId, state, storage, log, sessionIndex) {
  if (sessionIndex && !(await sessionIndex.mightHaveCommittedRows(sessionId))) return
  await scanCommittedMessageIds(sessionId, state, storage, log)
}

/**
 * How long a committed-session index stays authoritative for "this session
 * has no committed rows", measured from when its scan COMPLETED (not when
 * it started, or a scan slower than this window could never serve a hit).
 * Within the window a miss is trusted; after it, a
 * miss triggers one rebuild before being trusted, so rows committed by a
 * concurrent writer (a `hyp backfill` in another process importing the
 * session this listener is now capturing) are seen at most this late. A
 * stale miss only risks the duplicate seeding guards against, which
 * settlement/compaction still collapse - the documented failure envelope
 * of the seed scan itself.
 */
export const SESSION_INDEX_REBUILD_MS = 10 * 60_000

/**
 * Lazily-built index of session_ids that have any committed
 * `ai_gateway_messages` row. One projection of the `session_id` column
 * across all partitions, shared by every session the listener projects,
 * replacing a whole-table scan PER new session id.
 *
 * @param {ExtendedQueryStorageService | QueryStorageService | undefined} storage
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 * @param {() => number} [now] Injectable clock, defaulting to `Date.now`,
 *   so rebuild-window tests don't depend on wall-clock timing.
 */
function createCommittedSessionIndex(storage, log, now = Date.now) {
  /** @type {{ atMs: number, ids: Promise<Set<string> | undefined> } | undefined} */
  let built

  function rebuild() {
    // `scanCommittedSessionIds` reports a scan it could not run as
    // `undefined` rather than by rejecting, but nothing structural holds it
    // to that. Normalize a rejection into the same "could not scan" outcome
    // so this promise is total, because everything downstream assumes it is:
    // the stamp-and-self-clear handler below runs on FULFILLMENT only, so a
    // rejecting scan would leave `built` pinned to the rejected attempt and
    // every later caller would re-await the same rejection - a permanently
    // wedged index that loses every subsequent exchange, rather than the
    // index degrading the way every other failure in this best-effort path
    // does. It also keeps the rejection away from any handler nothing
    // awaits, the shape that reaches Node's default handler and would take
    // the whole daemon down.
    // @ref LLP 0204#fix [constrained-by]: the seed index is best-effort, so
    //   a scan it cannot complete must degrade the index, never end the process
    // `error_kind` separates the two ways this message is reached, because
    // they call for opposite responses and are otherwise indistinguishable
    // in the log: `discover_failed` is an I/O condition the next rebuild may
    // well clear on its own, while `scan_rejected` means the scan broke its
    // documented "resolve, never reject" contract, i.e. a code defect that
    // will keep degrading the index on every exchange until someone fixes it.
    const scan = scanCommittedSessionIds(storage, log).catch((err) => {
      log?.warn?.('aigw.session_index_scan_failed', {
        error_kind: 'scan_rejected',
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    })
    // `atMs` starts at `Infinity` (never stale) and is stamped when the scan
    // COMPLETES, because the window measures how long the ANSWER is trusted.
    // Stamped at scan start, a scan slower than SESSION_INDEX_REBUILD_MS
    // would be stale the moment it resolved, so the next miss would rebuild
    // at once and the index would rebuild back-to-back without ever serving
    // a hit - on exactly the table size that makes the index worth having.
    // The entry is still published to `built` synchronously, so concurrent
    // callers share this in-flight scan; only the timestamp is deferred.
    const attempt = { atMs: Infinity, ids: scan }
    // Chaining (rather than a floating `.then`) is what orders the stamp
    // before every awaiter: a caller awaits `attempt.ids`, which resolves
    // only after this handler has run.
    attempt.ids = scan.then((ids) => {
      attempt.atMs = now()
      // A build that failed to scan cannot stand in as "no committed rows"
      // for the rebuild window; clear it once the failure is known so the
      // NEXT caller retries instead of trusting a stale, un-scanned answer.
      // Guarded on `built === attempt` so a later, already-succeeded rebuild
      // (from a concurrent caller) is not clobbered by this one's failure.
      if (ids === undefined && built === attempt) built = undefined
      return ids
    })
    built = attempt
    return attempt
  }

  return {
    /**
     * True when `sessionId` may have committed rows and the per-session
     * seed scan is worth running.
     *
     * @param {string} sessionId
     * @returns {Promise<boolean>}
     */
    async mightHaveCommittedRows(sessionId) {
      if (!canScanCommittedRows(storage)) return false
      const current = built ?? rebuild()
      const ids = await current.ids
      // A build that could not scan is not "definitely no committed
      // rows"; err toward running the per-session scan, the same
      // best-effort posture as the scan itself (see JSDoc above).
      if (ids === undefined) return true
      if (ids.has(sessionId)) return true
      if (now() - current.atMs < SESSION_INDEX_REBUILD_MS) return false
      // Another caller may have rebuilt (or a failed build may have
      // cleared itself) while this one awaited.
      const next = built === current || !built ? rebuild() : built
      const nextIds = await next.ids
      return nextIds === undefined || nextIds.has(sessionId)
    },
  }
}

/**
 * Scan committed partitions for the distinct `session_id`s present.
 * Best-effort like the message-id scan: an unreadable PARTITION is
 * skipped and still contributes the rest. A failure to even discover
 * partitions is a distinct outcome from "scanned and found nothing":
 * it returns `undefined` so the caller can tell "no sessions known" from
 * "the scan could not run" and err toward scanning instead of silently
 * treating a broken index as authoritative.
 *
 * Reports failure by RESOLVING to `undefined`, never by rejecting: the
 * committed-session index's stamp-and-self-clear handler runs on fulfillment
 * only, so a rejection here would pin `built` to the failed attempt and wedge
 * the index for the listener's life. `rebuild()` normalizes one back to
 * `undefined` rather than assuming this contract holds.
 *
 * @param {ExtendedQueryStorageService | QueryStorageService | undefined} storage
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 * @returns {Promise<Set<string> | undefined>}
 */
async function scanCommittedSessionIds(storage, log) {
  /** @type {Set<string>} */
  const ids = new Set()
  if (!canScanCommittedRows(storage)) return ids

  /** @type {CachePartitionMeta[]} */
  let partitions = []
  try {
    partitions = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  } catch (err) {
    log?.warn?.('aigw.session_index_scan_failed', {
      error_kind: 'discover_failed',
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }

  for (const part of partitions ?? []) {
    const tablePath = part?.path
    if (!tablePath || (typeof part.rowCount === 'number' && part.rowCount === 0)) continue
    try {
      for await (const row of storage.readRows(tablePath, ['session_id'])) {
        const sessionId = stringValue(row.session_id)
        if (sessionId) ids.add(sessionId)
      }
    } catch {
      // Skip an unreadable partition; others still contribute.
      continue
    }
  }
  return ids
}

/**
 * Scan committed `ai_gateway_messages` partitions for one session and fold
 * their `message_id`s into `state.seenMessages`.
 *
 * Best-effort throughout: a missing storage handle (unit-test stubs), a
 * missing table, or an unreadable partition degrades to "not seeded" (a
 * seeding miss only risks the duplicate this guards against (which
 * settlement/compaction can still collapse), whereas failing the exchange
 * would drop a real row). The promise still resolves on a partial/failed
 * scan, so it is cached and not retried on every exchange.
 *
 * It does NOT, however, promise never to throw, and used to claim it did:
 * only the `discoverCachePartitions` CALL is guarded below, not the walk
 * over the answer, so a storage that resolves a truthy NON-iterable (a
 * violation of its own declared return type) throws out of this function.
 * The guarantee callers actually need is that seeding never costs a row,
 * and that is enforced one level up in `seedSeenMessagesForSession`, which
 * absorbs a rejection from anywhere in the seed path (this scan, or the
 * committed-session index it consults first) rather than resting on a
 * contract each leaf asserts about itself.
 *
 * @param {string} sessionId
 * @param {ReturnType<typeof createAiGatewayConversationState>} state
 * @param {ExtendedQueryStorageService | QueryStorageService | undefined} storage
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 * @returns {Promise<void>}
 */
async function scanCommittedMessageIds(sessionId, state, storage, log) {
  if (!canScanCommittedRows(storage)) return

  /** @type {CachePartitionMeta[]} */
  let partitions = []
  try {
    partitions = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  } catch (err) {
    log?.warn?.('aigw.seed_seen_messages_failed', {
      session_id: sessionId,
      // `error_kind` separates the two ways this message is reached,
      // because they call for opposite responses: `discover_failed` is an
      // I/O condition this scan handled and the next session may not hit,
      // while `seed_rejected` (from the caller) means the seed path broke
      // and will keep breaking until someone fixes it.
      error_kind: 'discover_failed',
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  for (const part of partitions ?? []) {
    const tablePath = part?.path
    if (!tablePath || (typeof part.rowCount === 'number' && part.rowCount === 0)) continue
    // The dataset is Iceberg-partitioned by `session_id` (LLP 0030), so a
    // partition naming a different session cannot hold this one's rows (so
    // skip it without a read). The row-level `session_id` filter below is
    // the correctness backstop for source-partitioned or legacy partitions
    // that don't carry the key in their path.
    const partitionSession = part.partition?.session_id
    if (typeof partitionSession === 'string' && partitionSession !== sessionId) continue
    try {
      for await (const row of storage.readRows(tablePath, ['message_id', 'session_id'])) {
        if (stringValue(row.session_id) !== sessionId) continue
        const messageId = stringValue(row.message_id)
        if (messageId) state.seenMessages.add(messageId)
      }
    } catch {
      // Skip an unreadable partition; others still contribute.
      continue
    }
  }
}

/**
 * Feature-detect the committed-partition read surface. A bare storage stub
 * (unit tests that only assert row shape) has neither method, so seeding is
 * skipped and the projector behaves exactly as before.
 *
 * @param {ExtendedQueryStorageService | QueryStorageService | undefined} storage
 * @returns {storage is QueryStorageService}
 */
function canScanCommittedRows(storage) {
  return !!storage &&
    typeof storage.discoverCachePartitions === 'function' &&
    typeof storage.readRows === 'function'
}

/**
 * Mutable conversation-scoped state threaded across exchanges in a live
 * session: the started-at memo, per-conversation message-id history,
 * the cross-exchange dedup set, and the tool-call → tool-name lookup.
 *
 * Live capture keeps one instance per listener so identity fallback and
 * dedup span the whole session; backfill creates a fresh instance per
 * provider item (each item already carries a whole conversation), so the
 * identical expansion logic scopes naturally to that one conversation.
 */
export function createAiGatewayConversationState() {
  /** @type {Map<string, ThreadChain>} */
  const messageIdsByConversation = new Map()
  /** @type {Map<string, string>} */
  const conversationStartedAt = new Map()
  /** @type {Set<string>} */
  const seenMessages = new Set()
  /** @type {Map<string, Map<string, { tool_name?: string }>>} */
  const toolCallLookupByConversation = new Map()
  return { messageIdsByConversation, conversationStartedAt, seenMessages, toolCallLookupByConversation }
}

/**
 * Lazily fetch the per-thread ordered message-id chain. Keyed by
 * `(threadScope, agent_id)` where `threadScope = conversation_id ??
 * session_id`: a subagent (agent_id set) gets its own chain, separate
 * from the main loop, while agent_id null reuses the plain thread key.
 * Claude has conversation_id null, so it scopes by session; Codex keeps
 * scoping by its thread (conversation_id), both unchanged from before
 * the split, since Claude's old conversation_id WAS the session id.
 *
 * Holds a membership set plus the LAST chained id, not the ordered
 * array it once was: only the tail is ever read (the 0/1-element
 * `previous_message_id` link), and the array's linear `includes` per
 * message made projection O(n^2) over a long-running thread.
 *
 * @param {ReturnType<typeof createAiGatewayConversationState>} state
 * @param {string} threadScope
 * @param {string | undefined} agentId
 * @returns {ThreadChain}
 */
function threadMessageIds(state, threadScope, agentId) {
  const key = agentId ? `${threadScope}\u0000${agentId}` : threadScope
  let chain = state.messageIdsByConversation.get(key)
  if (!chain) {
    chain = { seen: new Set(), last: undefined, replayLinks: new Map() }
    state.messageIdsByConversation.set(key, chain)
  }
  return chain
}

/**
 * Expand one projected exchange into canonical `ai_gateway_messages`
 * rows. This is the SINGLE row-expansion implementation shared by live
 * capture (`createAiGatewayMessageProjector`) and backfill
 * materialization (the `ai_gateway.projected_exchange` materializer).
 * It owns:
 *
 *  - `message_id` fallback identity (hash of conversation/role/content)
 *    and the `previous_message_id` fallback chain,
 *  - per-part expansion (`expandMessageParts`),
 *  - the `gateway_id`, `schema_version`, and partition-relevant
 *    `client_name` / `date` stamping,
 *  - the row/projection/client/gateway `attributes` merge (adding
 *    `gateway.identity_source = 'gateway_fallback'` when identity was
 *    synthesized), and
 *  - stripping to the advertised `AI_GATEWAY_MESSAGE_COLUMNS` set.
 *
 * Cross-message dedup and identity history live on `state`, owned by the
 * caller. Live capture passes one persistent state per listener;
 * backfill passes a fresh state per conversation item (the default).
 *
 * Expansion MUTATES `state` (the dedup set and the per-thread chain) as it
 * builds rows, but the append that makes those rows real happens after this
 * returns. Pass `journal` and every such mutation records its undo, so a
 * caller whose append failed can call `rollbackAiGatewayStateJournal` and
 * leave the shared state describing what actually landed rather than what
 * was merely attempted (issue #879).
 *
 * @param {AiGatewayProjectedExchange} projection
 * @param {{
 *   gatewayId?: string,
 *   gatewayAttributes?: Record<string, unknown>,
 *   tsStart?: string,
 *   state?: ReturnType<typeof createAiGatewayConversationState>,
 *   journal?: (() => void)[],
 * }} [opts]
 * @returns {Record<string, unknown>[]}
 */
export function aiGatewayRowsFromProjectedExchange(projection, opts = {}) {
  const gatewayId = opts.gatewayId || 'hypaware-local'
  const journal = opts.journal
  const state = opts.state ?? createAiGatewayConversationState()
  const gatewayAttributes = opts.gatewayAttributes ?? {}
  const tsStart = opts.tsStart ?? stringValue(projection.conversation_started_at) ?? new Date().toISOString()

  // session_id is the partition key and the session container (always
  // present); conversation_id is the thread within it (Codex thread;
  // null for Claude). @ref LLP 0030#decision
  const sessionId = projection.session_id
  const conversationId = stringValue(projection.conversation_id)
  // Scope per-thread state by conversation_id when present (a Codex thread),
  // else by session_id (Claude, where conversation_id is null). One Codex
  // session_id can carry several thread conversation_ids, so keying these
  // maps by session_id would let a later thread inherit the first thread's
  // start time and cross-resolve tool-result names when tool_call ids
  // collide across threads. This is the SAME scope used for the
  // prior-message chain and fallback identity below. @ref LLP 0030#decision
  const threadScope = conversationId ?? sessionId
  if (!state.conversationStartedAt.has(threadScope)) {
    state.conversationStartedAt.set(
      threadScope,
      stringValue(projection.conversation_started_at) ?? tsStart
    )
  }
  const conversationStarted = state.conversationStartedAt.get(threadScope) ?? tsStart

  let conversationLookup = state.toolCallLookupByConversation.get(threadScope)
  if (!conversationLookup) {
    conversationLookup = new Map()
    state.toolCallLookupByConversation.set(threadScope, conversationLookup)
  }

  /** @type {Record<string, unknown>[]} */
  const rows = []

  for (let i = 0; i < projection.messages.length; i++) {
    const message = projection.messages[i]
    const role = stringValue(message.role)
    if (!role) continue
    const content = normalizeContent(message.content)
    if (content.length === 0) continue

    // The prior-message chain and fallback hash share `threadScope`
    // (above): a subagent's history (agent_id set) stays separate from the
    // main loop's, and a Codex thread scopes by its own conversation_id.
    // agent_id null (main loop / Codex) keeps the plain thread key.
    const agentId = stringValue(message.agent_id) ?? stringValue(projection.agent_id)
    const chain = threadMessageIds(state, threadScope, agentId)

    const identity = resolveIdentity({
      message,
      threadScope,
      agentId,
      role,
      content,
      lastMessageId: chain.last,
    })

    // A message a rollback un-marked but could NOT unchain (a later
    // exchange had already chained past it) keeps the predecessor it was
    // first projected with: this re-projection has to rebuild the row the
    // failed append never wrote, not hang the thread's earlier turns off
    // whatever tail has since been chained on. Issue #879. Only the
    // gateway-derived link is restored, because a projector-supplied
    // `previous_message_id` already replays identically.
    const buriedLink = chain.replayLinks.get(identity.messageId)
    if (buriedLink && !Array.isArray(message.previous_message_id)) {
      identity.previousMessageId = buriedLink
    }

    if (state.seenMessages.has(identity.messageId)) {
      chainMessageId(chain, identity.messageId, identity.previousMessageId, journal)
      continue
    }

    const parts = expandMessageParts({
      message,
      role,
      content,
      sessionId,
      conversationId,
      conversationStarted,
      messageIndex: i,
      tsStart,
      projection,
      identity,
      conversationLookup,
    })

    for (const row of parts) {
      row.gateway_id = gatewayId
      row.date = utcDate(row.message_created_at)
      row.attributes = mergeJsonObjects(
        mergeJsonObjects(/** @type {Record<string, unknown> | undefined} */ (row.attributes), projection.attributes),
        identity.fromFallback
          ? mergeJsonObjects(
            gatewayAttributes,
            { gateway: { identity_source: 'gateway_fallback' } }
          )
          : gatewayAttributes
      )
      rows.push(stripToSchema(row))
    }

    // Journaled, not merely applied: this is the mutation that makes a
    // re-delivery of the same batch project zero rows, so a caller whose
    // append then fails has to be able to take it back (issue #879).
    state.seenMessages.add(identity.messageId)
    journal?.push(() => { state.seenMessages.delete(identity.messageId) })
    chainMessageId(chain, identity.messageId, identity.previousMessageId, journal)
  }

  return rows
}

/**
 * Record one message in its thread chain (membership plus the
 * `previous_message_id` tail), pushing the undo onto `journal` when the
 * caller asked for one.
 *
 * The chain undo has TWO shapes, because one conversation state is shared by
 * every in-flight exchange of a listener (the proxy fires
 * `onExchangeFinished` into an unserialized pending set, and
 * `projectExchange` awaits before it expands), so a later exchange can have
 * chained further turns onto the same thread by the time a rollback runs:
 *
 *  - Still the tail (the sequential case, and the last-in-first-out order
 *    this journal replays in): unchain it. The re-projection re-walks the
 *    thread and rebuilds the identical link.
 *  - No longer the tail: leave `chain.seen` and `chain.last` alone and
 *    record the link this message HAD in `chain.replayLinks`. Unchaining a
 *    buried message would strand the turns chained after it, which stay in
 *    `chain.seen` so nothing re-chains them, settling the tail before them
 *    and making every later row's `previous_message_id` skip a turn. But
 *    leaving it at that is not enough either: the re-projection would emit
 *    the buried message hanging off the CURRENT tail, so the thread's
 *    opening turns would claim to follow turns that actually follow them
 *    (a forward link, and a cycle once the later turn already links back to
 *    this one). The replay link is what keeps both properties.
 *
 * `chain.replayLinks` entries are deliberately not consumed on read: a
 * second failed attempt has to replay the same link, and they are bounded by
 * `chain.seen`, which is already one entry per message.
 *
 * @param {ThreadChain} chain
 * @param {string} messageId
 * @param {string[]} previousMessageId The link this message was projected
 *   with, restored verbatim if a rollback cannot unchain it.
 * @param {(() => void)[] | undefined} journal
 * @returns {void}
 */
function chainMessageId(chain, messageId, previousMessageId, journal) {
  if (chain.seen.has(messageId)) return
  const previousLast = chain.last
  chain.seen.add(messageId)
  chain.last = messageId
  journal?.push(() => {
    if (chain.last !== messageId) {
      chain.replayLinks.set(messageId, previousMessageId)
      return
    }
    chain.seen.delete(messageId)
    chain.last = previousLast
  })
}

/**
 * Undo, newest first, every state mutation a journaled row expansion made,
 * then empty the journal so it cannot be replayed.
 *
 * The dedup set and the thread chain are process-lifetime state shared by
 * every live producer of `ai_gateway_messages`, and expansion commits to
 * them before the rows reach storage. Without this, one failed
 * `appendRows` makes that batch permanently unwritable: the producer's
 * retry re-projects the same messages, every one of them is now "seen",
 * and the call returns `rowsWritten: 0` as though there had been nothing
 * to write - a silent loss, not an error. Rolling back is the cheap
 * direction of the trade, because re-projecting a row that DID land is
 * caught by the `part_id` dedupe, while a row wrongly marked seen is gone
 * until transcript backfill finds it.
 *
 * @ref LLP 0252#projection-unchanged [implements]: the dataset's `part_id`
 *   dedupe absorbs a row projected twice, which is what makes rolling the
 *   seen-set back safe
 * @param {(() => void)[]} journal
 * @returns {void}
 */
export function rollbackAiGatewayStateJournal(journal) {
  for (let i = journal.length - 1; i >= 0; i--) journal[i]()
  journal.length = 0
}

/**
 * @param {RegisteredProjector[]} projectors
 * @param {AiGatewayExchangeInput} input
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 * @param {(sessionId: string) => boolean} isSessionIgnored
 * @returns {Promise<AiGatewayProjectedExchange | UsagePolicyDrop | undefined>}
 */
async function dispatchProjector(projectors, input, log, isSessionIgnored) {
  if (projectors.length === 0) return undefined
  const matching = projectors
    .filter((p) => safeMatch(p, input, log))
    .sort(byPriorityThenSeq)
  // The projector ctx already carries the logger; fold in the read-only
  // ignored-session membership test so an adapter can key its own resolved
  // session_id against the gateway's opt-out set. @ref LLP 0066#enforcement
  const ctx = { log: { ...noopLogger(), ...(log ?? {}) }, isSessionIgnored }
  for (const projector of matching) {
    let result
    try {
      result = await Promise.resolve(projector.project(input, ctx))
    } catch (err) {
      log?.warn?.('aigw.projector_error', {
        projector: projector.name,
        exchange_id: stringValue(input.exchange_id) ?? '',
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    // A usage-policy drop is TERMINAL: stop the walk and propagate the sentinel
    // so the drop wins outright. Crucially we do NOT `continue` here (which is
    // what a bare `undefined` decline does below) so a later overlapping
    // projector can never record an exchange the user asked to suppress.
    // @ref LLP 0050 [implements]
    if (isUsagePolicyDrop(result)) return result
    if (!isValidProjection(result)) {
      if (result !== undefined) {
        log?.warn?.('aigw.projector_invalid_output', {
          projector: projector.name,
          exchange_id: stringValue(input.exchange_id) ?? '',
        })
      }
      continue
    }
    if (result.messages.length === 0) continue
    return result
  }
  return undefined
}

/**
 * @param {RegisteredProjector} projector
 * @param {AiGatewayExchangeInput} input
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 */
function safeMatch(projector, input, log) {
  try {
    return projector.match(input) === true
  } catch (err) {
    log?.warn?.('aigw.projector_match_error', {
      projector: projector.name,
      exchange_id: stringValue(input.exchange_id) ?? '',
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * @param {RegisteredProjector} a
 * @param {RegisteredProjector} b
 */
function byPriorityThenSeq(a, b) {
  const ap = typeof a.priority === 'number' ? a.priority : 0
  const bp = typeof b.priority === 'number' ? b.priority : 0
  if (ap !== bp) return bp - ap
  return a._seq - b._seq
}

/**
 * @param {unknown} value
 * @returns {value is AiGatewayProjectedExchange}
 */
function isValidProjection(value) {
  if (!isPlainObject(value)) return false
  if (typeof value.provider !== 'string' || value.provider.length === 0) return false
  // session_id is the non-null partition key; conversation_id is now
  // nullable (null for Claude). @ref LLP 0030#decision
  if (typeof value.session_id !== 'string' || value.session_id.length === 0) return false
  if (!Array.isArray(value.messages)) return false
  return true
}

/**
 * @param {{
 *   message: AiGatewayProjectedMessage,
 *   threadScope: string,
 *   agentId: string | undefined,
 *   role: string,
 *   content: Array<Record<string, unknown>>,
 *   lastMessageId: string | undefined,
 * }} ctx
 */
// @ref LLP 0026#consequences [implements]: store only the immediate
// predecessor, not the full ancestry; full chain is reconstructable by
// walking links, and the prior O(N) chain made the column quadratic.
function resolveIdentity(ctx) {
  // `previous_message_id` carries the IMMEDIATE predecessor in this
  // THREAD (a 0- or 1-element array), scoped to (conversation_id,
  // agent_id) by the caller's chain state, whether `message_id` was
  // projector-supplied (transcript uuid) or hash-synthesized here. The
  // full ancestry is the transitive closure of this link; the native
  // DAG parent lives in `parent_uuid`. Storing the whole chain per row
  // was O(N) per message → O(N²) per thread and dominated the cache
  // (defeats hyparquet's dictionary encoding once the growing strings
  // pass its cardinality/page-size guards).
  // Projector-supplied history still wins when present.
  const previousFromMessage = Array.isArray(ctx.message.previous_message_id)
    ? ctx.message.previous_message_id.filter((id) => typeof id === 'string')
    : undefined
  const previousMessageId = previousFromMessage ?? (ctx.lastMessageId !== undefined ? [ctx.lastMessageId] : [])
  const supplied = stringValue(ctx.message.message_id)
  if (supplied) {
    return {
      messageId: supplied,
      previousMessageId,
      fromFallback: false,
    }
  }
  return {
    messageId: computeMessageId(ctx.threadScope, ctx.role, ctx.content, ctx.agentId),
    previousMessageId,
    fromFallback: true,
  }
}

/**
 * Expand one projected message into its per-part rows. The gateway
 * is opinionated about how a normalized `content` block maps onto the
 * `ai_gateway_messages` part columns (role/tool_use/tool_result/etc.)
 * because the part schema is gateway-owned. Adapter projectors
 * decide WHAT messages look like; this function decides HOW they
 * become rows.
 *
 * @param {{
 *   message: AiGatewayProjectedMessage,
 *   role: string,
 *   content: Array<Record<string, unknown>>,
 *   sessionId: string,
 *   conversationId: string | undefined,
 *   conversationStarted: string,
 *   messageIndex: number,
 *   tsStart: string,
 *   projection: AiGatewayProjectedExchange,
 *   identity: { messageId: string, previousMessageId: string[], fromFallback: boolean },
 *   conversationLookup: Map<string, { tool_name?: string }>,
 * }} ctx
 * @returns {Record<string, unknown>[]}
 */
function expandMessageParts(ctx) {
  const finishReason = mapFinishReason(stringValue(ctx.message.stop_reason))
  const messageCreatedAt = stringValue(ctx.message.message_created_at) ?? ctx.tsStart
  const messageAttributes = ctx.message.attributes
  // @ref LLP 0035#one-carrier [implements]: response-level `usage` is
  // per-response, so a multi-block carrier message must not replicate it onto
  // every part. Strip `usage` from all but the last part; the last block (the
  // terminal output item, which also carries `stop_reason`/status) is the sole
  // carrier. Closes the residual edge LLP 0035 assumed wasn't produced.
  const nonCarrierAttributes = stripUsage(messageAttributes)
  const baseClientAttributes = withClientAttributes(
    undefined,
    stringValue(ctx.projection.client_version),
    stringValue(ctx.projection.client_name)
  )

  const base = {
    schema_version: SCHEMA_VERSION,
    session_id: ctx.sessionId,
    conversation_id: ctx.conversationId,
    user_id: ctx.projection.user_id,
    // @ref LLP 0194#decision [implements]: per-message provider wins over the
    // exchange provider, the LLP 0026 model precedence extended to the column
    // it skipped; a mixed-provider backfilled session stops reading as its
    // first projected turn's vendor.
    provider: stringValue(ctx.message.provider) ?? ctx.projection.provider,
    // @ref LLP 0026#consequences [implements]: the message envelope (incl.
    // model) mirrors the transcript: backfill records the per-line model on
    // assistant messages only, so the per-message value wins where present and
    // mixed-model sessions stay accurate. When a message has no model the row
    // falls back to the exchange model (which for live capture is the one
    // model per exchange (landing on user rows too), and for backfill is unset
    // (backfilled user/tool_result rows carry no model, by design)).
    model: stringValue(ctx.message.model) ?? ctx.projection.model,
    system_text: ctx.projection.system_text,
    tools: ctx.projection.tools,
    conversation_started_at: ctx.conversationStarted,
    conversation_source: ctx.projection.conversation_source,
    client_name: stringValue(ctx.projection.client_name),
    cwd: ctx.projection.cwd,
    git_branch: ctx.projection.git_branch,
    // @ref LLP 0032#capture: repo identity for the graph bridge, exchange-level
    // like cwd/git_branch (captured by the Claude hook / Codex turn metadata).
    git_remote: ctx.projection.git_remote,
    head_sha: ctx.projection.head_sha,
    repo_root: ctx.projection.repo_root,
    client_version: ctx.projection.client_version,
    entrypoint: stringValue(ctx.message.entrypoint) ?? ctx.projection.entrypoint,
    user_type: stringValue(ctx.message.user_type) ?? ctx.projection.user_type,
    permission_mode: stringValue(ctx.message.permission_mode) ?? ctx.projection.permission_mode,
    is_sidechain: typeof ctx.message.is_sidechain === 'boolean'
      ? ctx.message.is_sidechain
      : ctx.projection.is_sidechain,
    agent_id: stringValue(ctx.message.agent_id) ?? stringValue(ctx.projection.agent_id),
    parent_thread_id: stringValue(ctx.message.parent_thread_id) ?? stringValue(ctx.projection.parent_thread_id),
    message_id: ctx.identity.messageId,
    previous_message_id: ctx.identity.previousMessageId,
    provider_uuid: stringValue(ctx.message.provider_uuid),
    parent_uuid: stringValue(ctx.message.parent_uuid),
    logical_parent_uuid: stringValue(ctx.message.logical_parent_uuid),
    source_tool_assistant_uuid: stringValue(ctx.message.source_tool_assistant_uuid),
    request_id: stringValue(ctx.message.request_id) ?? ctx.projection.request_id,
    prompt_id: stringValue(ctx.message.prompt_id) ?? ctx.projection.prompt_id,
    message_index: ctx.messageIndex,
    message_created_at: messageCreatedAt,
    role: ctx.role,
    attachment_type: stringValue(ctx.message.attachment_type),
    hook_event: stringValue(ctx.message.hook_event),
    is_compact_summary: typeof ctx.message.is_compact_summary === 'boolean'
      ? ctx.message.is_compact_summary
      : undefined,
    compact_metadata: ctx.message.compact_metadata,
  }

  return ctx.content.map((block, partIndex) => {
    const isLast = partIndex === ctx.content.length - 1
    const blockType = typeof block?.type === 'string' ? block.type : undefined
    const partType = mapPartType(blockType)
    const toolCallId = extractToolCallId(block)
    const toolName = extractToolName(block, toolCallId, ctx.conversationLookup)
    const row = {
      ...base,
      part_id: `${ctx.identity.messageId}#${partIndex}`,
      part_index: partIndex,
      part_type: partType,
      provider_type: stringValue(ctx.message.provider_type),
      provider_subtype: stringValue(ctx.message.provider_subtype) ?? blockType,
      content_text: extractContentText(block),
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_args: blockType === 'tool_use' || blockType === 'server_tool_use'
        ? readKey(block, 'input')
        : undefined,
      caller_type: readCallerType(block),
      tool_result_for: blockType === 'tool_result' || blockType === 'web_search_tool_result'
        ? toolCallId
        : undefined,
      thinking_signature: blockType === 'thinking' || blockType === 'redacted_thinking'
        ? stringValue(readKey(block, 'signature'))
        : undefined,
      is_error: readKey(block, 'is_error') === true ? true : undefined,
      status: buildStatus(block, isLast, ctx.role, finishReason),
      attributes: mergeJsonObjects(baseClientAttributes, isLast ? messageAttributes : nonCarrierAttributes),
      raw_frame: isPlainObject(ctx.message.raw_frame) ? ctx.message.raw_frame : undefined,
    }
    if (
      partType === 'tool_call' &&
      typeof toolCallId === 'string' &&
      typeof toolName === 'string'
    ) {
      ctx.conversationLookup.set(toolCallId, { tool_name: toolName })
    }
    return row
  })
}

/**
 * Fallback identity hash. Volatile wire-only fields are stripped
 * before hashing: clients move the `cache_control` prompt-cache
 * breakpoint between exchanges, so hashing it would give the same
 * logical message a new id on every replay where the breakpoint
 * shifted (each one a duplicate row the seen-set cannot catch).
 * The strip list (`VOLATILE_BLOCK_FIELDS` in core util) is shared with
 * the claude plugin's transcript match key, so the fallback id and the
 * match key canonicalize a block identically. Reached only for an
 * *unmatched* assistant tool_use (a matched one carries its native
 * uuid), so the split is rare, but stripping `caller` keeps the two
 * representations of one tool_use from landing as duplicate fallback
 * rows when it does happen.
 *
 * // @ref LLP 0030#decision: the thread scope is `conversation_id ??
 * // session_id`: for Claude (conversation_id null) that is the session
 * // id, the same value the pre-split conversation_id held, so Claude
 * // fallback ids are unchanged; for Codex it is the thread. agent_id
 * // separates a subagent thread from the main loop so two agents with
 * // identical content in one session don't collide on one fallback id.
 * // Omitted from the hash when absent (main loop / Codex) so those ids
 * // are unchanged.
 *
 * @param {string} threadScope
 * @param {string} role
 * @param {unknown} content
 * @param {string} [agentId]
 */
export function computeMessageId(threadScope, role, content, agentId) {
  const scope = agentId ? `${threadScope}:${agentId}` : threadScope
  return sha256Hex(`${scope}:${role}:${canonicalJson(stripVolatileBlockFields(content))}`).slice(0, 16)
}

/** @param {string | undefined | null} stopReason */
export function mapFinishReason(stopReason) {
  if (stopReason == null) return undefined
  switch (stopReason) {
  case 'end_turn': return 'stop'
  case 'stop_sequence': return 'stop'
  case 'max_tokens': return 'length'
  case 'tool_use': return 'tool_use'
  case 'pause_turn': return 'pause'
  case 'refusal': return 'refusal'
  case 'error': return 'error'
  default: return stopReason
  }
}

/** @param {string | undefined} blockType */
export function mapPartType(blockType) {
  switch (blockType) {
  case 'text': return 'text'
  case 'thinking': return 'reasoning'
  case 'redacted_thinking': return 'reasoning'
  case 'tool_use': return 'tool_call'
  case 'server_tool_use': return 'tool_call'
  case 'tool_result': return 'tool_result'
  case 'web_search_tool_result': return 'tool_result'
  case 'image': return 'image'
  case 'document': return 'file'
  case 'file': return 'file'
  case 'error': return 'error'
  default: return typeof blockType === 'string' && blockType.length > 0 ? blockType : 'text'
  }
}

/** @param {unknown} content */
function normalizeContent(content) {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) return /** @type {Array<Record<string, unknown>>} */ (content)
  return []
}

// An inline `data:<mime>;base64,<payload>` is the bytes of a file (usually a
// screenshot a tool handed back), not text: nothing reads it, nothing searches
// it, and it dwarfs every real value in the column. The array path already
// dropped it, since `textFromContentBlocks` keeps only `part.text` and an
// `input_image` block has none, but a tool result that reaches the projector
// ALREADY STRINGIFIED (Codex `view_image` returns
// `[{"type":"input_image","image_url":"data:image/png;base64,..."}]` as one
// string) becomes a single `text` block and was stored whole. Identical content
// therefore cost either nothing or 12MB per row depending on an upstream
// serialization choice: one production day held 124.5MB of base64 across 35
// rows, 98.6% of all `content_text`, and a single 12.67MB value made the search
// index unbuildable (its 9.3M distinct 5-grams overflow V8's Set cap).
//
// Any `;base64,` payload is stripped, not just images: none of them are text.
// The marker stays so the row still records that a payload was there and a
// search for `input_image` or `image_url` still finds it. Only the bytes go.
//
// The marker echoes the mediatype that was on the wire rather than a fixed
// `image`, so the row does not assert something false about what was captured:
// a `data:application/pdf` payload used to be rewritten to claim it was an
// image, and a search for the real mediatype missed the row (#722). The
// mediatype is echoed verbatim, not normalized through an allowlist; the
// prefix class already caps it at 255 characters and excludes whitespace and
// `,`, and what was actually sent is the honest thing to record.
//
// #722's allowlist reservation is closed, verbatim, permanently (#736). An
// allowlist cannot make the marker trustworthy: `data:application/pdf;base64,
// <stripped>` typed into an ordinary message passes this regex byte-for-byte
// untouched, because `<` is outside the payload class `[A-Za-z0-9+/=_-]+`
// (which also requires at least one character), so a consumer that trusted a
// structured-looking marker could already be fed a byte-identical forgery by
// the wire, allowlisted mediatype or not. The mediatype class does close
// one channel: it excludes all whitespace and `,`, so a marker can never
// carry a newline, carriage return, tab, or a comma to splice a log line
// or a CSV cell. That class is negated, though, not an allowlist, so it
// admits every other control character. ESC survives into `content_text`:
// `data:evil<ESC>[31mX;base64,QUFB` strips to
// `data:evil<ESC>[31mX;base64,<stripped>`, ESC intact, and the default
// `table` query-output format does not escape it before writing it to the
// terminal. Neutralizing terminal escapes is a `content_text` rendering
// concern for every column, not something an allowlist on this one
// mediatype would fix; it is open, tracked in #752.
//
// The capture group only changes what the replacement does. It must not change
// what matches: the prefix class stays `[^\s,]{0,255}?` so a `data:` cannot
// splice onto an unrelated `;base64,` across prose, a comma, or 255 characters.
//
// Idempotency survives the varying marker on two locks, and the comma is the
// load-bearing one: `[^\s,]` excludes `,` and every `;base64,` ends in one, so
// a captured mediatype can never contain a `;base64,`. The emitted marker
// therefore holds exactly one, always followed by `<`, which the payload class
// also excludes, so it can neither re-match in place nor splice onto a later
// `;base64,` by backtracking past `<stripped>`. Admitting `,` to the mediatype
// class would break idempotency, not just splice safety.
//
// This bounds only the matched forms, so `content_text` is NOT guaranteed
// bounded. A line-wrapped or `\n`-escaped payload still has its tail survive
// as bare base64 text, because the match stops at the newline. A general
// length cap on `content_text` is a deliberate open question (#718) and is
// not addressed here.
const BASE64_DATA_URI = /data:([^\s,]{0,255}?);base64,[A-Za-z0-9+/=_-]+/g

// The empty-mediatype case (`data:;base64,...`) falls back to this rather
// than echoing an empty string or resolving it the way RFC 2397 does (an
// omitted mediatype means `text/plain;charset=US-ASCII`). Kept as shipped,
// deliberately, after re-examination (#736): the RFC default answers "what
// would a browser render this as", not "what did the row actually see", and
// a search for it is no more discriminating than this sentinel. The
// accepted cost: this collides indistinguishably with a genuine
// `application/octet-stream` payload, and a literal search for
// `data:;base64` no longer finds the row. Low stakes either way.
const UNKNOWN_MEDIATYPE = 'application/octet-stream'

/** @param {string | undefined} text */
function stripBase64DataUris(text) {
  // Cheap reject first: this runs on every captured part, and almost none of
  // them carry a payload.
  if (text === undefined || !text.includes(';base64,')) return text
  // A replacer function, not a `$1` template: the empty mediatype
  // (`data:;base64,`) has to fall back to `application/octet-stream`, and a
  // template string cannot express that. A `$1` template would be safe against
  // a `$` in the mediatype (a substituted capture is never re-scanned for
  // replacement patterns), so that is not the reason.
  return text.replace(BASE64_DATA_URI, (_match, mediatype) => `data:${mediatype || UNKNOWN_MEDIATYPE};base64,<stripped>`)
}

/**
 * Strip at the one place every branch funnels through (plain string,
 * `tool_result` string, `tool_result` array, thinking, error), so a branch
 * added later inherits the rule instead of reopening the hole.
 *
 * @param {unknown} block
 */
function extractContentText(block) {
  return stripBase64DataUris(readContentText(block))
}

/** @param {unknown} block */
function readContentText(block) {
  if (!isPlainObject(block)) return undefined
  switch (block.type) {
  case 'text':
    return stringValue(block.text)
  case 'thinking':
    return stringValue(block.thinking)
  case 'redacted_thinking':
    return stringValue(block.data)
  case 'tool_result': {
    const c = block.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return textFromContentBlocks(c)
    return undefined
  }
  case 'error':
    return stringValue(block.message) ?? stringValue(block.text)
  default:
    return undefined
  }
}

/** @param {unknown[]} blocks */
function textFromContentBlocks(blocks) {
  const parts = blocks
    .filter(isPlainObject)
    .map((part) => stringValue(part.text))
    .filter((text) => typeof text === 'string')
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** @param {unknown} block */
function extractToolCallId(block) {
  if (!isPlainObject(block)) return undefined
  if (block.type === 'tool_use' || block.type === 'server_tool_use') return stringValue(block.id)
  if (block.type === 'tool_result' || block.type === 'web_search_tool_result') return stringValue(block.tool_use_id)
  return undefined
}

/**
 * @param {unknown} block
 * @param {string | undefined} tool_call_id
 * @param {Map<string, { tool_name?: string }> | undefined} lookup
 */
function extractToolName(block, tool_call_id, lookup) {
  if (!isPlainObject(block)) return undefined
  if (block.type === 'tool_use' || block.type === 'server_tool_use') return stringValue(block.name)
  if ((block.type === 'tool_result' || block.type === 'web_search_tool_result') && tool_call_id && lookup) {
    return lookup.get(tool_call_id)?.tool_name
  }
  return undefined
}

/** @param {unknown} block */
function readCallerType(block) {
  if (!isPlainObject(block)) return undefined
  const caller = block.caller
  if (!isPlainObject(caller)) return undefined
  return stringValue(caller.type)
}

/**
 * @param {unknown} block
 * @param {boolean} isLastPart
 * @param {string} role
 * @param {string | undefined} finishReason
 */
function buildStatus(block, isLastPart, role, finishReason) {
  /** @type {Record<string, unknown>} */
  const status = {}
  const b = isPlainObject(block) ? block : undefined
  if (b && (b.type === 'tool_result' || b.type === 'web_search_tool_result')) {
    status.tool_status = b.is_error === true ? 'error' : 'success'
  }
  if (isLastPart && role === 'assistant' && finishReason) status.finish_reason = finishReason
  if (b && b.type === 'error') {
    if (typeof b.error_code === 'string') status.error_code = b.error_code
    if (typeof b.code === 'string' && status.error_code == null) status.error_code = b.code
    if (typeof b.message === 'string') status.error_message = b.message
    if (typeof b.text === 'string' && status.error_message == null) status.error_message = b.text
  }
  return Object.keys(status).length === 0 ? undefined : status
}

/**
 * Stamp `attributes.client.{name,version}` on every emitted row when
 * the projector supplied client identity. The 1.x gateway carried a
 * special-case for Anthropic's `claude_version` field; that wart is
 * gone (adapters now choose what `client.name` is and the gateway
 * just propagates it).
 *
 * @param {Record<string, unknown> | undefined} attributes
 * @param {string | undefined} clientVersion
 * @param {string | undefined} clientName
 */
function withClientAttributes(attributes, clientVersion, clientName) {
  if (!clientVersion && !clientName) return attributes
  const out = attributes ? { ...attributes } : {}
  const client = isPlainObject(out.client) ? { ...out.client } : {}
  if (clientName) client.name = clientName
  if (clientVersion) client.version = clientVersion
  out.client = client
  return out
}

/** @param {AiGatewayExchangeInput} exchange */
function buildGatewayAttributes(exchange) {
  /** @type {Record<string, unknown>} */
  const attrs = {}
  const devRunId = readDevRunId(exchange)
  if (devRunId) attrs.dev_run_id = devRunId
  attrs.gateway = {
    exchange_id: stringValue(exchange.exchange_id),
    upstream: stringValue(exchange.upstream),
    method: stringValue(exchange.method ?? undefined),
    path: stringValue(exchange.path ?? undefined),
    status_code: exchange.status_code ?? undefined,
    request_bytes: exchange.request_bytes ?? undefined,
    response_bytes: exchange.response_bytes ?? undefined,
    is_sse: exchange.is_sse ?? undefined,
    stream_event_count: exchange.stream_event_count ?? undefined,
    request_headers: parseMaybeJson(exchange.request_headers),
    response_headers: parseMaybeJson(exchange.response_headers),
    error: stringValue(exchange.error ?? undefined),
  }
  return attrs
}

/**
 * Drop response-level `usage` from a message's attributes, for the
 * non-carrier parts of a multi-block message. Returns the input
 * unchanged when there's no `usage`, and `undefined` when `usage` was
 * the only key (so non-carrier parts fall back to client attributes).
 *
 * @ref LLP 0035#one-carrier: usage is per-response; only the last part carries it.
 * @param {Record<string, unknown> | undefined} attributes
 * @returns {Record<string, unknown> | undefined}
 */
function stripUsage(attributes) {
  if (!isPlainObject(attributes) || attributes.usage === undefined) return attributes
  const { usage, ...rest } = attributes
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * Right-biased deep merge for one level of nested objects. Used both
 * to fold projection-level attributes into per-row attributes and to
 * stamp `attributes.gateway.*` provenance on top of whatever the
 * adapter supplied.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {Record<string, unknown> | undefined}
 */
function mergeJsonObjects(a, b) {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (isPlainObject(a)) Object.assign(out, a)
  if (isPlainObject(b)) {
    for (const [key, value] of Object.entries(b)) {
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = { ...out[key], ...value }
      } else {
        out[key] = value
      }
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** @param {Record<string, unknown>} row */
function stripToSchema(row) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const column of AI_GATEWAY_MESSAGE_COLUMNS) {
    if (SCHEMA_COLUMN_NAMES.has(column.name)) out[column.name] = row[column.name]
  }
  return out
}

/** @param {unknown} value */
function utcDate(value) {
  const date = new Date(typeof value === 'bigint' ? Number(value) : /** @type {any} */ (value))
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return date.toISOString().slice(0, 10)
}

/** @param {AiGatewayExchangeInput} exchange */
function readDevRunId(exchange) {
  const metadata = parseMaybeJson(exchange.metadata)
  if (isPlainObject(metadata)) {
    const fromMetadata = stringValue(metadata.dev_run_id)
    if (fromMetadata) return fromMetadata
  }
  const headers = parseMaybeJson(exchange.request_headers)
  return readHeaderValue(headers, 'x-hyp-dev-run-id')
}

/** @param {unknown} headers @param {string} name */
function readHeaderValue(headers, name) {
  if (!isPlainObject(headers)) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/** @param {unknown} obj @param {string} key */
function readKey(obj, key) {
  if (!isPlainObject(obj)) return undefined
  return obj[key]
}

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}
