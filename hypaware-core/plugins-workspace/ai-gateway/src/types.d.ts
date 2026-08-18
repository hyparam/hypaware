import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type {
  AiGatewayClientRegistration,
  AiGatewayExchangeProjector,
  AiGatewayRouteInput,
  AiGatewaySettlementEnricher,
  AiGatewayUpstreamPreset,
  PluginActivationContext,
} from '../../../../hypaware-plugin-kernel-types.d.ts'
import type { Exchange } from './recorder.js'
import type { ExtendedSourceRegistry } from '../../../../src/core/registry/types.d.ts'

export interface ExchangeInit {
  upstream: string
  provider: string | undefined
  method: string | undefined
  path: string | undefined
  requestHeaders: Record<string, string | string[] | undefined>
}

export interface ResponseStart {
  status: number | undefined
  headers: Record<string, string | string[] | undefined>
}

export interface RecorderOptions {
  redactHeaders?: readonly string[]
}

export interface FinishedRow {
  exchange_id: string
  ts_start: string
  ts_end: string | null
  duration_ms: number | null
  upstream: string
  provider: string | null
  method: string | null
  path: string | null
  status_code: number | null
  request_bytes: number | null
  response_bytes: number | null
  is_sse: boolean | null
  stream_event_count: number | null
  /** JSON-stringified headers (post-redact) */
  request_headers: string | null
  request_body: string | null
  response_headers: string | null
  response_body: string | null
  error: string | null
  /** JSON-stringified metadata (incl. dev_run_id) */
  metadata: string | null
  stream_events: Array<{
    kind: 'stream_event'
    exchange_id: string
    t_ms: number
    event: string
    data: string
    id?: string
  }>
}

export interface SseEvent {
  /** Event type. Defaults to 'message' when no `event:` line is present. */
  event: string
  /** Joined `data:` lines (multi-line `data` fields are newline-joined). */
  data: string
  /** Round-tripped `id:` field when present. */
  id?: string
}

/**
 * Runtime shape shared by TOML-config upstreams and adapter-registered
 * `AiGatewayUpstreamPreset`s, both flow through this one structural type.
 */
export interface UpstreamConfig {
  name: string
  base_url: string
  path_prefix?: string
  provider?: string
  priority?: number
  match?: (input: AiGatewayRouteInput) => boolean
  /**
   * Paths the registering adapter claims, carried from its preset when
   * operator config overrode the entry by name. Proxy mode's record anchor
   * (LLP 0234); never a routing input.
   */
  record_prefix?: string
}

export interface AiGatewayConfig {
  /** Address as "host:port" (defaults to 127.0.0.1:18521, LLP 0114). */
  listen: string
  /** True when `listen` came from config rather than the default. A defaulted
   *  listen may fall back to an ephemeral bind on EADDRINUSE; a configured one
   *  never does (LLP 0114). */
  listenConfigured: boolean
  /** Value for the `gateway_id` column. */
  gatewayId: string
  upstreams: UpstreamConfig[]
  /** Extra headers to redact in stored rows. */
  redactHeaders: string[]
  /**
   * Serve `CONNECT` tunnels and TLS-terminate the hosts the routing table
   * names. Off unless explicitly enabled (LLP 0231).
   */
  proxyMode: boolean
  /** Corporate proxy to chain outbound connections through, when configured. */
  upstreamProxy?: UpstreamProxy
}

export interface CompiledUpstream {
  name: string
  provider?: string
  baseUrl: URL
  prefix: string | undefined
  /**
   * The paths the registering adapter claims, used as proxy mode's record
   * anchor. Distinct from `prefix`, which is the operator's routing question:
   * `path_prefix = "/"` means "route everything here", never "record
   * everything here" (LLP 0234).
   */
  recordPrefix?: string
  priority: number
  seq: number
  match: ((input: AiGatewayRouteInput) => boolean) | undefined
}

