// @ts-check

/**
 * @import { ObservabilityEnv } from '../../../src/core/observability/types.js'
 */

/**
 * Build the resource metadata that the tracer, logger, and meter providers
 * share. `service.name` comes from env; `dev_run_id` is mirrored onto
 * the resource so every signal carries it even when a caller forgets
 * to set it as a span attribute. Any `OTEL_RESOURCE_ATTRIBUTES` value
 * (a=b,c=d shape) is merged last so user-supplied keys win.
 *
 * @param {ObservabilityEnv} env
 * @returns {{ attributes: Record<string, string|number|boolean> }}
 */
export function buildResource(env) {
  /** @type {Record<string, string|number|boolean>} */
  const attrs = {
    'service.name': env.serviceName,
    'hypaware.self': true,
  }
  if (env.devRunId) attrs.dev_run_id = env.devRunId
  if (env.resourceAttributes) {
    for (const raw of env.resourceAttributes.split(',')) {
      const pair = raw.trim()
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const key = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (key) attrs[key] = value
    }
  }
  return { attributes: attrs }
}
