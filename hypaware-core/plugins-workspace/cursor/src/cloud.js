// @ts-check
import { createHash } from 'node:crypto'
import { createProjectedExchangeWriter } from '../../ai-gateway/src/exchange_writer.js'
import { isPlainObject } from '../../../../src/core/util/json_util.js'
import { refreshSessionIgnores } from '../../../../src/core/control/session_ignore_store.js'
import { projectCursorHook } from './projector.js'
import { CursorCloudError, readCursorCloudConversation, readCursorCloudMetadata } from './cloud-client.js'

/** @import { PluginActivationContext, AiGatewayProjectedExchange, JsonValue } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CursorCloudConnection, CursorCloudConversation, CursorCloudSource } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js' */

export const CURSOR_CLOUD_EVENTS = ['beforeSubmitPrompt', 'afterAgentResponse', 'postToolUse', 'postToolUseFailure', 'afterFileEdit', 'beforeReadFile', 'stop']
const MAX_RECORD_BYTES = 256 * 1024
/** @param {string} session @param {string} id */
const apiMessageId = (session, id) => 'cursor-cloud:' + JSON.stringify([session, 'api', id])

/** @param {AiGatewayProjectedExchange} projection @param {CursorCloudConnection} connection */
function cloudExchange(projection, connection) {
  return { ...projection, provider: 'unknown', client_name: 'cursor', entrypoint: 'cloud', cwd: connection.cwd,
    repo_root: connection.cwd, git_remote: connection.repository,
  }
}

/** @template T @param {T} value @param {NodeJS.ProcessEnv} env @param {number} [maxBytes] @returns {T} */
export function sanitizeCursorCloud(value, env, maxBytes) {
  /** @type {string[]} */
  const secrets = []
  for (const secret of [env.CURSOR_API_KEY, env.HYP_CI_TOKEN]) if (secret && secret.trim().length >= 8) secrets.push(secret.trim())
  const body = JSON.stringify(value, (key, value) => {
    if (/^(thinking|reasoning|analysis|signature)$/i.test(key)) return undefined
    return typeof value === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value) : value
  })
  if (maxBytes !== undefined && Buffer.byteLength(body) > maxBytes) throw new CursorCloudError('cloud_record_limit')
  return JSON.parse(body)
}

/** @param {AiGatewayProjectedExchange} projection @param {NodeJS.ProcessEnv} env @returns {AiGatewayProjectedExchange} */
export function redactCursorCloud(projection, env) {
  return sanitizeCursorCloud(projection, env, MAX_RECORD_BYTES)
}

/** @param {CursorCloudConversation} conversation @param {CursorCloudConnection} connection @returns {AiGatewayProjectedExchange[]} */
export function projectCursorCloudConversation(conversation, connection) {
  return conversation.messages.map(message => cloudExchange({
    provider: 'unknown', session_id: conversation.id, conversation_id: conversation.id,
    conversation_source: 'cursor-cloud-api',
    attributes: { cursor: { identity_source: 'cloud_api_message', timestamp_source: 'receipt', coverage: 'cloud_api_text' } },
    messages: [{ role: message.type === 'user_message' ? 'user' : 'assistant',
      message_id: apiMessageId(conversation.id, message.id),
      previous_message_id: [], content: message.text, provider_type: 'conversation-api',
    }],
  }, connection))
}

/**
 * @param {unknown} raw
 * @param {CursorCloudConnection} connection
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AiGatewayProjectedExchange | undefined}
 * @ref LLP 0593#identity: API owns main text; native tool IDs and delivered edit observations are separate identities.
 */
export function projectCursorCloudHook(raw, connection, env = {}) {
  raw = sanitizeCursorCloud(raw, env)
  if (!isPlainObject(raw) || !isPlainObject(raw.event)) return undefined
  const event = raw.event
  const session = event.conversation_id
  const hook = event.hook_event_name
  if (typeof session !== 'string' || !session || session.length > 256 || typeof raw.delivery_id !== 'string' || raw.delivery_id.length > 256 ||
      typeof raw.observed_at !== 'string' || !Number.isFinite(Date.parse(raw.observed_at))) return undefined
  const id = (...parts) => 'cursor-cloud:' + JSON.stringify([session, ...parts])
  /** @type {AiGatewayProjectedExchange} */
  const exchange = cloudExchange({ provider: 'unknown', session_id: session, conversation_id: session,
    conversation_source: 'cursor-cloud-hooks',
    attributes: { cursor: { identity_source: 'cloud_hook', timestamp_source: 'hook_receipt', coverage: 'cloud_hook_observations' } }, messages: [],
  }, connection)
  if (hook === 'postToolUse' || hook === 'postToolUseFailure') {
    if (typeof event.tool_use_id !== 'string' || !event.tool_use_id || event.tool_use_id.length > 256 || typeof event.tool_name !== 'string' || !event.tool_name || event.tool_name.length > 256) return undefined
    const output = hook === 'postToolUseFailure' ? event.error_message ?? event.error : event.tool_output
    if (output === undefined) return undefined
    exchange.messages = [
      { role: 'assistant', message_id: id('tool', event.tool_use_id, 'call'), previous_message_id: [], content: [{ type: 'tool_use', id: event.tool_use_id, name: event.tool_name, input: /** @type {JsonValue} */ (event.tool_input ?? {}) }] },
      { role: 'user', message_id: id('tool', event.tool_use_id, 'result'), previous_message_id: [], content: [{ type: 'tool_result', tool_use_id: event.tool_use_id, content: typeof output === 'string' ? output : JSON.stringify(output), is_error: hook === 'postToolUseFailure' ? true : isPlainObject(output) && typeof output.exitCode === 'number' ? output.exitCode !== 0 : null }] },
    ]
  } else if (hook === 'afterFileEdit') {
    if (typeof event.file_path !== 'string' || !Array.isArray(event.edits) || !event.edits.length || event.edits.length > 128 ||
        !event.edits.every(edit => isPlainObject(edit) && typeof edit.old_string === 'string' && typeof edit.new_string === 'string')) return undefined
    exchange.messages = [{ role: 'system', message_id: id('edit', raw.delivery_id), previous_message_id: [],
      content: JSON.stringify({ file_path: event.file_path, edits: event.edits.map(edit => ({ old_string: edit.old_string, new_string: edit.new_string })) }), provider_type: 'hook', hook_event: hook,
    }]
  } else if (session !== connection.agentId && (hook === 'beforeSubmitPrompt' || hook === 'afterAgentResponse')) {
    const content = hook === 'beforeSubmitPrompt' ? event.prompt : event.text
    if (typeof content !== 'string') return undefined
    exchange.messages = [{ role: hook === 'beforeSubmitPrompt' ? 'user' : 'assistant', message_id: id('delivery', raw.delivery_id), previous_message_id: [], content }]
  } else {
    const observation = projectCursorHook(raw)
    if (!observation) return undefined
    return cloudExchange(observation, connection)
  }
  for (const message of exchange.messages) message.message_created_at = raw.observed_at
  return exchange
}

