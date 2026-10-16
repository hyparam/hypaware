// @ts-check
import { acquireCloudAuth, readCloudAuth, CloudError } from './cloud-auth.js'
import { openCloudClient, readCloudThread, listCloudThreads } from './cloud-client.js'
import { readCloudConnection, DEFAULT_CLOUD_ORIGINS } from './cloud-state.js'
import { compareStrings } from 'hypaware/core/util'
import { refreshSessionIgnores } from '../../../../src/core/control/session_ignore_store.js'
import { AI_GATEWAY_MESSAGES_DATASET, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillContribution } from '../../../../hypaware-plugin-kernel-types.js' */

// @ref LLP 0511#projection: only finalized visible records; remote cwd and thread model are metadata.
/** @param {{thread: any, items: any[]}} history @param {{sinceMs?: number, untilMs?: number}} [window] */
export function projectCloudHistory(history, window = {}) {
  const { thread, items } = history
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  let unsupported = 0
  let unfinished = 0
  for (const wrapper of items) {
    const item = wrapper.item
    if (item.type === 'reasoning' || item.type === 'reasoningText') continue
    if (!Number.isFinite(wrapper.completedAtMs)) {
      unfinished++
      continue
    }
    const time = wrapper.startedAtMs ?? wrapper.completedAtMs
    if (!Number.isFinite(time) || Math.abs(time) > 8640000000000000) throw new CloudError('invalid_item_time')
    if ((window.sinceMs !== undefined && time < window.sinceMs) || (window.untilMs !== undefined && time > window.untilMs)) continue
    const base = { message_created_at: new Date(time).toISOString(), provider_type: item.type,
      attributes: { codex: { turn_id: wrapper.turnId } } }
    if (item.type === 'userMessage') {
      const content = []
      for (const part of item.content ?? []) {
        if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text })
        else unsupported++
      }
      if (content.length) messages.push({ ...base, message_id: item.id, role: 'user', content })
    } else if (item.type === 'agentMessage' && typeof item.text === 'string') {
      messages.push({ ...base, message_id: item.id, role: 'assistant', content: item.text })
    } else if (item.type === 'commandExecution' || item.type === 'mcpToolCall') {
      const command = item.type === 'commandExecution'
      const name = command ? 'exec_command' : `${item.server}.${item.tool}`
      const input = command ? { command: item.command, cwd: item.cwd } : item.arguments
      const output = command ? (item.aggregatedOutput ?? '') : JSON.stringify(item.result ?? item.error ?? null)
      messages.push({ ...base, message_id: `${item.id}:call`, role: 'assistant',
        content: [{ type: 'tool_use', id: item.id, name, input }] })
      messages.push({ ...base, message_id: `${item.id}:result`, role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: item.id, content: output, is_error: item.status === 'failed' }] })
    } else unsupported++
  }
  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: 'openai', session_id: thread.id, conversation_id: thread.id,
    conversation_source: 'codex', client_name: 'codex', entrypoint: 'codex-cloud',
    attributes: { codex: { source: 'codex-cloud-agent', identity_source: 'native', originator: thread.originator,
      ...(typeof thread.model === 'string' ? { thread_model: thread.model } : {}),
      ...(typeof thread.cwd === 'string' ? { workspace: thread.cwd } : {}),
    } }, messages,
  }
  if (Number.isFinite(thread.createdAt) && Math.abs(thread.createdAt) < 8640000000000) exchange.conversation_started_at = new Date(thread.createdAt * 1000).toISOString()
  return { exchange, unsupported, unfinished }
}

/**
 * @param {{codexHome: string, stateDir: string, env: NodeJS.ProcessEnv, ignoredSessions: Set<string>}} opts
 * @param {{acquire?: typeof acquireCloudAuth, readAuth?: typeof readCloudAuth, open?: typeof openCloudClient, readThread?: typeof readCloudThread, listThreads?: typeof listCloudThreads}} [deps]
 * @returns {BackfillContribution}
 */
