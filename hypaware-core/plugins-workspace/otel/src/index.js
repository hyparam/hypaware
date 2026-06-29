// @ts-check

import { otelDatasetRegistration, PLUGIN_NAME } from './datasets.js'
import { startOtelSource } from './source.js'

/**
 * @import { PluginActivationContext } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedSourceRegistry } from '../../../../src/core/registry/types.js'
 */

/**
 * Activate `@hypaware/otel`.
 *
 * Registers:
 *  - source `otlp` (configSection: `otel`), owns the HTTP listener
 *  - dataset `logs`, dataset `traces`, dataset `metrics`. Fronted
 *    by the kernel-managed Iceberg cache
 *
 * Activation auto-starts the source so the listener is ready as soon
 * as the kernel finishes booting; the smoke flow boots a temp install
 * with `listen_port: 0` and reads the bound port out of the
 * `source.start` span (or via `kernel.sources.status('otlp')`).
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0012#source-kinds [implements]: OTLP HTTP receiver registered as a source; owns logs/traces/metrics tables
 */
export async function activate(ctx) {
  ctx.sources.register({
    name: 'otlp',
    plugin: PLUGIN_NAME,
    summary: 'OTLP HTTP receiver (logs, traces, metrics)',
    configSection: 'otel',
    start: startOtelSource,
  })

  ctx.query.registerDataset(otelDatasetRegistration('logs'))
  ctx.query.registerDataset(otelDatasetRegistration('traces'))
  ctx.query.registerDataset(otelDatasetRegistration('metrics'))

  const sources = /** @type {ExtendedSourceRegistry} */ (ctx.sources)
  await sources.start('otlp', ctx)
}