export interface ProxyOptions {
  listen: string
  upstreams: UpstreamConfig[]
  onExchangeFinished(exchange: Exchange): void | Promise<void>
  startExchange(init: {
    upstream: string
    provider: string | undefined
    method: string | undefined
    path: string | undefined
    requestHeaders: IncomingHttpHeaders
  }): Exchange
  /**
   * Handle a request under the reserved `/_hypaware/` control prefix. The
   * proxy short-circuits control requests BEFORE upstream matching (they
   * are never proxied and start no exchange) and delegates the full
   * request lifecycle, body read and response, to this callback. Absent,
   * the proxy 404s the control request locally.
   * @ref LLP 0066#control-path: the control prefix is reserved and answered
   * locally, so an opt-out can never be forwarded upstream as a real request.
   */
  onControlRequest?(req: IncomingMessage, res: ServerResponse, url: URL): void
  /**
   * Turns proxy mode on. Present only when the operator enabled it and a
   * machine-local CA is available; absent, the listener serves reverse-proxy
   * traffic only and a CONNECT is refused.
   *
   * @ref LLP 0233#one-listener-two-front-doors
   */
  interception?: {
    secureContextFor(host: string): import('node:tls').SecureContext
  }
  /**
   * Serve CONNECT as blind tunnels only, with no interception. Set when a
   * client may still have `HTTPS_PROXY` pointed here but TLS termination is
   * unavailable, so its egress keeps working unrecorded rather than failing
   * entirely (LLP 0233).
   */
  tunnelOnly?: boolean
  /** Corporate proxy to chain both tunnels and the intercepted leg through. */
  upstreamProxy?: UpstreamProxy
  /** Agent that routes the intercepted upstream leg through {@link upstreamProxy}. */
  chainedAgent?: import('node:https').Agent
  log?: {
    warn?(message: string, fields?: Record<string, unknown>): void
    info?(message: string, fields?: Record<string, unknown>): void
  }
}

export interface StartedProxy {
  host: string
  port: number
  stopped: Promise<void>
  stop(): Promise<void>
}

/** Registration-order tiebreaker: after sorting by descending `priority`, `_seq` breaks ties. */
export type RegisteredProjector = AiGatewayExchangeProjector & { _seq: number }

/**
 * Mutable state owned by the ai-gateway plugin instance. Both the
 * `AiGatewayCapability` facade (what adapter plugins see) and the running
 * source read from this object: the API mutates it via `register*` calls,
 * the source consumes it when compiling the upstream table and dispatching
 * projectors over a finalized exchange.
 */
export interface GatewayState {
  presets: Map<string, AiGatewayUpstreamPreset>
  clients: Map<string, AiGatewayClientRegistration>
  projectors: RegisteredProjector[]
  enrichers: Map<string, AiGatewaySettlementEnricher>
  listen: { host: string; port: number } | undefined
  /**
   * In-memory set of opaque session-id tokens the local control route has
   * been asked to ignore. Lives on `GatewayState` (created once per plugin
   * activation, NOT per listener) so a config `reload()`, which tears down
   * and relaunches the listener, does not silently re-enable recording
   * mid-session. No file, no cache column: dies with the daemon process.
   * @ref LLP 0066#ephemeral [implements]: the set is deliberately process-local,
   * which is the half of the caveat `EPHEMERAL_NOTE` has to keep telling users.
   */
  ignoredSessions: Set<string>
}

/**
 * Outcome of resolving which session a `hyp session <verb>` invocation is
 * about. Failure is an explicit variant, never a fallback id: an unresolved
 * session must fail closed rather than act on a guess.
 * `source` is carried through to the verb's output rather than discarded: an
 * `argument` or `claude_env` id is what the caller or client stated, but a
 * `codex_rollout` id was INFERRED from a file on disk, and the user must be
 * able to see which of the two an "ignored" answer rests on. `evidence` names
 * the rollout the inference came from.
 *
 * `sessionId` is always the **session container** the gateway drops on, never a
 * Codex thread id: the two coincide on a root thread and diverge on a subagent
 * one, so a thread id here would be an opt-out nothing matches. `threadId` is
 * carried separately, for provenance and display, where the container was read
 * out of a rollout (`codex_rollout`, `codex_env_rollout`) - the user needs to
 * see both the id they are in and the wider id being acted on.
 * @ref LLP 0067#cli-session-id: `source` is the provenance the reader prints, so
 * an inferred id can never be rendered as one the client stated.
 */
export type SessionIdResolution =
  | {
      ok: true
      sessionId: string
      source: 'argument' | 'claude_env' | 'codex_rollout' | 'codex_env_rollout'
      evidence?: string
      threadId?: string
    }
  | { ok: false; error: string }

/**
 * Outcome of resolving the local gateway's control endpoint for
 * `hyp session <verb>`: the daemon's proven bound port, else a pinned
 * `listen`, else an error. Never a guessed default port.
 * @ref LLP 0086#endpoint-discovery [constrained-by]: the live port is read from
 * `status.json`, so `daemon_status` is the only `source` anything proved bound.
 */
