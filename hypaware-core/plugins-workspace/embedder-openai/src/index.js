// @ts-check

import { createOpenAiEmbedder } from './client.js'
import { validateEmbedderConfig } from './config.js'

/**
 * @import { HypError, PluginActivationContext, ValidationResult } from '../../../../collectivus-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/embedder-openai'
const CAPABILITY_VERSION = '1.0.0'

/**
 * Activate `@hypaware/embedder-openai`. Registers the
 * `hypaware.embedder@1` capability backed by an OpenAI-compatible
 * `POST /v1/embeddings` client.
 *
 * Activation itself performs no network IO and reads no credentials:
 * the API key resolves from the environment per request. Enabling this
 * plugin is the explicit opt-in that allows captured content (indexed
 * text and query strings) to leave the machine when `base_url` points
 * at a remote provider; a localhost `base_url` keeps the path fully
 * local.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0024#embedding-is-a-separate-capability [implements]: embedding is its own capability; choosing this provider is an explicit `plugins[]` config decision
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: 'embedder-openai',
    validate: (value) => toValidationResult(validateEmbedderConfig(value)),
  })

  const validated = validateEmbedderConfig(ctx.config)
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.pointer || '/'}: ${e.message}`).join('; ')
    const err = /** @type {HypError} */ (new Error(`${PLUGIN_NAME}: invalid config - ${detail}`))
    err.hypErrorKind = 'embedder_config_invalid'
    throw err
  }
  const config = validated.config

  const embedder = createOpenAiEmbedder({ config, env: ctx.env, log: ctx.log })
  ctx.provideCapability('hypaware.embedder', CAPABILITY_VERSION, embedder)

  // base_url, model, and the env var NAME are safe to log; the key
  // value never is.
  ctx.log.info('embedder.activated', {
    base_url: config.base_url,
    embed_model: config.model,
    api_key_env: config.api_key_env,
  })
}

/**
 * @param {ReturnType<typeof validateEmbedderConfig>} result
 * @returns {ValidationResult}
 */
function toValidationResult(result) {
  if (result.ok) return { ok: true }
  return { ok: false, errors: result.errors.map((e) => ({ pointer: e.pointer, message: e.message })) }
}
