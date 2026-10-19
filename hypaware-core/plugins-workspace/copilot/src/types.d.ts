import type { AiGatewayProjectedExchange, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'

export interface CopilotStore { file: string, root: string, harness: string, profile: string }
export interface CopilotSpan {
  rowid: number
  span_id: string
  trace_id: string
  parent_span_id?: string
  conversation_id?: string
  chat_session_id?: string
  name: string
  operation_name?: string
  provider_name?: string
  response_model?: string
  request_model?: string
  tool_name?: string
  tool_call_id?: string
  start_time_ms: number
  end_time_ms: number
  status_code: number
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  reasoning_tokens?: number
}
export interface CopilotOptions {
  env?: NodeJS.ProcessEnv
  config?: JsonObject
  ignoredSessions?: Set<string>
  localOnlyListPath?: string
}
export interface CopilotHealth { stores: number, selected: number, read: number, unchanged: number, dropped: number, incomplete: number, last_scan?: string }
export interface CopilotProjection { exchange: AiGatewayProjectedExchange, incomplete: boolean }
