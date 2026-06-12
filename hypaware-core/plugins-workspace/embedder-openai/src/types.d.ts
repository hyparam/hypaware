/**
 * Plugin-local types for `@hypaware/embedder-openai`. The capability
 * surface (`EmbedderCapability` and friends) lives in the kernel types
 * file; these shapes cover config validation and client construction.
 */

import type { EmbedderCapability, PluginLogger } from '../../../../collectivus-plugin-kernel-types.d.ts'

export interface EmbedderOpenAiConfig {
  /** Origin (or origin + `/v1`) of an OpenAI-compatible embeddings API. */
  base_url: string
  /** Model identifier sent with every request. */
  model: string
  /** Name of the environment variable holding the API key. */
  api_key_env: string
  /** Optional fixed output dimension (v3 models support shortening). */
  dimensions?: number
  /** Max texts per HTTP request; larger batches are chunked. */
  max_batch: number
  /** Per-request timeout in milliseconds. */
  timeout_ms: number
}

export interface EmbedderConfigError {
  pointer: string
  message: string
  errorKind: 'embedder_config_invalid'
}

export type EmbedderConfigResult =
  | { ok: true, config: EmbedderOpenAiConfig }
  | { ok: false, errors: EmbedderConfigError[] }

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
}>

export interface CreateEmbedderOptions {
  config: EmbedderOpenAiConfig
  env: NodeJS.ProcessEnv
  log: PluginLogger
  /** Injection seam for tests; defaults to global fetch. */
  fetchImpl?: FetchLike
}

export type CreateEmbedder = (opts: CreateEmbedderOptions) => EmbedderCapability
