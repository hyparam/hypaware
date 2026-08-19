// @ts-check

import { Attr, getActiveSpan, withSpan } from '../../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../../src/core/observability/env.js'
import { SESSION_IGNORE_ROUTE, createControlHandler } from '../../../../../src/core/control/session_ignore.js'
import { resolveLiveSourceListenPortFromStatus } from '../../../../../src/core/daemon/status.js'
import { createOtlpJsonServer, listenAndResolve } from '../../../../../src/core/otlp/server.js'
import { createUsagePolicyResolver } from '../../../../../src/core/usage-policy/index.js'
import { createSessionContextReader, pickLatestMatching } from '../session_context.js'
import { bodyRefDigest, deleteSpooledBodies, deleteSpooledBodiesForEvents, loadSpooledBodies } from './bodies.js'
import { partitionByUsagePolicy, resolveSessionUsagePolicy } from './policy.js'
import { flattenClaudeTelemetryEvents, flattenClaudeTelemetryMetrics } from './events.js'
import {
  CLAUDE_TELEMETRY_EVENT_COLUMNS,
  claudeTelemetryEventRows,
  claudeTelemetryTablePath,
} from './events_dataset.js'
import { projectClaudeTelemetryEvents } from './projection.js'
import {
  DEFAULT_SPOOL_MAX_BYTES,
  claudeBodySpoolDir,
  enforceClaudeBodySpoolCap,
  tightenClaudeBodySpool,
} from './spool.js'

/**
 * @import { Server } from 'node:http'
 * @import { AiGatewayCapability, PluginActivationContext, SourceStatus, StartedSource } from '../../../../../hypaware-plugin-kernel-types.js'
 * @import { OtlpRequest } from '../../../../../src/core/otlp/types.js'
 * @import { UsagePolicyResolver } from '../../../../../src/core/usage-policy/types.js'
 * @import { BatchSuppressionTally, ClaudeTelemetryEvent, ClaudeTelemetryListenerState, SessionContextRecord } from '../types.js'
 */

const PLUGIN_NAME = '@hypaware/claude'

/** Kernel source name. Registered by `@hypaware/claude`, not by `@hypaware/otel`. */
export const CLAUDE_TELEMETRY_SOURCE = 'claude-telemetry'

/** What this listener calls itself on the wire banner and in bind errors. */
const LISTENER_NAME = 'hypaware/claude-telemetry'

/**
 * Loopback only. The endpoint attach writes into the settings `env`
 * block is `http://127.0.0.1:<port>` (LLP 0258 #env-keys), and a
 * listener that carried raw prompt text off the loopback interface
 * would be a capture surface nobody asked for.
 */
const DEFAULT_HOST = '127.0.0.1'

/**
 * Own port, next to `@hypaware/otel`'s 4318 and separate from the
 * gateway's. One listener per payload dialect: the OTLP receiver keeps
 * flattening generic logs/traces/metrics, and this one reads Claude
 * Code's event vocabulary.
 * @ref LLP 0257#registration [implements]: its own port, separate from the otel
 *   receiver and from the gateway
 */
export const DEFAULT_TELEMETRY_PORT = 4319

/**
 * Claude Code's exporter is configured with both `OTEL_LOGS_EXPORTER`
 * and `OTEL_METRICS_EXPORTER` (LLP 0258 #env-keys), so it POSTs to
 * `/v1/metrics` too. Both halves of the stream are consumed: log events
 * feed the message projection plus the behavioral dataset, and metric
 * data points land in `claude_telemetry_events` under LLP 0255.
 */
const SERVED_SIGNALS = /** @type {const} */ (['logs', 'metrics'])

/**
 * How often the daemon re-enforces the spool's byte cap. The listener
 * deletes what it projects, so under normal flow the sweep finds
 * nothing; the interval exists for the window where Claude Code is
 * writing bodies and nothing is consuming them (a misdirected exporter,
 * a wedged storage service), which is exactly when nobody else would
 * notice the directory growing.
 */
const SPOOL_SWEEP_INTERVAL_MS = 60_000

/**
 * Build the `SourceContribution.start` callback for the Claude
 * telemetry listener.
 *
 * The source owns one HTTP listener and writes into
 * `ai_gateway_messages` through the gateway capability, so the dataset
 * keeps one owner and the OTEL rows cannot drift from the proxy's.
 *
 * @ref LLP 0257#registration [implements]: a listener source contributed by
 *   `@hypaware/claude` through the kernel source registry
 * @param {{
 *   gateway: AiGatewayCapability,
 *   clientName: string,
 *   stateFile: string,
 *   localOnlyListPath?: string,
 * }} deps
 */
