// @ts-check

import { createAnthropicCompletion } from './client.js'
import { validateAnthropicCompletionConfig } from './config.js'

/**
 * @import { HypError, PluginActivationContext, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/completion-anthropic'
const CAPABILITY_VERSION = '1.0.0'

/**
 * Activate `@hypaware/completion-anthropic`. Registers the
 * `hypaware.completion@1` capability backed by the Anthropic Messages API
 * (`POST /v1/messages`).
 *
 * Activation performs no network IO and reads no credentials: the API key
 * resolves from the environment per request. Enabling this plugin is the
 * explicit opt-in that allows captured content (prompts built from the
 * graph and source) to leave the machine; a localhost `base_url` (a
 * compatible proxy) keeps the path local.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: 'completion-anthropic',
    validate: (value) => toValidationResult(validateAnthropicCompletionConfig(value)),
  })

  const validated = validateAnthropicCompletionConfig(ctx.config)
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.pointer || '/'}: ${e.message}`).join('; ')
    const err = /** @type {HypError} */ (new Error(`${PLUGIN_NAME}: invalid config - ${detail}`))
    err.hypErrorKind = 'completion_config_invalid'
    throw err
  }
  const config = validated.config

  const completion = createAnthropicCompletion({ config, env: ctx.env, log: ctx.log })
  ctx.provideCapability('hypaware.completion', CAPABILITY_VERSION, completion)

  // base_url, default model, and the env var NAME are safe to log; the key
  // value never is.
  ctx.log.info('completion.activated', {
    provider: 'anthropic',
    base_url: config.base_url,
    completion_model: config.model,
    api_key_env: config.api_key_env,
  })
}

/**
 * @param {ReturnType<typeof validateAnthropicCompletionConfig>} result
 * @returns {ValidationResult}
 */
function toValidationResult(result) {
  if (result.ok) return { ok: true }
  return { ok: false, errors: result.errors.map((e) => ({ pointer: e.pointer, message: e.message })) }
}
