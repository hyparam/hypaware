// @ts-check

import {
  Attr,
  getKernelInstruments,
  getMeter,
  getLogger,
} from '../../../../src/core/observability/index.js'

import {
  createLeafStore,
  defaultStateRoot,
  ensureLocalCa,
  INTERCEPT_PROVIDER_HOSTS,
  readLocalCaInfo,
} from '../../../../src/core/tls/ca.js'

import { compileConfig, compileUpstreams, FALLBACK_LISTEN } from './config.js'
import { createControlHandler } from '../../../../src/core/control/session_ignore.js'
import { AI_GATEWAY_SCHEMA_COLUMNS, aiGatewayTablePath, DATASET_NAME } from './dataset.js'
import { createEntrypointActivity } from './entrypoint_activity.js'
import { createAiGatewayMessageProjector, rollbackAiGatewayStateJournal } from './message_projector.js'
import { createChainedAgent, startProxy } from './proxy.js'
import { createRecorder } from './recorder.js'

const PLUGIN_NAME = '@hypaware/ai-gateway'

/**
 * @import { PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AiGatewayConfig, FinishedRow, GatewayState, StartedProxy, UpstreamConfig } from './types.js'
 * @import { Exchange } from './recorder.js'
 */

/**
 * Build the source `start` callback the plugin registers against the
 * kernel `SourceRegistry`. Closed over `state` so the running listener
 * and the `AiGatewayCapability.localEndpoint()` facade always agree on
 * the bound `host:port`.
 *
 * @param {GatewayState} state
 */
