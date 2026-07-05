/**
 * Plugin-local types for `@hypaware/completion-openai`. The capability
 * surface (`CompletionCapability` and friends) lives in the kernel types
 * file; these shapes cover config validation and client construction.
 */

import type { PluginLogger } from '../../../../hypaware-plugin-kernel-types.d.ts'

export interface OpenAiCompletionConfig {
  /** Origin (or origin + `/v1`) of an OpenAI-compatible chat-completions API. */
  base_url: string
  /** Model identifier used when a request omits `model`. */
  model: string
  /** Name of the environment variable holding the API key. */
  api_key_env: string
  /** Default output ceiling when a request omits `max_tokens`. */
  max_tokens: number
  /** Per-request timeout in milliseconds. */
  timeout_ms: number
}

export interface CompletionConfigError {
  pointer: string
  message: string
  errorKind: 'completion_config_invalid'
}

export type CompletionConfigResult =
  | { ok: true, config: OpenAiCompletionConfig }
  | { ok: false, errors: CompletionConfigError[] }

/**
 * Minimal fetch shape the client depends on. `body` is the streaming
 * branch's input (an async iterable of chunks); it is only read by
 * `stream()`. Tests inject a fake; the real client passes `globalThis.fetch`.
 */
export type FetchLike = (url: string, init: {
  method: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
}) => Promise<{
  ok: boolean,
  status: number,
  json(): Promise<unknown>,
  text(): Promise<string>,
  body?: AsyncIterable<Uint8Array | string> | null,
}>

export interface CreateOpenAiCompletionOptions {
  config: OpenAiCompletionConfig
  env: NodeJS.ProcessEnv
  log: PluginLogger
  /** Injection seam for tests; defaults to global fetch. */
  fetchImpl?: FetchLike
}