export function createStartClaudeTelemetrySource(deps) {
  /**
   * @param {PluginActivationContext} ctx
   * @returns {Promise<StartedSource>}
   */
  return async function startClaudeTelemetrySource(ctx) {
    const listen = readListenConfig(ctx)
    const spool = readSpoolConfig(ctx)
    /** @type {ClaudeTelemetryListenerState} */
    const state = {
      rowsWritten: 0,
      rowsSkipped: 0,
      telemetryRowsWritten: 0,
      eventsReceived: 0,
      eventsDropped: 0,
      eventsUndetermined: 0,
      lastEventAt: undefined,
      lastError: undefined,
      listenFallbackFrom: undefined,
      spoolBytes: 0,
      bodiesProjected: 0,
      bodiesDeleted: 0,
      bodiesDropped: 0,
      bodiesEvicted: 0,
      bodiesMissing: 0,
      bodiesUnparseable: 0,
    }

    // The same per-session opt-out the gateway keeps: an in-memory set that
    // dies with the process, written through the identical control route and
    // matched verbatim against the `session.id` the events carry (LLP 0066
    // R5). Nothing about it touches disk.
    // @ref LLP 0256#in-memory-only [implements]: no new on-disk contract; the
    //   durable expressions of the same intent stay `.hypignore` and the
    //   machine-local list
    /** @type {Set<string>} */
    const ignoredSessions = new Set()

    // The spool exists whether or not this daemon was up when attach ran:
    // Claude Code starts writing bodies the moment a session launches with
    // the attach-written env, so the listener repairs permissions and
    // enforces the cap on every start, then keeps enforcing on a timer for
    // the window where bodies arrive but nothing consumes them.
    //
    // Repair, never create: attach is the write that mints this directory,
    // because it is the same write that tells Claude Code to put bodies in
    // it. A daemon that created it regardless would leave a raw-prompt
    // directory on every install that never attached this client, in whatever
    // HYP_HOME the activation context resolved.
    // @ref LLP 0253#spool-location [implements]: owner-only under the HypAware
    //   home, tightened here even when Claude Code created it first
    try {
      await tightenClaudeBodySpool(spool.dir)
    } catch (err) {
      ctx.log.warn('claude.telemetry.spool_unavailable', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        spool_dir: spool.dir,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const sweepSpool = async () => {
      try {
        const swept = await enforceClaudeBodySpoolCap(spool.dir, spool.maxBytes)
        state.spoolBytes = swept.spoolBytes
        if (swept.evictedCount > 0) {
          state.bodiesEvicted += swept.evictedCount
          // A machine that is routinely evicting is losing detail to the
          // backfill path; the count is what makes that visible.
          // @ref LLP 0253#byte-cap [implements]: eviction is logged with a count
          ctx.log.warn('claude.telemetry.spool_evicted', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            [Attr.COMPONENT]: 'sources',
            [Attr.OPERATION]: 'spool_sweep',
            spool_dir: spool.dir,
            evicted_count: swept.evictedCount,
            evicted_bytes: swept.evictedBytes,
            spool_bytes: swept.spoolBytes,
            spool_max_bytes: spool.maxBytes,
          })
        }
      } catch (err) {
        ctx.log.warn('claude.telemetry.spool_sweep_failed', {
          [Attr.PLUGIN]: PLUGIN_NAME,
          spool_dir: spool.dir,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // The one-shot sweep runs whether or not the bind below succeeds: bodies
    // already on disk are over the cap regardless. The repeating one does not
    // get armed until there is a listener behind it, because `stop()` is the
    // only thing that clears it and a start that throws never returns a handle
    // to call `stop()` on - an armed timer would then keep scanning the spool
    // every minute, for the life of the daemon, on behalf of a source that
    // does not exist.
    await sweepSpool()

    const readSessionContext = createSessionContextReader(deps.stateFile, (err) => {
      ctx.log.warn('claude.telemetry.session_context_unreadable', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    // One resolver per listener (per daemon run), like the projector's: the
    // per-cwd cache rides the source's lifetime so the ingest path adds no
    // unbounded fs work. `localOnlyListPath` is threaded from the plugin's
    // SHARED state root, which is where the machine-local list actually lives;
    // without it the resolver would see `.hypignore` dotfiles only and a
    // `--private` directory would record here after being dropped everywhere
    // else.
    // @ref LLP 0254#policy-inline [implements]: the same shared resolver every
    //   other capture seam uses, so `.hypignore` and the machine-local list
    //   both reach the OTEL path
    const resolver = createUsagePolicyResolver({ localOnlyListPath: deps.localOnlyListPath })

    /**
     * Held across batches: the exporter flushes on a timer, so a turn's
     * `api_request` (which carries the tokens) and its
     * `assistant_response` (which carries the uuid the row is keyed by)
     * can arrive in different POSTs. Bounded so a stream of requests
     * that never produce an assistant response cannot grow it forever.
     */
    /** @type {Map<string, Record<string, unknown>>} */
    const usageByRequestId = new Map()

    /**
     * Also held across batches: a session's system prompt and tool
     * declarations arrive once, in the request body, while the rows they
     * belong on keep arriving for the session's lifetime.
     */
    /** @type {Map<string, { systemText?: string, tools?: unknown }>} */
    const sessionBodyFacts = new Map()

    const handler = makeReceiveHandler({
      ctx,
      deps,
      state,
      usageByRequestId,
      sessionBodyFacts,
      readSessionContext,
      resolver,
      spoolDir: spool.dir,
      ignoredSessions,
    })
    const server = createOtlpJsonServer({
      name: LISTENER_NAME,
      handler: { handle: handler },
      signals: [...SERVED_SIGNALS],
      // The same `/_hypaware/ignore/session` route the gateway proxy hosts,
      // over this listener's own set: with Claude Code traffic no longer on
      // the gateway's wire, "don't record this conversation" has to reach
      // the recorder that now writes the rows.
      // @ref LLP 0256#control-route-on-listener [implements]: same shape,
      //   verbs, and reply as the gateway's, via the shared handler
      onControlRequest: createControlHandler({
        ignoredSessions,
        log: ctx.log,
        logEvent: 'claude.telemetry.control.ignore_session',
        logFields: { [Attr.PLUGIN]: PLUGIN_NAME, [Attr.COMPONENT]: 'sources' },
      }),
    })
    const bound = await bindWithFallback({ server, listen, log: ctx.log, state })
    const sweepTimer = setInterval(sweepSpool, SPOOL_SWEEP_INTERVAL_MS)
    sweepTimer.unref?.()

    // When this listener came up, published so `hyp status` can tell "nothing
    // has arrived yet because the daemon restarted a minute ago" from "nothing
    // has arrived for a day". `lastEventAt` lives only in this object, so every
    // restart republishes `last_event_at: null` however long capture has been
    // healthy, and the capture-health baseline would otherwise fall back to an
    // attach timestamp that can be weeks old.
    // @ref LLP 0257#status-and-health [implements]: the gap is measured from a moment capture was actually supposed to be running
    const startedAt = new Date().toISOString()

    const span = getActiveSpan()
    span?.setAttribute('listen_host', bound.host)
    span?.setAttribute('listen_port', bound.port)
    ctx.log.info('claude.telemetry.listener_started', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      listen_host: bound.host,
      listen_port: bound.port,
    })

    return {
      async status() {
        /** @type {SourceStatus} */
        const status = {
          state: 'ready',
          rowsWritten: state.rowsWritten,
          details: {
            listen_host: bound.host,
            listen_port: bound.port,
            // Says "I host the session-ignore route here", which is how
            // `hyp session ignore` discovers this recorder beside the
            // gateway without the client-agnostic verb naming any plugin.
            // @ref LLP 0256#cli-posts-to-both [implements]: offering the route
            //   is advertised by the recorder itself
            control_routes: [SESSION_IGNORE_ROUTE],
            events_received: state.eventsReceived,
            rows_skipped: state.rowsSkipped,
            // Behavioral rows, counted apart from `rowsWritten` (message
            // rows) so a capture gap in either dataset is visible alone.
            telemetry_rows_written: state.telemetryRowsWritten,
            // @ref LLP 0257#status-and-health [implements]: the status details
            // carry the spool's byte size and eviction count.
            spool_bytes: state.spoolBytes,
            bodies_projected: state.bodiesProjected,
            bodies_evicted: state.bodiesEvicted,
            // The live opt-out surface, mirroring the gateway source's
            // details: the set size plus what enforcing it dropped.
            // @ref LLP 0066#ephemeral: an active session drop is visible in
            //   status, not only in logs
            ignored_sessions: ignoredSessions.size,
            events_dropped: state.eventsDropped,
            bodies_dropped: state.bodiesDropped,
            // A capture gap, not a policy outcome: these events named a session
            // whose cwd nothing had recorded yet, so there was no verdict to
            // record them under. Published because a machine whose hook is not
            // installed would otherwise look idle rather than blind.
            // @ref LLP 0257#ingest [implements]: S10 - undetermined is its own
            //   visible state, not silence
            events_undetermined: state.eventsUndetermined,
            // Null before the first event rather than absent: the key's
            // presence is how the capture-health reader recognizes this
            // snapshot as the telemetry listener's (the `control_routes`
            // self-advertisement pattern), and "attached but nothing ever
            // arrived" is exactly the state that comparison must be able
            // to see.
            // @ref LLP 0257#status-and-health [implements]: the last event seen, published for the hyp status comparison
            last_event_at: state.lastEventAt ?? null,
            // Beside it, and for the same reader: the window this listener has
            // actually been able to capture in.
            listener_started_at: startedAt,
            ...(state.listenFallbackFrom !== undefined
              ? { listen_fallback_from: state.listenFallbackFrom }
              : {}),
          },
        }
        if (state.lastError) status.lastError = state.lastError
        return status
      },

      async stop() {
        clearInterval(sweepTimer)
        await new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve(undefined)))
          server.closeIdleConnections?.()
          server.closeAllConnections?.()
        })
      },
    }
  }
}

/**
 * Wrap one decoded OTLP request in a `claude.telemetry.receive` span,
 * read the spooled bodies its events reference, project everything, and
 * write the rows. Consumed body files are deleted only after the writes
 * succeeded: a write failure becomes an HTTP error the exporter
 * retries, and the retried batch re-reads the same files.
 *
 * A throw here becomes an HTTP 500 the exporter will retry, so
 * everything recoverable is handled: an unparseable envelope yields zero
 * events, an event this listener does not model is skipped, a missing
 * or refused body ref is counted, and only a genuine write failure
 * propagates.
 *
 * @param {{
 *   ctx: PluginActivationContext,
 *   deps: { gateway: AiGatewayCapability, clientName: string, stateFile: string },
 *   state: ClaudeTelemetryListenerState,
 *   usageByRequestId: Map<string, Record<string, unknown>>,
 *   sessionBodyFacts: Map<string, { systemText?: string, tools?: unknown }>,
 *   readSessionContext: () => Promise<SessionContextRecord[]>,
 *   resolver: UsagePolicyResolver,
 *   spoolDir: string,
 *   ignoredSessions: Set<string>,
 * }} args
 * @returns {(req: OtlpRequest) => Promise<void>}
 */
function makeReceiveHandler({ ctx, deps, state, usageByRequestId, sessionBodyFacts, readSessionContext, resolver, spoolDir, ignoredSessions }) {
  /**
   * Suppress one session's events at ingest: delete its spooled bodies
   * WITHOUT reading them, count it, and emit one drop signal so the audit
   * trail matches the proxy path's.
   *
   * The deletion is the half that makes an opt-out mean what it says. A skip
   * would leave the content of exactly the session the user asked us not to
   * keep sitting in our own directory until the cap evicted it.
   *
   * @ref LLP 0253#delete-on-drop [implements]: a dropped session's bodies are
   *   deleted, never merely skipped
   * @ref LLP 0256#bodies-deleted [implements]: the same duty for the
   *   per-session opt-out
   * @param {{
   *   sessionId: string,
   *   events: ClaudeTelemetryEvent[],
   *   policySource: string,
   *   withheld?: boolean,
   *   fields?: Record<string, unknown>,
   *   tally: BatchSuppressionTally,
   * }} args
   */
  async function suppressSession({ sessionId, events, policySource, withheld = false, fields = {}, tally }) {
    const removal = await deleteSpooledBodiesForEvents(events, { spoolDir })
    tally.bodiesDropped += removal.deleted
    state.bodiesDropped += removal.deleted
    // The drop arm deletes bodies the read path never accounted for, so
    // without this the gauge only came back down at the next sweep, a minute
    // later - and `hyp status` read `spool_bytes` in between and reported
    // bytes for content that had already been removed on the user's say-so.
    // @ref LLP 0253#byte-cap [implements]: the published byte size is what is
    //   on disk, whichever arm removed the file
    state.spoolBytes = Math.max(0, state.spoolBytes - removal.bytesRemoved)
    if (withheld) {
      tally.eventsUndetermined += events.length
      state.eventsUndetermined += events.length
    } else {
      tally.eventsDropped += events.length
      state.eventsDropped += events.length
    }
    for (const ref of removal.refused) {
      ctx.log.warn('claude.telemetry.body_ref_refused', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        error_kind: 'body_ref_outside_spool',
        body_ref_sha256: bodyRefDigest(ref),
      })
    }
    // Warn for a withheld session, info for a policy that answered: the first
    // is a capture gap an operator can close (install the hook), the second is
    // the system doing what it was told.
    ctx.log[withheld ? 'warn' : 'info']('claude.telemetry.usage_policy_drop', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      [Attr.COMPONENT]: 'sources',
      [Attr.OPERATION]: 'usage_policy_drop',
      policy_source: policySource,
      session_id: sessionId,
      events_dropped: events.length,
      bodies_deleted: removal.deleted,
      ...fields,
    })
  }

  /**
   * Enforce the per-session opt-out (LLP 0066 / LLP 0256) on one batch.
   *
   * @param {Map<string, ClaudeTelemetryEvent[]>} droppedBySession
   * @param {BatchSuppressionTally} tally
   */
  async function dropIgnoredSessions(droppedBySession, tally) {
    for (const [sessionId, sessionEvents] of droppedBySession) {
      await suppressSession({
        sessionId,
        events: sessionEvents,
        policySource: 'session_opt_out',
        tally,
      })
    }
  }

  /**
   * Enforce the folder usage policy on one batch, INLINE, before anything is
   * read from the spool and before any row is written.
   *
   * Three outcomes per session: an `ignore` cwd is dropped with its bodies, a
   * session whose cwd nothing has recorded is withheld the same way (no
   * verdict exists, so there is nothing to record it under), and everything
   * else is returned to be projected. `local-only` is deliberately in that
   * last group: it is enforced at the export and query seams, not by refusing
   * to record.
   *
   * There is no second look at flush. That is the point: the proxy path writes
   * provisionally and lets settlement drop a late-resolved `ignore` row
   * (LLP 0085), and this path has no such window to patch because the verdict
   * is in hand before the write.
   *
   * @ref LLP 0254#policy-inline [implements]: the check runs at ingest with cwd
   *   in hand, so the fail-open window cannot reappear
   * @ref LLP 0254#scope [constrained-by]: LLP 0027 / LLP 0085 stay in force for
   *   the proxy and backfill producers; only this path settles at ingest
   * @param {ClaudeTelemetryEvent[]} events
   * @param {{ records: SessionContextRecord[], tally: BatchSuppressionTally }} args
   * @returns {Promise<ClaudeTelemetryEvent[]>} the events cleared to be written
   */
  async function applyUsagePolicy(events, { records, tally }) {
    const split = partitionByUsagePolicy(events, {
      verdictFor: (sessionId) => resolveSessionUsagePolicy({
        record: pickLatestMatching(records, { sessionId }),
        resolver,
      }),
    })
    for (const [sessionId, entry] of split.droppedBySession) {
      await suppressSession({
        sessionId,
        events: entry.events,
        policySource: 'usage_policy',
        tally,
        fields: {
          // The governing file, as the proxy projector reports it, so one query
          // answers "what suppressed this" across both producers. The cwd
          // itself is not logged on either path.
          governed_by: entry.verdict.governedBy ?? null,
          declared: entry.verdict.declared ?? null,
          ...(entry.verdict.warn ? { warn: entry.verdict.warn } : {}),
        },
      })
    }
    for (const [sessionId, entry] of split.withheldBySession) {
      await suppressSession({
        sessionId,
        events: entry.events,
        policySource: 'undetermined_cwd',
        withheld: true,
        tally,
        fields: {
          // Names the recovery path in the signal itself: the content is still
          // in the Claude Code transcript, where `hyp backfill claude` reads it
          // with the cwd resolved per session.
          recovery: 'transcript_backfill',
        },
      })
    }
    return split.kept
  }

  /**
   * Publish one batch's suppression counts on its receive span. Set only when
   * non-zero, so a routine batch's span stays free of noise fields.
   *
   * @param {{ setAttribute(key: string, value: unknown): unknown }} span
   * @param {BatchSuppressionTally} tally
   */
  function recordSuppression(span, tally) {
    if (tally.eventsDropped > 0) span.setAttribute('events_dropped', tally.eventsDropped)
    if (tally.bodiesDropped > 0) span.setAttribute('bodies_dropped', tally.bodiesDropped)
    if (tally.eventsUndetermined > 0) {
      span.setAttribute('events_undetermined', tally.eventsUndetermined)
    }
  }

  return async function handle(req) {
    await withSpan(
      'claude.telemetry.receive',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.PLUGIN]: PLUGIN_NAME,
        [Attr.OPERATION]: 'claude.telemetry.receive',
        hyp_source: CLAUDE_TELEMETRY_SOURCE,
        signal: req.signal,
        payload_bytes: req.payloadBytes,
        status: 'ok',
      },
      async (span) => {
        /** @type {BatchSuppressionTally} */
        const tally = { eventsDropped: 0, eventsUndetermined: 0, bodiesDropped: 0 }

        // Metrics ride the same exporter config; the message dataset has
        // nothing to learn from them, but the behavioral dataset does
        // (cost and activity counters), so they take the short path:
        // flatten, record, done - no bodies, no projection.
        if (req.signal === 'metrics') {
          const allMetricEvents = flattenClaudeTelemetryMetrics(req.data)
          span.setAttribute('event_count', allMetricEvents.length)
          span.setAttribute('row_count', 0)
          if (allMetricEvents.length === 0) {
            span.setAttribute('telemetry_row_count', 0)
            return
          }
          state.eventsReceived += allMetricEvents.length
          for (const event of allMetricEvents) {
            if (event.timestamp) state.lastEventAt = newerEventTimestamp(state.lastEventAt, event.timestamp)
          }
          // The opt-out covers the behavioral record too: a metric data
          // point names its session, so it is droppable on the same key.
          // @ref LLP 0256#control-route-on-listener [implements]: ingest drops
          //   by session id on every signal this listener serves
          const metricSplit = partitionIgnoredSessionEvents(allMetricEvents, ignoredSessions)
          if (metricSplit.droppedBySession.size > 0) {
            await dropIgnoredSessions(metricSplit.droppedBySession, tally)
          }
          // And so does the folder policy: a cost counter names its session
          // and its model, which is attribution for a directory the user asked
          // us to leave alone.
          const metricEvents = await applyUsagePolicy(metricSplit.kept, {
            records: await readSessionContext(),
            tally,
          })
          recordSuppression(span, tally)
          if (metricEvents.length === 0) {
            span.setAttribute('telemetry_row_count', 0)
            return
          }
          const written = await recordTelemetryEvents(metricEvents, { ctx, state, span })
          span.setAttribute('telemetry_row_count', written)
          ctx.log.info('claude.telemetry.batch', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            signal: req.signal,
            event_count: metricEvents.length,
            telemetry_rows_written: written,
          })
          return
        }

        const allEvents = flattenClaudeTelemetryEvents(req.data)
        span.setAttribute('event_count', allEvents.length)
        if (allEvents.length === 0) {
          span.setAttribute('row_count', 0)
          return
        }
        state.eventsReceived += allEvents.length
        for (const event of allEvents) {
          if (event.timestamp) state.lastEventAt = newerEventTimestamp(state.lastEventAt, event.timestamp)
        }

        // The per-session opt-out, enforced at ingest BEFORE the spool is
        // read: a dropped session's events project nothing into either
        // dataset, and its body files are deleted rather than skipped, so
        // the transport works AND the content goes.
        // @ref LLP 0256#bodies-deleted [implements]
        const split = partitionIgnoredSessionEvents(allEvents, ignoredSessions)
        if (split.droppedBySession.size > 0) {
          await dropIgnoredSessions(split.droppedBySession, tally)
        }

        // Then the folder policy, on the same batch, still before the spool is
        // read and before anything is written. Both gates run ahead of every
        // write on this path, which is what leaves no window for a verdict to
        // arrive after the data.
        // @ref LLP 0254#policy-inline [implements]: `.hypignore` and the
        //   machine-local list decide at ingest, from the hook's cwd
        const records = await readSessionContext()
        const events = await applyUsagePolicy(split.kept, { records, tally })
        recordSuppression(span, tally)
        if (events.length === 0) {
          span.setAttribute('row_count', 0)
          span.setAttribute('telemetry_row_count', 0)
          return
        }

        // @ref LLP 0257#ingest [implements]: body files named by `body_ref`
        // are read for the gap fields, then deleted after the write below.
        const spooled = await loadSpooledBodies(events, { spoolDir })
        state.bodiesMissing += spooled.missing
        state.bodiesUnparseable += spooled.unparseable
        span.setAttribute('body_count', spooled.bodies.size)
        if (spooled.unparseable > 0) {
          span.setAttribute('bodies_unparseable', spooled.unparseable)
          ctx.log.warn('claude.telemetry.body_unparseable', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            error_kind: 'body_unparseable',
            body_count: spooled.unparseable,
          })
        }
        for (const ref of spooled.refused) {
          ctx.log.warn('claude.telemetry.body_ref_refused', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            error_kind: 'body_ref_outside_spool',
            body_ref_sha256: bodyRefDigest(ref),
          })
        }

        // What the usage index held before projection claims anything out of
        // it, so a failed write can put back what it took (see the catch
        // below). A copy of one Map of small objects, per POST.
        const usageBeforeProjection = new Map(usageByRequestId)

        // The same records the policy gate decided on, so the cwd a row is
        // stamped with is the cwd its verdict was resolved from.
        const projections = projectClaudeTelemetryEvents(events, {
          clientName: deps.clientName,
          usageByRequestId,
          sessionContext: (sessionId) => pickLatestMatching(records, { sessionId }),
          spooledBodies: spooled.bodies,
          sessionBodyFacts,
        })
        span.setAttribute('session_count', projections.length)

        let rowsWritten = 0
        let rowsSkipped = 0
        try {
          for (const projection of projections) {
            // @ref LLP 0252#projection-unchanged [implements]: the same
            // projected-exchange path the proxy and backfill producers use, so
            // `part_id` dedupe absorbs the overlap between them.
            const result = await deps.gateway.recordProjectedExchange(projection, {
              gatewayAttributes: { gateway: { source: 'otel' } },
            })
            rowsWritten += result.rowsWritten
            rowsSkipped += result.rowsSkipped
          }
        } catch (err) {
          // Projection CONSUMED the usage index (an `api_request`'s tokens and
          // cost are claimed by the `assistant_response` that names its
          // `request_id`), but no row carrying them reached the dataset. The
          // exporter retries this batch, and a retry that re-projects against a
          // drained index writes the same assistant rows with no
          // `attributes.usage` and no `claude.cost_usd` - a permanent hole in
          // exactly the batch that already failed once. Put back only what this
          // batch consumed: entries it newly remembered are left alone, so an
          // `api_request` whose response has not arrived yet still waits here.
          // @ref LLP 0257#failure-modes [implements]: S18 - a retried batch is
          //   re-projected from the same inputs, so its inputs have to survive
          for (const [requestId, usage] of usageBeforeProjection) {
            if (!usageByRequestId.has(requestId)) usageByRequestId.set(requestId, usage)
          }
          state.lastError = err instanceof Error ? err.message : String(err)
          span.setAttribute('error_kind', 'dataset_write')
          span.setAttribute('row_count', rowsWritten)
          ctx.log.error('claude.telemetry.write_failed', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            event_count: events.length,
            error: state.lastError,
          })
          throw err
        }

        state.rowsWritten += rowsWritten
        state.rowsSkipped += rowsSkipped

        // The behavioral half of the batch, written AFTER the message
        // rows: a failure here becomes an HTTP error the exporter
        // retries, and on that retry the message rows dedupe by
        // `part_id` while this write (which never happened) is
        // re-attempted - the reverse order would duplicate behavioral
        // rows on every message-write retry.
        // @ref LLP 0255#own-dataset [implements]: behavioral events land in
        //   `claude_telemetry_events`, next to (not inside) the message rows
        const telemetryRowsWritten = await recordTelemetryEvents(events, { ctx, state, span })
        span.setAttribute('telemetry_row_count', telemetryRowsWritten)

        // Projected, then deleted: the writes above succeeded, so nothing
        // will ever need these files again.
        // @ref LLP 0252#project-then-delete [implements]: deletion is the
        //   normal end of a body's life, not a cleanup pass
        if (spooled.consumedFiles.length > 0) {
          const removed = await deleteSpooledBodies(spooled.consumedFiles)
          state.bodiesProjected += spooled.bodies.size
          state.bodiesDeleted += removed.deleted
          // What actually left the disk, not what was read. A body whose
          // unlink failed (EPERM, a read-only spool) is still occupying the
          // cap, and subtracting its bytes here would under-report
          // `spool_bytes` until the next sweep restated it, which is the drop
          // arm's bug in the other direction.
          state.spoolBytes = Math.max(0, state.spoolBytes - removed.bytesRemoved)
          span.setAttribute('bodies_projected', spooled.bodies.size)
          span.setAttribute('bodies_deleted', removed.deleted)
        }

        span.setAttribute('row_count', rowsWritten)
        span.setAttribute('rows_skipped', rowsSkipped)
        ctx.log.info('claude.telemetry.batch', {
          [Attr.PLUGIN]: PLUGIN_NAME,
          event_count: events.length,
          session_count: projections.length,
          rows_written: rowsWritten,
          rows_skipped: rowsSkipped,
          telemetry_rows_written: telemetryRowsWritten,
          bodies_projected: spooled.bodies.size,
          bodies_missing: spooled.missing,
        })
      },
      { component: 'plugin.claude' }
    )
  }
}

