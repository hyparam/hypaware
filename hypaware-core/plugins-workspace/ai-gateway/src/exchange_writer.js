// @ts-check

import {
  AI_GATEWAY_SCHEMA_COLUMNS,
  aiGatewayTablePath,
  dedupeStoredPartIds,
} from './dataset.js'
import {
  aiGatewayRowsFromProjectedExchange,
  createAiGatewayConversationState,
  rollbackAiGatewayStateJournal,
} from './message_projector.js'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayRecordOptions, AiGatewayRecordResult, QueryStorageService } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * The write half of the `ai_gateway_messages` producer contract, for a
 * live producer that is not the proxy recorder.
 *
 * The proxy has a recorder, a wire exchange, and a projector chain in
 * front of it; a producer that already holds a finished
 * `AiGatewayProjectedExchange` (the Claude OTEL telemetry listener)
 * needs only the last two steps, and must not reimplement them: row
 * expansion, `part_id` identity, the schema strip, the table path, and
 * the dedupe are the dataset owner's business, not the producer's.
 *
 * One conversation state is held for the process lifetime, exactly as
 * the live projector holds one per listener: it is what makes a
 * re-delivered event collapse instead of appending a second copy, and
 * what threads `previous_message_id` across calls within a session.
 *
 * @ref LLP 0252#projection-unchanged [implements]: OTEL is a third producer of
 *   the same dataset, so it enters through the same expansion and dedupe as the
 *   proxy and the backfill materializer
 * @param {{ storage: QueryStorageService, gatewayId?: string }} opts
 */
export function createProjectedExchangeWriter(opts) {
  const { storage, gatewayId } = opts
  const state = createAiGatewayConversationState()
  /** @type {string | undefined} */
  let tablePath

  return {
    /**
     * Expand one projection into rows, drop the parts some other
     * producer already stored, and append what is left.
     *
     * Expansion marks its messages seen in the process-lifetime state
     * BEFORE the append runs, so a rejecting write is rolled back here.
     * This method's caller is a producer that retries (the Claude OTEL
     * listener answers HTTP 500 and the client re-POSTs the batch);
     * without the rollback that retry finds every message already seen,
     * writes nothing, and reports `rowsWritten: 0` as though the batch
     * had been empty. Issue #879.
     *
     * @param {AiGatewayProjectedExchange} projection
     * @param {AiGatewayRecordOptions} [recordOpts]
     * @returns {Promise<AiGatewayRecordResult>}
     */
    async record(projection, recordOpts = {}) {
      /** @type {(() => void)[]} */
      const journal = []
      // Expansion is INSIDE the try: it marks messages seen as it walks
      // caller-supplied projection content, so a throw partway through
      // would otherwise leave those marks standing with no rows written -
      // issue #879 again, one step earlier.
      try {
        const rows = aiGatewayRowsFromProjectedExchange(projection, {
          ...(gatewayId ? { gatewayId } : {}),
          ...(recordOpts.gatewayAttributes ? { gatewayAttributes: recordOpts.gatewayAttributes } : {}),
          state,
          journal,
        })
        if (rows.length === 0) return { rowsWritten: 0, rowsSkipped: 0 }
        const fresh = await dedupeStoredPartIds(rows, storage)
        if (fresh.length > 0) {
          if (tablePath === undefined) tablePath = aiGatewayTablePath(storage)
          await storage.appendRows(tablePath, [...AI_GATEWAY_SCHEMA_COLUMNS], fresh)
        }
        return { rowsWritten: fresh.length, rowsSkipped: rows.length - fresh.length }
      } catch (err) {
        rollbackAiGatewayStateJournal(journal)
        throw err
      }
    },
  }
}
