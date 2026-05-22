// @ts-check

import { createTableFormatProvider } from './table-format.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */

const PLUGIN_NAME = '@hypaware/format-iceberg'
const PLUGIN_VERSION = '1.0.0'

/**
 * Activate `@hypaware/format-iceberg`. Provides
 * `hypaware.table-format@1.0.0` as a `TableFormatProvider` whose
 * `createSink` builds an Iceberg writer over the destination's
 * `BlobStore` and the inner `SinkEncoder` resolved by the kernel.
 *
 * The plugin contributes no `sinks[]` entry — table-format writers
 * bypass the destination's sink contribution and become the sink
 * themselves (see `src/core/registry/sinks.js`
 * §`instantiateTableFormat`). The destination must still provide
 * `hypaware.blob-store` so the table-format sink can write bytes.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  const provider = createTableFormatProvider()
  ctx.provideCapability('hypaware.table-format', PLUGIN_VERSION, provider)
  ctx.log.info('iceberg.activate', {
    hyp_plugin: PLUGIN_NAME,
    hyp_plugin_version: PLUGIN_VERSION,
    hyp_table_format: provider.format,
    supports: provider.supports.join(','),
  })
}
