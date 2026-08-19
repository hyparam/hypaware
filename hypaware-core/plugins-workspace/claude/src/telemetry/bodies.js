// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'
import { anthropicConversationFields, anthropicMessageAttributes } from '../anthropic.js'

/**
 * @import { AiGatewayProjectedMessage, JsonObject } from '../../../../../hypaware-plugin-kernel-types.js'
 * @import { ClaudeTelemetryEvent, SpooledClaudeBody } from '../types.js'
 */

/**
 * The two event names that reference a spooled body file. Everything
 * about the file's location comes from the event's `body_ref`
 * attribute: Claude Code writes the absolute path of the file it just
 * dropped into the spool.
 */
export const BODY_EVENT_NAMES = Object.freeze(['api_request_body', 'api_response_body'])

/**
 * Content-block types a body file is consulted for. Text blocks are
 * deliberately absent: the `user_prompt` and `assistant_response`
 * events already delivered that content once, keyed by native uuid,
 * and re-projecting it from the body would store every text twice
 * under a second identity.
 *
 * @ref LLP 0252#bodies-for-gaps [implements]: a body is read for what events
 *   lack (untruncated tool args, thinking signatures, tool results, ordering)
 *   and for nothing else
 */
const GAP_BLOCK_TYPES = new Set([
  'tool_use',
  'server_tool_use',
  'thinking',
  'redacted_thinking',
  'tool_result',
  'web_search_tool_result',
])

/**
 * Read the spooled body files a batch of events references.
 *
 * Only files inside the spool directory are touched: `body_ref` arrives
 * over the wire from whatever process found the loopback port, and this
 * listener both reads and DELETES what it names, so an uncontained ref
 * would turn the event stream into a read-and-delete primitive over the
 * whole filesystem. Refs outside the spool are refused, counted, and
 * left alone.
 *
 * A file that fails to parse is deleted immediately and counted: the
 * same session is recoverable from transcript backfill, and an
 * undeleted body is a raw prompt sitting on disk.
 * @ref LLP 0252#project-then-delete [implements]: an unprojectable body is
 *   deleted and counted, not retried forever
 *
 * @param {ClaudeTelemetryEvent[]} events
 * @param {{ spoolDir: string }} opts
 * @returns {Promise<{
 *   bodies: Map<string, SpooledClaudeBody>,
 *   consumedFiles: string[],
 *   consumedBytes: number,
 *   missing: number,
 *   unparseable: number,
 *   refused: string[],
 * }>}
 */
export async function loadSpooledBodies(events, opts) {
  /** @type {Map<string, SpooledClaudeBody>} */
  const bodies = new Map()
  /** @type {string[]} */
  const consumedFiles = []
  let consumedBytes = 0
  let missing = 0
  let unparseable = 0
  /** @type {string[]} */
  const refused = []

  const spoolRoot = path.resolve(opts.spoolDir)
  for (const event of events) {
    if (!BODY_EVENT_NAMES.includes(event.name)) continue
    const ref = stringValue(event.attributes.body_ref)
    if (!ref || bodies.has(ref)) continue
    const file = path.resolve(ref)
    if (!file.startsWith(spoolRoot + path.sep)) {
      refused.push(ref)
      continue
    }
    /** @type {Buffer} */
    let raw
    try {
      raw = await fs.readFile(file)
    } catch {
      // Already projected, already evicted, or never written: the
      // content is recoverable from the transcript either way.
      // @ref LLP 0253#eviction-degrades [implements]: an evicted body is not an
      //   error; the failure mode is "captured later, with less detail"
      missing += 1
      continue
    }
    const body = parseMaybeJson(raw.toString('utf8'))
    if (!isPlainObject(body)) {
      unparseable += 1
      await fs.rm(file, { force: true }).catch(() => {})
      continue
    }
    bodies.set(ref, {
      kind: event.name === 'api_request_body' ? 'request' : 'response',
      file,
      body,
    })
    consumedFiles.push(file)
    consumedBytes += raw.length
  }

  return { bodies, consumedFiles, consumedBytes, missing, unparseable, refused }
}

/**
 * Delete body files after their content has been projected and written.
 *
 * Called only after the batch's dataset writes succeeded: a write
 * failure surfaces as an HTTP error the exporter retries, and the
 * retried batch re-reads the same files. Deletion is the normal end of
 * a body's life, which is what keeps the spool transient.
 *
 * The size is read before the unlink, and a ref that is already gone is not
 * counted: `fs.rm(..., { force: true })` succeeds on a missing path, so
 * counting its return alone reported every vanished ref as one more deletion
 * (`bodies_deleted`, and the drop path's `bodies_dropped`). The byte total
 * is what lets a caller that never read the files - the policy-drop arm, which
 * deletes unread - bring `spool_bytes` down by what actually left the disk
 * instead of leaving it high until the next sweep restates it.
 *
 * @ref LLP 0252#project-then-delete [implements]: a body file is deleted as
 *   soon as it has been projected
 * @param {string[]} files
 * @returns {Promise<{ deleted: number, bytesRemoved: number }>}
 */
