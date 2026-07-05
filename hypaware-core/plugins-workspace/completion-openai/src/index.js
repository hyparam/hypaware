// @ts-check

import { createOpenAiCompletion } from './client.js'
import { validateOpenAiCompletionConfig } from './config.js'

/**
 * @import { HypError, PluginActivationContext, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/completion-openai'
const CAPABILITY_VERSION = '1.0.0'

/**
 * Activate `@hypaware/completion-openai`. Registers the
 * `hypaware.completion@1` capability backed by an OpenAI-compatible
 * `POST /v1/chat/completions` client.
 *
 * Activation performs no network IO and reads no credentials: the API key
 * resolves from the environment per request. Enabling this plugin is the
 * explicit opt-in that allows captured content to leave the machine when
 * `base_url` points at a remote provider; a localhost `base_url` (Ollama,
 * LM Studio) keeps the path fully local.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: 'completion-openai',
    validate: (value) => toValidationResult(validateOpenAiCompletionConfig(value)),
  })

  const validated = validateOpenAiCompletionConfig(ctx.config)
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.pointer || '/'}: ${e.message}`).join('; ')
    const err = /** @type {HypError} */ (new Error(`${PLUGIN_NAME}: invalid config - ${detail}`))
    err.hypErrorKind = 'completion_config_invalid'
    throw err
  }
  const config = validated.config

  const completion = createOpenAiCompletion({ config, env: ctx.env, log: ctx.log })
  ctx.provideCapability('hypaware.completion', CAPABILITY_VERSION, completion)

  // base_url, default model, and the env var NAME are safe to log; the key
  // value never is.
  ctx.log.info('completion.activated', {
    provider: 'openai-compatible',
    base_url: config.base_url,
    completion_model: config.model,
    api_key_env: config.api_key_env,
  })
}

/**
 * @param {ReturnType<typeof validateOpenAiCompletionConfig>} result
 * @returns {ValidationResult}
 */
function toValidationResult(result) {
  if (result.ok) return { ok: true }
  return { ok: false, errors: result.errors.map((e) => ({ pointer: e.pointer, message: e.message })) }
}
