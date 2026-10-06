// @ts-check

import path from 'node:path'
import { isPlainObject, stringValue } from 'hypaware/core/util'

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage } from '../../../../hypaware-plugin-kernel-types.js' */

/** Resolve only explicit hook workspace evidence, never the daemon cwd.
 * @param {Record<string, unknown>} event
 */
export function cursorCwd(event) {
  // The existing export policy has one cwd per row. Do not let a permissive
  // root cause content from another workspace root to be exported.
  if (Array.isArray(event.workspace_roots) && event.workspace_roots.length > 1) return undefined
  const cwd = stringValue(event.cwd)
  if (cwd && cwd.length <= 4096 && path.isAbsolute(cwd)) return cwd
  const roots = event.workspace_roots
  if (Array.isArray(roots) && roots.length === 1 && typeof roots[0] === 'string' && roots[0].length <= 4096 && path.isAbsolute(roots[0])) return roots[0]
  return undefined
}

/**
 * Additional file observation; conversation hooks only schedule recovery.
 * No raw frame is copied: hooks carry unrelated identity and private fields.
 * @param {unknown} raw
 * @returns {AiGatewayProjectedExchange | undefined}
 * @ref LLP 0399#identity: file observations retain their own delivery identity
 */
export function projectCursorHook(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.event)) return undefined
  const event = raw.event
  const session = stringValue(event.conversation_id)
  const generation = stringValue(event.generation_id)
  const delivery = stringValue(raw.delivery_id)
  const cwd = cursorCwd(event)
  const observed = stringValue(raw.observed_at)
  if (!session || !delivery || !cwd || !observed || !Number.isFinite(Date.parse(observed))) return undefined
  // Bound strings retained by the shared writer's identity maps, not just
  // the transient request body. Native UUIDs are far below this limit.
  if ([session, generation, delivery, stringValue(event.tool_use_id)].some((v) => v && v.length > 256)) return undefined
  const hook = stringValue(event.hook_event_name)
  /** @type {AiGatewayProjectedMessage | undefined} */
  let message
  const id = (...parts) => 'cursor:' + JSON.stringify([session, ...parts])
  if (hook === 'beforeReadFile' && typeof event.content === 'string') {
    const file = stringValue(event.file_path)
    if (!file || file.length > 4096 || !path.isAbsolute(file)) return undefined
    // @ref LLP 0399#file-content: permission-stage observations have no tool id.
    message = { role: 'system', message_id: id('file', delivery), content: event.content,
      provider_type: 'hook', hook_event: hook }
  }
  if (!message) return undefined
  const duration = event.duration_ms ?? event.duration
  message.message_created_at = observed
  message.previous_message_id = []
  return {
    provider: 'unknown',
    session_id: session,
    conversation_id: session,
    conversation_source: 'cursor-hooks',
    client_name: 'cursor',
    client_version: stringValue(event.cursor_version),
    entrypoint: 'unknown',
    cwd,
    model: stringValue(event.model_id) ?? stringValue(event.model),
    attributes: { cursor: {
      hook: hook ?? null,
      generation_id: generation ?? null,
      identity_source: 'hook_delivery',
      timestamp_source: 'hook_receipt',
      frontend_source: 'unavailable',
      coverage: 'hook_observations',
      ...(hook === 'beforeReadFile' ? { file_path: /** @type {string} */ (event.file_path) } : {}),
      failure_type: stringValue(event.failure_type) ?? null,
      is_interrupt: typeof event.is_interrupt === 'boolean' ? event.is_interrupt : null,
      duration_ms: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
    } },
    messages: [message],
  }
}