export function createStartSource(state) {
  /**
   * @param {PluginActivationContext} ctx
   * @returns {Promise<StartedSource>}
   */
  return async function startAiGatewaySource(ctx) {
    /** @type {{ rowsWritten: number, exchangeBytes: number, lastError: string | undefined, listenFallbackFrom: string | undefined, interception: { fingerprint: string, hosts: string[], caHosts: string[], notAfter: string, certPath: string } | undefined, interceptionError: string | undefined, entrypoints: ReturnType<typeof createEntrypointActivity> }} */
    const liveState = {
      rowsWritten: 0,
      exchangeBytes: 0,
      lastError: undefined,
      listenFallbackFrom: undefined,
      // Set by `prepareInterception` on every (re)launch: what the CA vouches
      // for, or why there is no CA. Both are things an operator has to be able
      // to read without grepping the boot log.
      interception: undefined,
      interceptionError: undefined,
      // Lives on `liveState`, not on the per-bind closure below, so a
      // config reload (which tears the listener down and builds a fresh
      // recorder) does not erase what this daemon has already seen.
      entrypoints: createEntrypointActivity(),
    }

    // `undefined` when the compiled routing table is empty: the source idles
    // instead of binding a listener that could route nothing. See
    // {@link launchListener}.
    let proxy = await launchListener(ctx, state, liveState)

    // The config `status()` reports on, not the one this source booted with.
    // `reload()` hands the daemon's new context to the listener but the
    // closure above keeps the boot-time `ctx` forever, so reading it would
    // publish a stale `details.upstreams` after every reload. Core's
    // dropped-upstream diagnostics read exactly those fields to tell
    // "hermes-only, correctly idle" from "an upstream was dropped", so they
    // have to describe the config in force now.
    let activeCtx = ctx

    return {
      async status() {
        const configured = readConfiguredUpstreams(activeCtx)
        /** @type {SourceStatus} */
        const status = {
          state: 'ready',
          rowsWritten: liveState.rowsWritten,
          details: {
            // Omitted while idle, which is already how `gatewaySourceDetails`
            // (core `daemon/status.js`) reads "no reachable gateway here" off
            // the status file for a bind that never happened.
            ...(proxy ? { host: proxy.host, port: proxy.port } : { listening: false }),
            // Raw configured names, pre-compile, deliberately: an entry the
            // compiler dropped (a `url =` where `base_url` was meant) still
            // appears here, which is what lets core see the difference
            // between a gateway with nothing to proxy and a gateway whose
            // upstream fell out of the routing table.
            upstreams: configured.names,
            // The names cannot carry the whole signal, because `name` is one
            // of the two keys whose absence drops an entry: an upstream
            // written with a `provider` and a `base_url` but no `name` leaves
            // `upstreams: []`, indistinguishable from hermes-only. The count
            // is the wider question ("did this config ask for any upstream at
            // all?"); the names only decide how core's warning reads.
            upstreams_configured: configured.count,
            // How many of those entries `compileUpstreams` threw away, which
            // is the difference between "this gateway is idle because it was
            // asked to be" and "this gateway routes less than it was asked
            // to". Reported unconditionally, including as `0`: core tells a
            // healthy gateway from a status file written before this field
            // existed by the field's presence, not by its value.
            upstreams_dropped: configured.dropped,
            ...(configured.droppedNames.length > 0
              ? { upstreams_dropped_names: configured.droppedNames }
              : {}),
            registered_presets: Array.from(state.presets.keys()),
            projectors: state.projectors.map((p) => p.name),
            // @ref LLP 0066#ephemeral: surface the live opt-out count so an
            // operator can see an active session drop without grepping logs.
            ignored_sessions: state.ignoredSessions.size,
            // @ref LLP 0114#fallback-is-visible [implements]: a fallback boot is
            // readable from status.json steadily, not only from a boot-time log line
            ...(liveState.listenFallbackFrom
              ? { listen_fallback: true, listen_fallback_from: liveState.listenFallbackFrom }
              : {}),
            // Which client surfaces have actually produced rows through this
            // gateway, and when. The daemon refreshes source details on every
            // tick, so this reaches status.json steadily and `hyp status` can
            // answer "did Codex Desktop traffic arrive recently?" with no
            // cache read (LLP 0164).
            // @ref LLP 0164#status-reads-it-from-the-status-file [implements]: last-seen entrypoints ride the gateway source's status details
            recent_entrypoints: liveState.entrypoints.snapshot(),
            // Proxy mode is the difference between a listener that only sees
            // what a client points at it and one that terminates TLS, so it is
            // never left to be inferred. The fingerprint and expiry are what a
            // user checks their client's trusted certificate against.
            // @ref LLP 0235#ca-lifecycle [implements]: the CA is visible in status, not only in a boot log
            proxy_mode: Boolean(liveState.interception),
            ...(liveState.interception
              ? {
                ca_fingerprint: liveState.interception.fingerprint,
                ca_not_after: liveState.interception.notAfter,
                ca_cert_path: liveState.interception.certPath,
                intercept_hosts: liveState.interception.hosts,
                // Wider than intercept_hosts by design: the full provider set
                // the user's one trust grant covers (LLP 0238).
                ca_permitted_hosts: liveState.interception.caHosts,
              }
              : {}),
            ...(liveState.interceptionError
              ? { proxy_mode_error: liveState.interceptionError }
              : {}),
          },
        }
        if (!proxy) status.message = 'idle: no upstreams configured, nothing to proxy'
        if (liveState.lastError) status.lastError = liveState.lastError
        return status
      },

      async reload(nextCtx) {
        // Tear down the old listener and bring up a fresh one with the
        // new config. Connections in flight finish through the
        // recorder's drain (called inside stop()) so their rows are not
        // lost across the reload.
        await proxy?.stop()
        state.listen = undefined
        proxy = await launchListener(nextCtx, state, liveState)
        activeCtx = nextCtx
      },

      async stop() {
        await proxy?.stop()
        state.listen = undefined
      },
    }
  }
}