export type SessionEndpointResolution =
  | { ok: true; endpoint: string; source: 'daemon_status' | 'config_listen' }
  | { ok: false; error: string }

/**
 * One recorder's outcome for a `hyp session ignore` / `unignore` write. The
 * verb addresses every recorder hosting the control route (the gateway plus
 * whatever a live daemon snapshot advertises, LLP 0256 #cli-posts-to-both)
 * and reports each outcome; `ignored` / `total` are present exactly when
 * `ok` is true, `error` exactly when it is not.
 */
export interface SessionMutationOutcome {
  recorder: string
  endpoint: string
  endpointSource: 'daemon_status' | 'config_listen'
  ok: boolean
  ignored?: boolean
  total?: number
  error?: string
}

/**
 * What `hyp session status` reports, in `--json` field order. It carries the
 * PROVENANCE of both inputs alongside the answer (`session_id_source` /
 * `session_id_evidence`, `endpoint_source`) because an `ignored: true` rests on
 * two separate claims - "this is my session id" and "that endpoint is the
 * gateway" - and only some of the ways of establishing them are authoritative.
 * Hiding which one was used is how a confident answer about the wrong session
 * reads as a confident answer about yours.
 *
 * **The `--json` envelope is this record plus two fields the writer adds and
 * this interface deliberately does not carry**, because they are constants
 * rather than results: `folder_policy` (the other governor's verb) and
 * `endpoint_authenticated`, which is always `false`. The second is `false` **by
 * contract, not by outcome** - no answer this verb can obtain is authenticated,
 * on `unknown` reports included - so a peer-identity check, if one is ever
 * adopted, needs a NEW field rather than flipping this one: a consumer that
 * learned "false means nobody checked" must not have to relearn "false now
 * means the check ran and failed". Anything that adds a report shape here owes
 * it the same constant.
 *
 * @ref LLP 0066#readable [implements]: R10 and R12 shape this record - `ignored`
 * is nullable so an unconfirmable read cannot render as `false`.
 * @ref LLP 0166#stated-not-proved [constrained-by]: the `--json` envelope states
 * the responder was never authenticated, on every shape.
 */
export interface SessionStatusReport {
  status: 'ignored' | 'not_ignored' | 'unknown'
  session_id: string | null
  session_id_source: 'argument' | 'claude_env' | 'codex_rollout' | 'codex_env_rollout' | null
  session_id_evidence: string | null
  /**
   * The Codex thread the invocation is in, when one was resolved. Distinct from
   * `session_id` (the container the drop matches): equal for a root thread, and
   * different for a subagent one, which is precisely the case where reporting
   * only one of them hid a no-op opt-out.
   */
  thread_id: string | null
  ignored: boolean | null
  total: number | null
  endpoint: string | null
  endpoint_source: 'daemon_status' | 'config_listen' | null
  reason: string | null
}

export interface AiGatewayRuntime {
  ctx: PluginActivationContext
  state: GatewayState
  sources: ExtendedSourceRegistry
  started: boolean
}

/**
 * A corporate proxy to chain outbound connections through. Present only when
 * the operator configured `upstream_proxy`, and applied to both blind tunnels
 * and the intercepted upstream leg so proxy mode never silently cuts egress a
 * customer already depended on.
 */
export interface UpstreamProxy {
  host: string
  port: number
  /** Pre-encoded `Proxy-Authorization` header value, when the proxy needs one. */
  authorization?: string
}

/** Wiring for {@link attachConnectFrontDoor}. */
export interface ConnectFrontDoorOptions {
  /** The HTTP server terminated tunnels are handed back to. */
  server: import('node:http').Server
  /**
   * Whether to decrypt this tunnel. False means blind-pipe, which is the
   * default disposition for every host no upstream names.
   */
  shouldIntercept(host: string, port: number): boolean
  /** Leaf certificate for an intercepted host; throws for a host the CA cannot vouch for. */
  secureContextFor(host: string): import('node:tls').SecureContext
  upstreamProxy?: UpstreamProxy
  log?: { warn?(message: string, fields?: Record<string, unknown>): void }
}

export interface ConnectFrontDoor {
  /** Sockets this handler currently owns; used by tests and shutdown. */
  openCount(): number
  /** Detach the handler and destroy every socket it owns. */
  close(): void
}
