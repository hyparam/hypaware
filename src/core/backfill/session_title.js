// @ts-check

import { createHash } from 'node:crypto'

/** @import { AiGatewayProjectedExchange } from '../../../hypaware-plugin-kernel-types.js' */

/**
 * Preserve a native name without mutating already-deduplicated message rows.
 * The metadata part lives on the last content day, so a rename invalidates
 * that day's summary without changing the conversation's activity span, and
 * each later content day gets its own copy of the current name.
 * @ref LLP 0556#updates [implements]: append-only title revisions survive message deduplication
 * @param {AiGatewayProjectedExchange} exchange
 * @param {unknown} title
 * @param {{ updatedAt: string, revision?: string }} opts
 * @returns {boolean}
 */
export function captureSessionTitle(exchange, title, opts) {
  if (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 4096) return false
  const time = Date.parse(opts.updatedAt)
  if (!Number.isFinite(time) || Math.abs(time) > 8640000000000000) return false
  const lastAt = exchange.messages.reduce((latest, message) => {
    const at = message.message_created_at
    return at && Number.isFinite(Date.parse(at)) && (!latest || at > latest) ? at : latest
  }, /** @type {string | undefined} */ (undefined))
  if (!lastAt) return false
  const session = { title: title.trim(), title_updated_at: new Date(time).toISOString() }
  // The content day is part of the identity: a session continuing on a new
  // UTC day re-emits its current name there, so the newest day carries it.
  const day = new Date(lastAt).toISOString().slice(0, 10)
  const id = createHash('sha256').update(JSON.stringify([
    exchange.client_name, exchange.session_id, exchange.conversation_id,
    opts.revision ?? session.title_updated_at, session.title, day,
  ])).digest('hex')
  exchange.messages.push({
    role: 'system', message_id: `session-title:${id}`, previous_message_id: [],
    message_created_at: lastAt, message_index: 2147483647,
    content: [{ type: 'session_metadata' }], attributes: { session },
  })
  return true
}