/**
 * Bind the HTTP listener and wire it to the recorder and the
 * exchange-projector dispatcher. Sets `state.listen` so
 * `AiGatewayCapability.localEndpoint()` returns the bound URL; clears
 * it on stop/reload.
 *
 * Returns `undefined` when the compiled routing table is empty, leaving the
 * source idle with no listener at all.
 *
 * The gateway plugin does two separable jobs, and a config can legitimately
 * want only one. At activation it contributes the `ai_gateway_messages`
 * dataset and the shared `ai_gateway.projected_exchange` materializer; at
 * source start it runs the proxy. `@hypaware/hermes` wants the first alone:
 * it reads Hermes's own `state.db` and is "never modified, configured, or
 * proxied" (LLP 0119), yet the materializer is a hard `requires.plugins`
 * dependency (LLP 0120), so its picker row composes the gateway plugin while
 * contributing no upstream. A hermes-only picker run therefore produces
 * `upstreams: []` with no adapter presets either, and failing the source
 * start there would take a correct install down over a dataset-only
 * dependency. Idling instead leaves `state.listen` unset, so
 * `localEndpoint()` keeps throwing rather than handing an attach a URL
 * nothing is listening on.
 *
 * @ref LLP 0120#consequences [constrained-by]: hermes composes the gateway plugin for the materializer alone, so an upstream-less gateway is a valid config rather than a misconfiguration
 * @ref LLP 0195#idle-not-throw [implements]: the "at least one upstream" invariant moves here from startProxy, which still keeps it for a bind
 *
 * @param {PluginActivationContext} ctx
 * @param {GatewayState} state
 * @param {{ rowsWritten: number, exchangeBytes: number, lastError: string | undefined, listenFallbackFrom: string | undefined, interception: { fingerprint: string, hosts: string[], caHosts: string[], notAfter: string, certPath: string } | undefined, interceptionError: string | undefined, entrypoints: ReturnType<typeof createEntrypointActivity> }} liveState
 * @returns {Promise<StartedProxy | undefined>}
 */
