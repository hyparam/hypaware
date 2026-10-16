import type { IncomingMessage, ServerResponse } from 'node:http'

/** The three OTLP signals the shared http/json listener routes. */
export type OtlpSignal = 'logs' | 'traces' | 'metrics'

/** One decoded OTLP/JSON request, handed to the hosting plugin. */
export interface OtlpRequest {
  signal: OtlpSignal
  data: unknown
  payloadBytes: number
}

/**
 * The hosting plugin's side of the seam. Payload interpretation lives
 * behind this handle, never in the shared server.
 */
export interface OtlpReceiveHandler {
  handle(req: OtlpRequest): Promise<void>
}

/** Options for `createOtlpJsonServer`. */
export interface OtlpJsonServerOptions {
  /** Listener name, used in the `GET /` banner and in bind errors. */
  name: string
  /** Invoked once per decoded request. */
  handler: OtlpReceiveHandler
  /** Signal paths to serve. Defaults to logs, traces and metrics. */
  signals?: readonly OtlpSignal[]
  /**
   * Serves the reserved `/_hypaware/` local control surface, short-circuited
   * before OTLP routing. The handler owns the request lifecycle (body and
   * response). Absent, control paths fall through as unknown OTLP routes.
   */
  onControlRequest?: (req: IncomingMessage, res: ServerResponse, url: URL) => void
}
