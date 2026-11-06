import { createOtlpJsonServer, listenAndResolve } from '../../../../src/core/otlp/server.js'
import { SESSION_IGNORE_ROUTE, createControlHandler } from '../../../../src/core/control/session_ignore.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { createProjectedExchangeWriter } from '../../ai-gateway/src/exchange_writer.js'
import { createPolicy } from './policy.js'
import { journalPath, pendingSlots, readSlot, removeSlot } from './journal.js'
import { langgraphListenPort } from './config.js'

/** @import { PluginActivationContext, StartedSource } from '../../../../hypaware-plugin-kernel-types.js' */

/** @param {PluginActivationContext} ctx @returns {Promise<StartedSource>} */
export async function startLangGraphSource(ctx) {
  const { stateDir } = readObservabilityEnv(ctx.env)
  const directory = journalPath(stateDir)
  const policy = createPolicy(ctx.env, stateDir)
  const state = { rows_written: 0, rows_skipped: 0, policy_drops: 0, invalid_events: 0,
    pending: 0, events_received: 0, last_event_at: '', last_error: '' }
  let cursor = ''
  let stopped = false
  let lastLoggedError = 0
  /** @type {Promise<void> | undefined} */
  let pending

  // @ref LLP 0548#journal: one bounded batch, acknowledged only after durable append
  async function drain() {
    const slots = await pendingSlots(directory)
    state.pending = slots.length
    const ordered = [...slots.filter(s => s > cursor), ...slots.filter(s => s <= cursor)].slice(0, 32)
    const writer = createProjectedExchangeWriter({ storage: ctx.storage })
    let processed = 0
    const invalidBefore = state.invalid_events
    for (const name of ordered) {
      if (stopped) break
      cursor = name
      let projection
      try { projection = await readSlot(directory, name) } catch (error) {
        if (error.message !== 'event_invalid' && !(error instanceof SyntaxError)) throw error
        state.invalid_events++
        await removeSlot(directory, name)
        state.pending--
        continue
      }
      if (!projection) continue
      state.events_received++
      state.last_event_at = new Date().toISOString()
      if (!policy.allows(projection.session_id, projection.cwd)) state.policy_drops++
      else {
        const result = await writer.record(projection)
        state.rows_written += result.rowsWritten
        state.rows_skipped += result.rowsSkipped ?? 0
      }
      await removeSlot(directory, name)
      state.pending--
      processed++
    }
    state.last_error = ''
    if (processed || state.invalid_events !== invalidBefore) ctx.log.info('langgraph.journal.drain', {
      component: 'langgraph', operation: 'journal.drain', status: 'ok',
      events: processed, ...state,
    })
  }
  function tick() {
    if (stopped || pending) return
    pending = drain().catch(() => {
      state.last_error = 'journal_delivery_failed'
      if (Date.now() - lastLoggedError > 60000) {
        ctx.log.error('langgraph.journal.failed', { component: 'langgraph', operation: 'journal.drain',
          status: 'error', error_kind: state.last_error })
        lastLoggedError = Date.now()
      }
    }).finally(() => { pending = undefined })
  }
  const server = createOtlpJsonServer({ name: 'hypaware/langgraph', signals: [],
    handler: { async handle() {} }, onControlRequest: createControlHandler({
      ignoredSessions: policy.ignored, log: ctx.log, logEvent: 'langgraph.control.ignore_session',
      logFields: { component: 'langgraph' },
    }) })
  const bound = await listenAndResolve(server, '127.0.0.1', langgraphListenPort(ctx.config), 'hypaware/langgraph')
  tick()
  const timer = setInterval(tick, 1000)
  timer.unref()
  ctx.log.info('langgraph.source.started', { component: 'langgraph', operation: 'source.start', status: 'ok' })
  return {
    async status() {
      return { state: 'ready', rowsWritten: state.rows_written,
        ...(state.last_error || policy.ignored.loadError ? { lastError: state.last_error || policy.ignored.loadError } : {}),
        details: { ...state,
          summary_line: state.events_received
            ? `LangGraph: ${state.rows_written} rows recorded, ${state.pending} pending, ${state.policy_drops} events excluded by privacy settings.`
            : 'LangGraph: waiting for an application. Run hyp client attach langgraph for connection instructions.',
          capture_status: state.events_received ? 'receiving' : 'waiting_for_application',
          listen_host: bound.host, listen_port: bound.port, control_routes: [SESSION_IGNORE_ROUTE],
          ignored_sessions: policy.ignored.size } }
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      await pending
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve(undefined))
        server.closeAllConnections()
      })
      ctx.log.info('langgraph.source.stopped', { component: 'langgraph', operation: 'source.stop', status: 'ok' })
    },
  }
}