async function launchListener(ctx, state, liveState) {
  const config = compileConfig(ctx.config)
  // Hoisted out of `bind` below (which runs twice on the EADDRINUSE fallback
  // path) because the answer decides whether we bind at all. Pure over
  // `config.upstreams` and `state.presets`, neither of which moves between
  // the two binds.
  const upstreams = mergeUpstreams(config.upstreams, state)
  const configured = readConfiguredUpstreams(ctx)
  if (upstreams.length === 0) {
    liveState.listenFallbackFrom = undefined
    // Two configs reach an empty routing table and they are not the same
    // event. A hermes-only install asked for no upstream at all: idle is the
    // outcome it wanted, and `info` is the right volume. A config that listed
    // upstreams and still compiled to none lost every one of them to
    // `compileUpstreams` (a missing or misspelled `base_url` is dropped
    // silently), so the operator is going to get ECONNREFUSED from a gateway
    // that reports itself started. Name the entries that vanished, at `warn`.
    if (configured.count > 0) {
      ctx.log.warn('aigw.idle_no_upstreams', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        registered_presets: state.presets.size,
        configured_upstreams: configured.count,
        configured_upstream_names: configured.names,
        reason: 'every configured upstream was dropped at compile: check base_url on each entry',
      })
    } else {
      ctx.log.info('aigw.idle_no_upstreams', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        registered_presets: state.presets.size,
      })
    }
    // Idling is only safe while nothing depends on the port answering. A CA on
    // disk says a client was attached in proxy mode and may still have
    // `HTTPS_PROXY` pointing here for ALL of its egress, so not binding at all
    // breaks its authentication and updates rather than only its capture. Bind
    // anyway and serve blind tunnels: `prepareInterception` reaches
    // `tunnelOnly` from an empty host list, and every request that is not a
    // CONNECT still 404s exactly as an idle gateway's would.
    // @ref LLP 0233#degrade-to-blind-tunnels [implements]: an empty routing table must not strand a proxy-attached client
    const stranded = await readLocalCaInfo({ stateRoot: defaultStateRoot(ctx.env) })
    if (!stranded) return undefined
    ctx.log.warn('aigw.idle_serves_tunnels', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      ca_cert_path: stranded.certPath,
      reason: 'no upstream to route, but a local CA means a client may still proxy through ' +
        'this port; binding for blind tunnels so its egress keeps working, unrecorded',
    })
  }
  if (configured.dropped > 0) {
    // The routing table is non-empty but smaller than the config asked for.
    // This is the quieter half of the same fault and the one nothing used to
    // report at all: the proxy binds, `hyp status` reads `started`, and every
    // request meant for the dropped upstream falls through to whatever the
    // remaining routes match (or nothing). Logged at boot as well as surfaced
    // in status, because the boot log is where the operator looks first when
    // one provider's traffic never shows up in the cache.
    ctx.log.warn('aigw.upstreams_dropped', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      configured_upstreams: configured.count,
      dropped_upstreams: configured.dropped,
      dropped_upstream_names: configured.droppedNames,
      routed_upstreams: upstreams.length,
      reason: 'an upstream needs both a name and a base_url to compile to a route',
    })
  }
  const recorder = createRecorder({ redactHeaders: config.redactHeaders })
  const projector = createAiGatewayMessageProjector({
    gatewayId: config.gatewayId,
    projectors: state.projectors,
    // Thread storage so the projector can lazily seed its seen-set from
    // committed part_ids per conversation (without it a restart/reload
    // rebuilds an empty set and replays re-emit duplicate-part_id rows).
    storage: ctx.storage,
    log: ctx.log,
    // Hand adapters a read-only membership test against the gateway's
    // in-memory ignored-session set. The set lives on `state` (survives a
    // reload; dies with the process), so the predicate closes over the live
    // set, not a snapshot. @ref LLP 0066#enforcement
    isSessionIgnored: (id) => state.ignoredSessions.has(id),
  })
  const sourcesLog = getLogger('sources')
  const meter = getMeter('plugin.ai-gateway')
  const exchangeBytesCounter = meter.createCounter('aigw.exchange_bytes', {
    description: 'Bytes flowed through the AI gateway per exchange, by upstream',
  })
  const kernelInstruments = getKernelInstruments()

  const tablePath = aiGatewayTablePath(ctx.storage)

  /** @param {Exchange} exchange */
  async function onExchangeFinished(exchange) {
    /** @type {FinishedRow} */
    const row = exchange.finalize()
    const totalBytes = (row.request_bytes ?? 0) + (row.response_bytes ?? 0)
    // Projection marks its messages seen in the listener-lifetime dedup
    // state while it builds the rows, and the append below can still fail.
    // A conversation replays its earlier messages on every later exchange,
    // so leaving those marks in place after a failed write would make this
    // batch unrecoverable for the life of the listener rather than merely
    // late. Issue #879.
    /** @type {(() => void)[]} */
    const journal = []
    // Set the moment the append resolves. The catch below covers the
    // bookkeeping after the write too (entrypoint activity, counters,
    // logging), and rolling back there would un-mark messages that DID
    // land: unlike the OTEL writer this path has no `part_id` dedupe in
    // front of it, and the flush-time `dedupeByPartId` only runs for
    // fallback-identity batches, so the replay of a native-identity
    // conversation would commit a second copy of every one of them.
    let appended = false
    try {
      const messageRows = await projector.projectExchange(row, { journal })
      if (messageRows.length > 0) {
        await ctx.storage.appendRows(tablePath, [...AI_GATEWAY_SCHEMA_COLUMNS], messageRows)
        appended = true
        liveState.rowsWritten += messageRows.length
        // Recorded only after the append resolves: "recent clients" in
        // `hyp status` must mean rows that landed, not rows that were
        // projected and then lost to a write failure.
        liveState.entrypoints.record(messageRows)
        kernelInstruments.rowsWritten.add(messageRows.length, {
          [Attr.DATASET]: DATASET_NAME,
          [Attr.PLUGIN]: PLUGIN_NAME,
        })
      }
      liveState.exchangeBytes += totalBytes
      exchangeBytesCounter.add(totalBytes, {
        [Attr.PLUGIN]: PLUGIN_NAME,
        hyp_upstream: row.upstream,
      })
      const devRunId = extractDevRunId(row.metadata)
      ctx.log.info('aigw.exchange', {
        upstream: row.upstream,
        path: row.path ?? '',
        status_code: row.status_code ?? 0,
        request_bytes: row.request_bytes ?? 0,
        response_bytes: row.response_bytes ?? 0,
        is_sse: row.is_sse ?? false,
        rows_written: messageRows.length,
        ...(devRunId ? { [Attr.DEV_RUN_ID]: devRunId } : {}),
      })
    } catch (err) {
      if (!appended) rollbackAiGatewayStateJournal(journal)
      const message = err instanceof Error ? err.message : String(err)
      liveState.lastError = message
      sourcesLog.error('aigw.exchange_write_failed', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        upstream: row.upstream,
        error: message,
      })
    }
  }

  // Proxy mode: mint the machine-local CA for exactly the hosts the routing
  // table names, and hand the listener a leaf minter. Built before the bind so
  // a CA failure surfaces as a source-start error rather than as unexplained
  // TLS failures once traffic arrives.
  // @ref LLP 0234#intercept-set-is-the-routing-table [implements]: the CA is constrained to the upstream hosts and nothing else
  const interception = await prepareInterception(ctx, config, upstreams, liveState)

  // A mistyped `upstream_proxy` compiles to `undefined` rather than throwing,
  // which is the right call (a typo must not take capture down) but is silent
  // on its own: the operator configured a required egress path and the gateway
  // would quietly connect direct instead, failing every upstream call with no
  // stated cause. Naming it here is the "the source reports it" half of that
  // contract.
  if (typeof ctx.config?.upstream_proxy === 'string' && !config.upstreamProxy) {
    ctx.log.warn('aigw.upstream_proxy_invalid', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      // The value itself is not logged: it is exactly the field that carries
      // proxy credentials.
      reason: 'upstream_proxy is not a usable http(s) proxy URL; connecting direct instead',
    })
  }

  // Built once, outside `bind`: the EADDRINUSE fallback calls `bind` twice, and
  // a second agent would leak a keep-alive pool nothing ever closes.
  const chainedAgent = config.upstreamProxy ? createChainedAgent(config.upstreamProxy) : undefined

  /** @param {string} listen */
  const bind = (listen) => startProxy({
    listen,
    upstreams,
    startExchange: (init) => recorder.startExchange(init),
    onExchangeFinished,
    // Serve `/_hypaware/*` control requests locally over the gateway's
    // ignored-session set (POST/DELETE /_hypaware/ignore/session). Handled
    // before upstream matching, never proxied, no exchange recorded.
    // @ref LLP 0066#control-path
    onControlRequest: createControlHandler({ ignoredSessions: state.ignoredSessions, log: ctx.log }),
    log: ctx.log,
    ...(interception?.hooks ? { interception: interception.hooks } : {}),
    ...(interception?.tunnelOnly ? { tunnelOnly: true } : {}),
    ...(config.upstreamProxy ? { upstreamProxy: config.upstreamProxy } : {}),
    ...(chainedAgent ? { chainedAgent } : {}),
  })

  liveState.listenFallbackFrom = undefined
  const proxy = await bindProxyWithFallback({
    config,
    bind,
    log: ctx.log,
    onFallback: () => { liveState.listenFallbackFrom = config.listen },
  })

  state.listen = { host: proxy.host, port: proxy.port }

  // Hook stop so in-flight exchanges drain before the listener fully closes.
  const originalStop = proxy.stop
  proxy.stop = async () => {
    await recorder.drain(5000)
    await originalStop.call(proxy)
    // Close the chained agent's keep-alive sockets; a config reload builds a
    // fresh listener and a fresh agent, so the old one must not keep its pool.
    chainedAgent?.destroy()
  }

  return proxy
}