/**
 * The later of two event timestamps, compared as instants rather than as
 * strings.
 *
 * Claude Code stamps `event.timestamp` from more than one producer, so a
 * batch mixes `...:24Z` with `...:24.500Z`, and a legal OTLP timestamp may
 * carry a numeric offset instead of `Z`. By text `...:24Z` sorts AFTER
 * `...:24.500Z` ('Z' is above '.'), and `...T21:00+03:00` sorts after an hour
 * that is genuinely later in UTC, so the running max could go backwards on a
 * perfectly ordered stream. This value is published as `last_event_at`, the
 * baseline `hyp status` measures a capture gap from, where running backwards
 * invents a gap that is not there.
 *
 * `event.timestamp` is whatever string the attribute carried, unvalidated, so
 * one malformed value has to stay one malformed value. A value that names an
 * instant therefore beats one that names nothing, whichever side it is on: a
 * text compare between the two orders nothing real, and letting the
 * unparseable side win would pin `last_event_at` for the life of the daemon
 * (`unknown` sorts above every ISO string that could follow it, so no later
 * event ever displaces it), which is the invented capture gap this function
 * exists to prevent, reached by a slower route. Only when NEITHER parses is
 * there an ordering left to fall back on, and there the string compare is what
 * this did for every value before.
 *
 * @ref LLP 0257#status-and-health [implements]: `last_event_at` is the
 *   capture-gap baseline, so it has to name the newest instant seen
 * @param {string | undefined} current
 * @param {string} next
 * @returns {string}
 */
