export type OtlpSignal = 'logs' | 'traces' | 'metrics'

export interface OtlpRequest {
  signal: OtlpSignal
  data: unknown
  payloadBytes: number
}

export interface OtlpReceiveHandler {
  handle(req: OtlpRequest): Promise<void>
}