/**
 * Prepare TLS interception when proxy mode is on: ensure a machine-local CA
 * exists for exactly the hosts the routing table names, and return a leaf
 * minter for the listener.
 *
 * Returns `undefined` when proxy mode is off, which leaves the listener a plain
 * reverse proxy that refuses CONNECT. Also returns `undefined` (loudly) when
 * the CA cannot be created: a gateway that still proxies is strictly better
 * than one that fails to start, and the `hyp status` surface reports the
 * degraded mode rather than leaving it to be discovered as a TLS error.
 *
 * @ref LLP 0233#proxy-mode-is-explicit [implements]
 * @param {PluginActivationContext} ctx
 * @param {AiGatewayConfig} config
 * @param {UpstreamConfig[]} upstreams
 * @param {{ interception: { fingerprint: string, hosts: string[], caHosts: string[], notAfter: string, certPath: string } | undefined, interceptionError: string | undefined }} liveState
 * @returns {Promise<{ hooks?: { secureContextFor: (host: string) => import('node:tls').SecureContext }, tunnelOnly: boolean } | undefined>}
 */
async function prepareInterception(ctx, config, upstreams, liveState) {
  liveState.interception = undefined
  liveState.interceptionError = undefined

  if (!config.proxyMode) {
    // Proxy mode is off, but a CA on disk means a client was attached in proxy
    // mode at some point and may still have `HTTPS_PROXY` pointing here. Serve
    // blind tunnels so its egress keeps working, and say so loudly: the repair
    // is a re-attach (or a detach), and nothing else on the machine will
    // volunteer that.
    const stale = await readLocalCaInfo({ stateRoot: defaultStateRoot(ctx.env) })
    if (stale) {
      liveState.interceptionError = 'proxy_mode is off but a local CA is installed'
      ctx.log.warn('aigw.proxy_mode_stale_ca', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        ca_cert_path: stale.certPath,
        reason: 'serving blind tunnels so an already-attached client keeps working; ' +
          'run `hyp attach claude` to move it back to base-URL mode, or `hyp detach claude`',
      })
      return { tunnelOnly: true }
    }
    return undefined
  }

  // The hosts we will decrypt, for the idle check only. The CA below is
  // deliberately minted against the full static provider list rather than
  // this configured subset, so the user's one keychain trust grant covers a
  // provider enabled later; what is actually intercepted per-connection stays
  // decided by the routing table (`interceptsHost`).
  // @ref LLP 0238#full-provider-constraints [implements]
  /** @type {string[]} */
  const hostList = []
  for (const u of upstreams) {
    const host = hostOfBaseUrl(u.base_url)
    if (host) hostList.push(host)
  }
  const hosts = [...new Set(hostList)]
  if (hosts.length === 0) {
    liveState.interceptionError = 'no upstream host to intercept'
    ctx.log.warn('aigw.interception_idle', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      reason: 'proxy_mode is on but no upstream names a host to terminate',
    })
    return { tunnelOnly: true }
  }

  try {
    // Union, not replacement: an operator-configured upstream outside the
    // static provider list still needs the CA to vouch for it, or every
    // handshake to that host dies in the leaf store. Standard installs are a
    // subset of the static list, so their CA never regenerates for config.
    const ca = await ensureLocalCa({
      stateRoot: defaultStateRoot(ctx.env),
      hosts: [...new Set([...INTERCEPT_PROVIDER_HOSTS, ...hosts])],
    })
    const leaves = createLeafStore(ca)
    // `hosts` is what this config actually decrypts; `caHosts` is the wider
    // set the CA may vouch for. Status reports both so the user's trust grant
    // stays inspectable (LLP 0238's informed-grant consequence).
    liveState.interception = {
      fingerprint: ca.fingerprint,
      hosts,
      caHosts: ca.hosts,
      notAfter: ca.notAfter.toISOString(),
      certPath: ca.certPath,
    }
    ctx.log.info('aigw.interception_ready', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      ca_fingerprint: ca.fingerprint,
      ca_created: ca.created,
      ca_not_after: ca.notAfter.toISOString(),
      intercept_hosts: hosts,
      ca_permitted_hosts: ca.hosts,
    })
    return { hooks: { secureContextFor: (host) => leaves.secureContextFor(host) }, tunnelOnly: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    liveState.interceptionError = message
    ctx.log.error('aigw.interception_unavailable', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      error: message,
      reason: 'proxy mode is configured but no local CA could be prepared; ' +
        'serving blind tunnels so client egress keeps working, unrecorded',
    })
    return { tunnelOnly: true }
  }
}

