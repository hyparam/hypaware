import type { IncomingHttpHeaders } from 'node:http'
import type {
  AiGatewayClientRegistration,
  AiGatewayExchangeProjector,
  AiGatewayRouteInput,
  AiGatewayUpstreamPreset,
  PluginActivationContext,
} from '../../../../collectivus-plugin-kernel-types.d.ts'
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
  /** Address as "host:port" (defaults to 127.0.0.1:0). */
  listen: string
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
  listen: { host: string; port: number } | undefined
}

export interface AiGatewayRuntime {
  ctx: PluginActivationContext
  state: GatewayState
  sources: ExtendedSourceRegistry
  started: boolean
}