export function newerEventTimestamp(current, next) {
  if (current === undefined) return next
  const currentMs = Date.parse(current)
  const nextMs = Date.parse(next)
  const currentParsed = !Number.isNaN(currentMs)
  const nextParsed = !Number.isNaN(nextMs)
  if (currentParsed && nextParsed) return nextMs > currentMs ? next : current
  if (currentParsed !== nextParsed) return currentParsed ? current : next
  return next > current ? next : current
}

/**
 * Split one batch by the in-memory ignored-session set: events whose
 * `session.id` is in the set are dropped, everything else is kept.
 *
 * The match key is the raw `session.id` the event carries, compared
 * verbatim against the raw token the control route stored - the same R5
 * discipline the gateway's drop applies, so `hyp session ignore` reaches
 * both recorders with one resolved id. An event that names NO session is
 * kept: the set holds exact keys, and dropping what cannot be matched
 * would suppress rows nobody opted out.
 *
 * @ref LLP 0066#requirements: R5 - the match key is the session_id the
 *   recorder resolves and stamps, verbatim
 * @param {ClaudeTelemetryEvent[]} events
 * @param {Set<string>} ignoredSessions
 * @returns {{ kept: ClaudeTelemetryEvent[], droppedBySession: Map<string, ClaudeTelemetryEvent[]> }}
 */