/** @param {string} baseUrl */
function hostOfBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return undefined
  }
}

/**
 * Bind the listener at the compiled `listen` address, falling back to an
 * ephemeral bind when - and only when - the address was the *default* and its
 * port is already taken. A configured `listen` is a stated requirement, so its
 * bind failure (and any non-EADDRINUSE failure) propagates unchanged.
 *
 * `onFallback` fires just before the fallback bind so the caller can record
 * "this boot is on the fallback path" for the steady status surface.
 *
 * @param {{ config: AiGatewayConfig, bind: (listen: string) => Promise<StartedProxy>, log: { warn(message: string, fields?: Record<string, unknown>): void }, onFallback?: () => void }} args
 * @returns {Promise<StartedProxy>}
 * @ref LLP 0114#ephemeral-fallback [implements]: a defaulted listen whose port is taken falls back to an ephemeral bind; a configured listen fails loudly
 */
export async function bindProxyWithFallback({ config, bind, log, onFallback }) {
  try {
    return await bind(config.listen)
  } catch (err) {
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
    if (config.listenConfigured || code !== 'EADDRINUSE') throw err
    log.warn('aigw.default_port_taken', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      listen: config.listen,
      fallback: FALLBACK_LISTEN,
    })
    onFallback?.()
    return bind(FALLBACK_LISTEN)
  }
}