export function createCodexCloudProvider(opts, deps = {}) {
  // Kernel sweeps serialize runs; this guard also prevents callers overlapping
  // this contribution within one activation. It is not a lock on Codex itself.
  let running = false
  let selectionKey = ''
  let sequence = 0
  /** @type {Map<string, number>} */
  const attempted = new Map()
  return {
    name: 'codex-cloud', plugin: '@hypaware/codex', datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import connected Codex cloud chats using the local ChatGPT login (experimental)',
    sweep: { cron: '*/5 * * * *' },
    async *run(ctx) {
      const connection = await readCloudConnection(opts.stateDir)
      if (!connection) return
      if (running) throw new CloudError('collection_already_running')
      running = true
      const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(ctx.signal ? [ctx.signal] : [])])
      const fields = { component: 'plugin.codex.cloud', operation: 'cloud.collect' }
      let client
      let count = 0
      let failedChats = 0
      let step = 'selection'
      try {
        // @ref LLP 0403#backfill: refresh durable exclusions before authentication or network work.
        refreshSessionIgnores(opts.ignoredSessions)
        const origins = connection.origins ?? DEFAULT_CLOUD_ORIGINS
        const account = connection.version === 2
        let selected = connection.version === 1 ? connection.threads.filter(id => !opts.ignoredSessions.has(id)) : []
        if (!account && !selected.length) return
        const key = JSON.stringify(connection)
        if (selectionKey !== key) {
          attempted.clear()
          sequence = 0
          selectionKey = key
        }
        const window = resolveWindow(ctx)
        if (connection.version === 2 && connection.since) window.sinceMs = Math.max(window.sinceMs ?? -Infinity, Date.parse(connection.since))
        ctx.log.info('codex.cloud.started', { ...fields, scope: account ? 'account' : 'selected', status: 'ok' })
        step = 'authentication'
        const auth = await (deps.acquire ?? acquireCloudAuth)({ codexHome: opts.codexHome, env: opts.env,
          accountHash: connection.accountHash, signal, allowRefresh: !ctx.dryRun })
        step = 'connection'
        client = await (deps.open ?? openCloudClient)(auth.token, signal)
        if (account) {
          step = 'discovery'
          const listed = await (deps.listThreads ?? listCloudThreads)(client, origins)
          const candidates = listed.filter(t => !opts.ignoredSessions.has(t.id)
            && (window.sinceMs === undefined || t.updatedAt * 1000 >= window.sinceMs))
          const present = new Set(candidates.map(t => t.id))
          for (const id of attempted.keys()) if (!present.has(id)) attempted.delete(id)
          // @ref LLP 0511#discovery: attempt order is fairness, never a successful-write checkpoint.
          candidates.sort((a, b) => (attempted.get(a.id) ?? 0) - (attempted.get(b.id) ?? 0)
            || b.updatedAt - a.updatedAt || compareStrings(a.id, b.id))
          selected = candidates.slice(0, 20).map(t => t.id)
          ctx.log.info('codex.cloud.discovered', { ...fields, status: 'ok', discovered: listed.length,
            eligible: candidates.length, selected: selected.length, deferred: Math.max(0, candidates.length - selected.length) })
        }
        for (const id of selected) {
          signal.throwIfAborted()
          if (opts.ignoredSessions.has(id)) continue
          step = 'history'
          if (account && !ctx.dryRun) attempted.set(id, ++sequence)
          let history
          try { history = await (deps.readThread ?? readCloudThread)(client, id, origins) }
          catch (error) {
            // A deleted, inaccessible or oversized chat cannot starve the rest.
            const isolated = new Set(['cloud_request_rejected', 'history_page_limit', 'invalid_item_page',
              'duplicate_item_identity', 'invalid_item_identity', 'invalid_history_cursor',
              'thread_identity_mismatch', 'unsupported_thread_source', 'unsupported_thread_originator'])
            if (!account || !(error instanceof CloudError) || !isolated.has(error.code)) throw error
            failedChats++
            ctx.log.warn('codex.cloud.chat_failed', { ...fields, status: 'failed', error_kind: error.code })
            yield { type: 'event', event: 'cloud_chat_failed', attributes: { native_id: id, error_kind: error.code } }
            continue
          }
          step = 'account_recheck'
          const current = await readCloudConnection(opts.stateDir)
          const latest = await (deps.readAuth ?? readCloudAuth)(opts.codexHome)
          if (JSON.stringify(current) !== JSON.stringify(connection)) throw new CloudError('connection_changed')
          if (latest.accountHash !== connection.accountHash) throw new CloudError('account_changed_reconnect_required')
          if (opts.ignoredSessions.has(id)) continue
          step = 'projection'
          const projected = projectCloudHistory(history, window)
          if (projected.unsupported || projected.unfinished) {
            yield { type: 'event', event: 'cloud_items_skipped', attributes: {
              unsupported: projected.unsupported, unfinished: projected.unfinished, native_id: id,
            } }
          }
          if (!projected.exchange.messages.length) continue
          count += projected.exchange.messages.length
          yield projectedExchangeItem(projected.exchange, { client_name: 'codex', native_id: id })
        }
        step = 'completion'
        if (failedChats) throw new CloudError('some_chats_failed')
        ctx.log.info('codex.cloud.completed', { ...fields, messages: count, failed_chats: failedChats, status: 'ok' })
      } catch (error) {
        const safe = error instanceof CloudError ? error : new CloudError(signal.aborted ? 'collection_cancelled' : 'collection_failed')
        ctx.log.warn('codex.cloud.failed', { ...fields, status: 'failed', step, failed_chats: failedChats, error_kind: safe.code })
        throw safe
      } finally {
        client?.close()
        running = false
      }
    },
  }
}