export function partitionIgnoredSessionEvents(events, ignoredSessions) {
  /** @type {ClaudeTelemetryEvent[]} */
  const kept = []
  /** @type {Map<string, ClaudeTelemetryEvent[]>} */
  const droppedBySession = new Map()
  if (ignoredSessions.size === 0) return { kept: events.slice(), droppedBySession }
  for (const event of events) {
    const sessionId = event.attributes['session.id']
    if (typeof sessionId === 'string' && ignoredSessions.has(sessionId)) {
      const bucket = droppedBySession.get(sessionId)
      if (bucket) bucket.push(event)
      else droppedBySession.set(sessionId, [event])
    } else {
      kept.push(event)
    }
  }
  return { kept, droppedBySession }
}

/**
 * Write one batch's behavioral rows into `claude_telemetry_events`.
 * Content and body-pointer events yield no rows (`claudeTelemetryEventRows`
 * filters them), so a purely conversational batch writes nothing here.
 *
 * A failure is handled exactly like a message-dataset write failure:
 * counted on the state, marked on the span, logged, and re-thrown so
 * the transport answers with an error the exporter retries.
 *
 * @ref LLP 0257#outputs [implements]: one row per event, hot fields typed,
 *   the remainder in the attributes JSON column
 * @param {ClaudeTelemetryEvent[]} events
 * @param {{
 *   ctx: PluginActivationContext,
 *   state: ClaudeTelemetryListenerState,
 *   span: { setAttribute(key: string, value: unknown): unknown },
 * }} args
 * @returns {Promise<number>} rows written
 */