/**
 * Compile the routing table the proxy uses. TOML-config upstreams
 * are operator-owned and win over adapter presets with the same
 * `name`; presets fill only missing names. The resulting list is
 * sorted by the proxy at compile time.
 *
 * Presets without a `match()` and without a `path_prefix` are filtered
 * out (they can never route a request and would only inflate the
 * compiled table).
 *
 * Exported so routing tests can assert against the table an install
 * really compiles (config plus registered presets, in merge order)
 * rather than against a preset's literal field values, which is what
 * let an over-broad preset priority through review.
 *
 * @param {UpstreamConfig[]} configUpstreams
 * @param {GatewayState} state
 * @returns {UpstreamConfig[]}
 */
export function mergeUpstreams(configUpstreams, state) {
  /** @type {Map<string, UpstreamConfig>} */
  const merged = new Map()
  for (const upstream of configUpstreams) {
    merged.set(upstream.name, upstream)
  }
  for (const preset of state.presets.values()) {
    const hasMatch = typeof preset.match === 'function'
    const hasPathPrefix = typeof preset.path_prefix === 'string' && preset.path_prefix.length > 0
    if (!hasMatch && !hasPathPrefix) continue
    /** @type {UpstreamConfig} */
    const entry = { name: preset.name, base_url: preset.base_url }
    if (preset.provider) entry.provider = preset.provider
    if (hasPathPrefix) entry.path_prefix = preset.path_prefix
    if (typeof preset.priority === 'number') entry.priority = preset.priority
    if (hasMatch) entry.match = preset.match
    const existing = merged.get(preset.name)
    if (!existing) {
      merged.set(preset.name, entry)
      continue
    }
    // Operator config still wins the *routing* question (where traffic goes),
    // but two facts belong to the adapter that registered the preset and are
    // taken from it whenever config did not state them.
    //
    // `record_prefix` is the paths this adapter owns, which is what proxy mode
    // anchors persistence on. Config's `path_prefix` cannot stand in for it: an
    // operator writing `path_prefix = "/"` is saying "route everything on this
    // host to this upstream", not "record everything on this host", and the
    // `hyp init` preset writes exactly that. Reading the routing prefix as a
    // record anchor made proxy mode record nothing at all on a default install.
    // @ref LLP 0234#recording-is-opt-in-per-path [implements]: the record anchor comes from the adapter's preset, not from operator routing config
    if (hasPathPrefix) existing.record_prefix = preset.path_prefix
    // Likewise the provider label: a config entry that omits it would otherwise
    // write unattributed rows.
    if (!existing.provider && preset.provider) existing.provider = preset.provider
  }
  return Array.from(merged.values())
}