export async function deleteSpooledBodies(files) {
  let deleted = 0
  let bytesRemoved = 0
  for (const file of files) {
    /** @type {number} */
    let size
    try {
      size = (await fs.stat(file)).size
    } catch {
      // Already evicted, already swept, or never written: nothing here to
      // remove, and nothing to subtract.
      continue
    }
    try {
      await fs.rm(file, { force: true })
    } catch {
      // An unremovable file is the sweep's problem, not a reason to fail the
      // batch that already recorded its content.
      continue
    }
    deleted += 1
    bytesRemoved += size
  }
  return { deleted, bytesRemoved }
}

/**
 * A short, non-reversible handle for a `body_ref` that has to be named in a
 * log line. A refused ref is out-of-spool by definition and arrived over the
 * wire, so logging it verbatim puts an unvalidated, possibly attacker-chosen
 * absolute path into a line an operator's own sink may ship off the machine,
 * while every other line on this path carries basenames and counts. The digest
 * still correlates repeats of one ref across lines and runs, which is what the
 * refusal signal is read for.
 *
 * @ref LLP 0257#observability [implements]: S23 - payload identity is carried
 *   by a hash, not by the raw value
 * @param {string} ref
 * @returns {string}
 */
export function bodyRefDigest(ref) {
  return crypto.createHash('sha256').update(ref).digest('hex').slice(0, 12)
}

/**
 * Delete the spooled bodies a set of events references WITHOUT reading
 * them: the deletion arm of a policy drop. When ingest drops a session
 * (a per-session ignore today; the usage-policy governors take the same
 * path), its body files must not sit in the spool until the cap evicts
 * them - the content of exactly the session the user asked us not to
 * keep. The events' `body_ref`s are resolved under the same
 * spool-containment rule as `loadSpooledBodies`, refs outside the spool
 * are refused and counted, and nothing is parsed or projected.
 *
 * @ref LLP 0253#delete-on-drop [implements]: a dropped session's bodies are
 *   deleted, never merely skipped
 * @ref LLP 0256#bodies-deleted [implements]: the session-ignore transport
 *   works AND the content goes
 * @param {ClaudeTelemetryEvent[]} events
 * @param {{ spoolDir: string }} opts
 * @returns {Promise<{ deleted: number, bytesRemoved: number, refused: string[] }>}
 */
export async function deleteSpooledBodiesForEvents(events, opts) {
  const spoolRoot = path.resolve(opts.spoolDir)
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const refused = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const event of events) {
    if (!BODY_EVENT_NAMES.includes(event.name)) continue
    const ref = stringValue(event.attributes.body_ref)
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    const file = path.resolve(ref)
    if (!file.startsWith(spoolRoot + path.sep)) {
      refused.push(ref)
      continue
    }
    files.push(file)
  }
  const removed = await deleteSpooledBodies(files)
  return { deleted: removed.deleted, bytesRemoved: removed.bytesRemoved, refused }
}

/**
 * The exchange-level fields a request body supplies: the system prompt,
 * the tool declarations, and the model. These are columns stamped on
 * every row of the projection, which events never carry.
 *
 * @param {SpooledClaudeBody} spooled
 * @returns {{ system_text?: string, tools?: unknown, model?: string }}
 */
export function requestBodyFacts(spooled) {
  if (spooled.kind !== 'request') return {}
  const fields = anthropicConversationFields(spooled.body, undefined)
  /** @type {{ system_text?: string, tools?: unknown, model?: string }} */
  const facts = {}
  if (fields.system_text) facts.system_text = fields.system_text
  if (fields.tools !== undefined) facts.tools = fields.tools
  if (fields.model) facts.model = fields.model
  return facts
}

/**
 * Project one spooled body into the messages events cannot supply.
 *
 * A request body contributes its message history's gap blocks in
 * canonical order (tool results above all: they never appear on the
 * wire as events with content). A response body contributes the
 * assistant's tool_use and thinking blocks: full untruncated `input`
 * where the event's `tool_input` clips at 512 characters, and the
 * thinking signature the events do not carry at all.
 *
 * Each block becomes its own projected message, mirroring the proxy
 * path's per-block decomposition, so the gateway's fallback content
 * hash gives the same block the same identity from either producer and
 * the repeated history of the next turn's request dedupes away.
 *
 * A response with no text block never produces an `assistant_response`
 * event, so its usage would otherwise go unclaimed: the last gap block
 * carries it (from the `api_request` event when one arrived, else from
 * the body's own `usage`), along with the body's `stop_reason`. A
 * response WITH a text block leaves usage to the event that carries the
 * text, so a SUM over rows never counts a request twice.
 *
 * @param {SpooledClaudeBody} spooled
 * @param {{
 *   event: ClaudeTelemetryEvent,
 *   usageByRequestId: Map<string, Record<string, unknown>>,
 * }} ctx
 * @returns {AiGatewayProjectedMessage[]}
 */