async function recordTelemetryEvents(events, { ctx, state, span }) {
  const rows = claudeTelemetryEventRows(events)
  if (rows.length === 0) return 0
  try {
    await ctx.storage.appendRows(
      claudeTelemetryTablePath(ctx.storage),
      [...CLAUDE_TELEMETRY_EVENT_COLUMNS],
      rows
    )
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err)
    span.setAttribute('error_kind', 'dataset_write')
    ctx.log.error('claude.telemetry.write_failed', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      dataset: 'claude_telemetry_events',
      event_count: events.length,
      error: state.lastError,
    })
    throw err
  }
  state.telemetryRowsWritten += rows.length
  return rows.length
}

/**
 * Bind the listener, falling back to an ephemeral port when the DEFAULT
 * port is taken. An address the operator wrote down fails loudly
 * instead; a default that happens to collide must not stop the daemon,
 * because attach reads the bound port off the source status anyway.
 *
 * @ref LLP 0114#explicit-listen-fails-loudly [constrained-by]: only the
 *   unconfigured default falls back
 * @param {{
 *   server: Server,
 *   listen: { host: string, port: number, portConfigured: boolean },
 *   log: PluginActivationContext['log'],
 *   state: { listenFallbackFrom: number | undefined },
 * }} args
 */
async function bindWithFallback({ server, listen, log, state }) {
  try {
    return await listenAndResolve(server, listen.host, listen.port, LISTENER_NAME)
  } catch (err) {
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
    if (listen.portConfigured || code !== 'EADDRINUSE') throw err
    log.warn('claude.telemetry.default_port_taken', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      listen_port: listen.port,
    })
    state.listenFallbackFrom = listen.port
    return listenAndResolve(server, listen.host, 0, LISTENER_NAME)
  }
}