/**
 * What the config asked for, and how much of it survived `compileUpstreams`.
 *
 * `compileUpstreams` drops an entry missing either `name` or `base_url` and
 * says nothing, per entry. Comparing the raw entry count against the compiled
 * one is the only way to see that from outside: the compiled table alone
 * cannot tell "the user configured one upstream" from "the user configured
 * three and two evaporated". `dropped` is therefore the signal both the idle
 * log below and core's `hyp status` gate on, and it covers the partial loss
 * (some upstreams routed, one silently not) as well as the total one.
 *
 * The counts lead and the names follow, because `name` is itself one of the
 * two keys whose absence drops an entry: the config that most needs this
 * warning can be exactly the one with no name to print.
 *
 * Defensive: if config has been mutated to a degenerate shape, returns zeroes
 * and empty lists so `status()` never throws.
 *
 * @param {PluginActivationContext} ctx
 * @returns {{ count: number, names: string[], dropped: number, droppedNames: string[] }}
 */
function readConfiguredUpstreams(ctx) {
  const raw = /** @type {Record<string, unknown>} */ (ctx.config ?? {}).upstreams
  if (!Array.isArray(raw)) return { count: 0, names: [], dropped: 0, droppedNames: [] }
  /** @type {string[]} */
  const out = []
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const name = /** @type {Record<string, unknown>} */ (entry).name
      if (typeof name === 'string' && name.length > 0) out.push(name)
    }
  }
  // Run the real compiler rather than re-deriving its "does this entry
  // survive?" predicate here. A second copy of that rule would drift from the
  // one the routing table is actually built with, and this count's whole job
  // is to describe that table.
  const compiled = compileUpstreams(raw)
  const kept = new Set(compiled.map((u) => u.name))
  return {
    count: raw.length,
    names: out,
    dropped: raw.length - compiled.length,
    // Two entries sharing a name where only one compiles leave that name in
    // `kept`, so the loss shows up in `dropped` with no name to print. That is
    // the right way round: the count triggers the warning, the names only make
    // it concrete. The dedupe below handles the opposite duplicate: two
    // entries sharing a name where *neither* compiles would otherwise print
    // that one name twice.
    droppedNames: [...new Set(out.filter((n) => !kept.has(n)))],
  }
}

/**
 * Recover the dev_run_id from a finalized row's JSON metadata. The
 * row stores `metadata` pre-stringified so the storage layer can drop
 * it into a JSON column unchanged; the log emitter needs it as a
 * top-level attribute.
 *
 * @param {string | null} metadataJson
 * @returns {string | undefined}
 */
function extractDevRunId(metadataJson) {
  if (typeof metadataJson !== 'string' || metadataJson.length === 0) return undefined
  try {
    const parsed = JSON.parse(metadataJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = /** @type {Record<string, unknown>} */ (parsed).dev_run_id
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {
    /* metadata is plugin-controlled; a parse error means there's nothing useful to surface */
  }
  return undefined
}