export function spooledBodyGapMessages(spooled, ctx) {
  return spooled.kind === 'request'
    ? requestGapMessages(spooled, ctx.event)
    : responseGapMessages(spooled, ctx)
}

/**
 * @param {SpooledClaudeBody} spooled
 * @param {ClaudeTelemetryEvent} event
 * @returns {AiGatewayProjectedMessage[]}
 */
function requestGapMessages(spooled, event) {
  const messages = Array.isArray(spooled.body.messages) ? spooled.body.messages : []
  const frame = bodyFrame(spooled, event)
  /** @type {AiGatewayProjectedMessage[]} */
  const out = []
  for (const message of messages) {
    if (!isPlainObject(message)) continue
    const role = stringValue(message.role)
    if (!role) continue
    for (const block of gapBlocks(message.content)) {
      out.push(gapMessage({ role, block, event, frame }))
    }
  }
  return out
}

/**
 * @param {SpooledClaudeBody} spooled
 * @param {{ event: ClaudeTelemetryEvent, usageByRequestId: Map<string, Record<string, unknown>> }} ctx
 * @returns {AiGatewayProjectedMessage[]}
 */
function responseGapMessages(spooled, ctx) {
  const { event } = ctx
  const body = spooled.body
  if (stringValue(body.role) !== 'assistant') return []
  const content = Array.isArray(body.content) ? body.content : []
  const kept = gapBlocks(content)
  if (kept.length === 0) return []

  const frame = bodyFrame(spooled, event)
  const requestId = stringValue(event.attributes.request_id)
  const model = stringValue(body.model)
  const hasText = content.some((block) => isPlainObject(block) && block.type === 'text')

  /** @type {AiGatewayProjectedMessage[]} */
  const out = []
  for (let i = 0; i < kept.length; i++) {
    const message = gapMessage({ role: 'assistant', block: kept[i], event, frame })
    if (requestId) message.request_id = requestId
    if (model) message.model = model
    if (i === kept.length - 1 && !hasText) {
      const stopReason = stringValue(body.stop_reason)
      if (stopReason) message.stop_reason = stopReason
      const usage = (requestId ? claimUsage(ctx.usageByRequestId, requestId) : undefined)
        ?? anthropicMessageAttributes(body)
      if (usage) message.attributes = /** @type {any} */ (usage)
    }
    out.push(message)
  }
  return out
}

/**
 * @param {{
 *   role: string,
 *   block: Record<string, unknown>,
 *   event: ClaudeTelemetryEvent,
 *   frame: JsonObject,
 * }} args
 * @returns {AiGatewayProjectedMessage}
 */
function gapMessage({ role, block, event, frame }) {
  /** @type {AiGatewayProjectedMessage} */
  const message = { role, content: /** @type {any} */ ([block]), raw_frame: frame }
  if (event.timestamp) message.message_created_at = event.timestamp
  const promptId = stringValue(event.attributes['prompt.id'])
  if (promptId) message.prompt_id = promptId
  return message
}

/**
 * @param {unknown} content
 * @returns {Array<Record<string, unknown>>}
 */
function gapBlocks(content) {
  if (!Array.isArray(content)) return []
  return content.filter(
    (block) => isPlainObject(block) &&
      typeof block.type === 'string' &&
      GAP_BLOCK_TYPES.has(block.type)
  )
}

/**
 * The minimized frame a body-derived row carries: enough to trace the
 * row back to the body file and API exchange it came from, never any
 * content. Same policy as the proxy path's minimized transcript frame.
 *
 * @param {SpooledClaudeBody} spooled
 * @param {ClaudeTelemetryEvent} event
 * @returns {JsonObject}
 */
function bodyFrame(spooled, event) {
  /** @type {JsonObject} */
  const frame = {
    type: spooled.kind === 'request' ? 'api_request_body' : 'api_response_body',
    body_file: path.basename(spooled.file),
  }
  const responseId = spooled.kind === 'response' ? stringValue(spooled.body.id) : undefined
  if (responseId) frame.message_id = responseId
  const requestId = stringValue(event.attributes.request_id)
  if (requestId) frame.request_id = requestId
  if (event.timestamp) frame.timestamp = event.timestamp
  return frame
}

/**
 * @param {Map<string, Record<string, unknown>>} index
 * @param {string} requestId
 * @returns {Record<string, unknown> | undefined}
 */
function claimUsage(index, requestId) {
  const usage = index.get(requestId)
  if (usage) index.delete(requestId)
  return usage
}