/**
 * The listener port `otel`-mode attach writes into
 * `env.OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Three rungs, in trust order. The running daemon's bound port wins: it is the
 * only place the truth lives once the default-port fallback in
 * {@link bindWithFallback} has moved the listener, and the source status is
 * where that promise was made. With no live daemon, a configured fixed port is
 * the address the operator stated. Otherwise the well-known default: the same
 * port the next daemon start will try first, so an attach that ran before the
 * first daemon start still points where the listener will appear. A configured
 * `0` (dynamic) has no knowable port until a daemon publishes one, so it reads
 * as unconfigured here.
 *
 * @ref LLP 0258#env-keys [constrained-by]: the endpoint's port must be the
 *   listener's real one, or the whole env block captures nothing
 * @param {{ stateRoot: string, config: unknown }} args
 * @returns {number}
 */
export function resolveAttachTelemetryPort({ stateRoot, config }) {
  const live = resolveLiveSourceListenPortFromStatus({
    stateRoot,
    sourceName: CLAUDE_TELEMETRY_SOURCE,
  })
  if (live !== undefined) return live

  const raw = /** @type {Record<string, unknown>} */ (
    config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  )
  const telemetry = raw.telemetry
  const slice = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)
    ? /** @type {Record<string, unknown>} */ (telemetry)
    : {}
  const portRaw = slice.listen_port
  if (typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535) {
    return portRaw
  }
  return DEFAULT_TELEMETRY_PORT
}

