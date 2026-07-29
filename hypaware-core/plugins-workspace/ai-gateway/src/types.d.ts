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
 * `AiGatewayUpstreamPreset`s — both flow through this one structural type.
 */
export interface UpstreamConfig {
  name: string
  base_url: string
  path_prefix?: string
  provider?: string
  priority?: number
  match?: (input: AiGatewayRouteInput) => boolean
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
}

export interface CompiledUpstream {
  name: string
  provider?: string
  baseUrl: URL
  prefix: string | undefined
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
   * request lifecycle — body read and response — to this callback. Absent,
   * the proxy 404s the control request locally.
   * @ref LLP 0066#control-path: the control prefix is reserved and answered
   * locally, so an opt-out can never be forwarded upstream as a real request.
   */
  onControlRequest?(req: IncomingMessage, res: ServerResponse, url: URL): void
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
 * source read from this object — the API mutates it via `register*` calls,
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
   * activation, NOT per listener) so a config `reload()` — which tears down
   * and relaunches the listener — does not silently re-enable recording
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
 * @ref LLP 0067#cli-session-id: `source` is the provenance the reader prints, so
 * an inferred id can never be rendered as one the client stated.
 */
export type SessionIdResolution =
  | {
      ok: true
      sessionId: string
      source: 'argument' | 'claude_env' | 'codex_rollout'
      evidence?: string
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
 * What `hyp session status` reports, in `--json` field order. It carries the
 * PROVENANCE of both inputs alongside the answer (`session_id_source` /
 * `session_id_evidence`, `endpoint_source`) because an `ignored: true` rests on
 * two separate claims - "this is my session id" and "that endpoint is the
 * gateway" - and only some of the ways of establishing them are authoritative.
 * Hiding which one was used is how a confident answer about the wrong session
 * reads as a confident answer about yours.
 * @ref LLP 0066#readable [implements]: R10 and R12 shape this record - `ignored`
 * is nullable so an unconfirmable read cannot render as `false`.
 */
export interface SessionStatusReport {
  status: 'ignored' | 'not_ignored' | 'unknown'
  session_id: string | null
  session_id_source: 'argument' | 'claude_env' | 'codex_rollout' | null
  session_id_evidence: string | null
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