/**
 * @param {PluginActivationContext} ctx
 * @param {CursorCloudSource} cloud
 * @param {() => Promise<boolean>} admit
 * @param {Set<string>} ignoredSessions
 * @ref LLP 0593#runtime: one cancellable bounded pass, with durable dedupe after cache eviction or restart.
 */
export async function startCursorCloudRecovery(ctx, cloud, admit, ignoredSessions) {
  const cancel = new AbortController()
  const metadata = await (cloud.readMetadata ?? readCursorCloudMetadata)(ctx.env, cancel.signal)
  if (metadata.agentId !== cloud.connection.agentId || metadata.repository !== cloud.connection.repository) throw new CursorCloudError('cloud_metadata_scope')
  const key = ctx.env.CURSOR_API_KEY?.trim() ?? ''
  if (!key) throw new CursorCloudError('cloud_api_key_missing_or_invalid')
  const counts = { api_reads: 0, api_failures: 0, api_messages: 0, api_rows_written: 0, api_rows_skipped: 0 }
  let lastError
  let state = 'pending'
  let timer
  let stopped = false
  let active = Promise.resolve()
  const seen = new Set()
  /** @type {Map<string, string>} */
  let candidates = new Map()
  async function tick() {
    try {
      refreshSessionIgnores(ignoredSessions)
      if (!await admit()) {
        state = 'withheld'
        candidates.clear()
        return
      }
      const conversation = await readCursorCloudConversation(cloud.connection, key, { fetcher: cloud.fetcher, signal: cancel.signal })
      counts.api_reads++
      if (!conversation) {
        state = lastError ? 'degraded' : 'pending'
        candidates.clear()
        return
      }
      // Validate the complete bounded batch before the first append. A failed
      // append never advances an identity or a durable success checkpoint.
      const messages = conversation.messages.filter(message => !seen.has(apiMessageId(conversation.id, message.id)))
      const nextCandidates = new Map()
      // @ref LLP 0593#identity: a quick follow-up can finish between status
      // checks. Require unchanged text in consecutive completed snapshots.
      const stable = messages.filter(message => {
        const id = apiMessageId(conversation.id, message.id)
        const fingerprint = createHash('sha256').update(message.type).update('\0').update(message.text).digest('hex')
        nextCandidates.set(id, fingerprint)
        return candidates.get(id) === fingerprint
      })
      candidates = nextCandidates
      const projections = projectCursorCloudConversation({ ...conversation, messages: stable }, cloud.connection).map(p => redactCursorCloud(p, ctx.env))
      const writer = createProjectedExchangeWriter({ storage: ctx.storage })
      for (const projection of projections) {
        if (stopped || !await admit()) {
          state = 'withheld'
          candidates.clear()
          return
        }
        const id = projection.messages[0].message_id
        if (seen.has(id)) continue
        const result = await writer.record(projection, { gatewayAttributes: { gateway: { source: 'cursor-cloud-api' } } })
        counts.api_rows_written += result.rowsWritten
        counts.api_rows_skipped += result.rowsSkipped
        counts.api_messages++
        if (seen.size >= 1024) seen.delete(seen.values().next().value)
        seen.add(id)
      }
      state = stable.length === messages.length ? 'ready' : lastError ? 'degraded' : 'pending'
      if (state === 'ready') lastError = undefined
      ctx.log.info('cursor.cloud.recovered', { component: 'plugin.cursor', operation: 'cloud.recover', status: 'ok', messages: conversation.messages.length, rows_written: counts.api_rows_written })
    } catch (error) {
      if (stopped) return
      state = 'degraded'
      candidates.clear()
      counts.api_failures++
      lastError = error instanceof CursorCloudError ? error.code : 'cloud_capture_failed'
      ctx.log.warn('cursor.cloud.recovery_failed', { component: 'plugin.cursor', operation: 'cloud.recover', status: 'failed', error_kind: lastError })
    } finally {
      if (!stopped) {
        timer = setTimeout(run, cloud.intervalMs ?? 30000)
        timer.unref()
      }
    }
  }
  function run() { active = tick() }
  run()
  return {
    status() { return { ...counts, cloud_state: state, cloud_error: lastError ?? null } },
    async stop() {
      stopped = true
      cancel.abort()
      candidates.clear()
      clearTimeout(timer)
      await active
    },
  }
}