/**
 * Resolve where the body spool lives and how large it may grow. The
 * directory is fixed under the HypAware home (attach, detach, and
 * `hyp purge` all derive the same path); only the byte cap is config,
 * `telemetry.spool_max_bytes`, defaulting to 512 MB. A mistyped cap
 * falls back to the default and warns, matching `readListenConfig`.
 *
 * @ref LLP 0253#byte-cap [implements]: the cap is one config value an operator
 *   can lower on a small disk
 * @param {PluginActivationContext} ctx
 * @returns {{ dir: string, maxBytes: number }}
 */
export function readSpoolConfig(ctx) {
  const dir = claudeBodySpoolDir(readObservabilityEnv(ctx.env).hypHome)
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const telemetry = config.telemetry
  const slice = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)
    ? /** @type {Record<string, unknown>} */ (telemetry)
    : {}

  let maxBytes = DEFAULT_SPOOL_MAX_BYTES
  const raw = slice.spool_max_bytes
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    maxBytes = raw
  } else if (raw !== undefined) {
    ctx.log.warn('claude.telemetry.config_invalid', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      key: 'telemetry.spool_max_bytes',
      value_type: typeof raw,
    })
  }
  return { dir, maxBytes }
}

/**
 * Read `telemetry.listen_host` / `telemetry.listen_port` out of the
 * plugin's config slice. Mistyped values fall back to the defaults and
 * warn, matching the OTLP receiver's behavior.
 *
 * @param {PluginActivationContext} ctx
 * @returns {{ host: string, port: number, portConfigured: boolean }}
 */
export function readListenConfig(ctx) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const telemetry = config.telemetry
  const slice = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)
    ? /** @type {Record<string, unknown>} */ (telemetry)
    : {}

  let host = DEFAULT_HOST
  const hostRaw = slice.listen_host
  if (typeof hostRaw === 'string' && hostRaw.length > 0) host = hostRaw
  else if (hostRaw !== undefined) {
    ctx.log.warn('claude.telemetry.config_invalid', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      key: 'telemetry.listen_host',
      value_type: typeof hostRaw,
    })
  }

  let port = DEFAULT_TELEMETRY_PORT
  let portConfigured = false
  const portRaw = slice.listen_port
  if (typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw >= 0 && portRaw <= 65535) {
    port = portRaw
    portConfigured = true
  } else if (portRaw !== undefined) {
    ctx.log.warn('claude.telemetry.config_invalid', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      key: 'telemetry.listen_port',
      value_type: typeof portRaw,
    })
  }

  return { host, port, portConfigured }
}
