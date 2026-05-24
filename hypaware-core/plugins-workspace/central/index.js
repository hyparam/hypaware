// @ts-check

import path from 'node:path'

import { validateCentralConfig } from './src/config.js'
import { IdentityClient } from './src/identity_client.js'
import { createForwardSink } from './src/sink.js'

/**
 * @import { PluginActivationContext, SinkCreateContext } from '../../../collectivus-plugin-kernel-types'
 */

/**
 * `@hypaware/central` — request sink that forwards ready cache
 * partitions to a central HypAware server. The plugin replaces the
 * `role: gateway` config from collectivus: a host becomes "the
 * gateway" purely by configuring this sink under
 * `HypAwareV2Config.sinks.<name>` with `plugin: "@hypaware/central"`.
 *
 * Activate captures `ctx.query` / `ctx.storage` in closure so each sink
 * instance can read partitions during `exportBatch` (the
 * `SinkCreateContext` itself does not carry storage/query).
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  const query = ctx.query
  const storage = ctx.storage

  ctx.sinks.register({
    name: 'forward',
    plugin: '@hypaware/central',
    supports: [],
    /**
     * @param {SinkCreateContext} sinkCtx
     */
    async create(sinkCtx) {
      const validation = validateCentralConfig(sinkCtx.config)
      if (!validation.ok) {
        throw new Error(`@hypaware/central: ${validation.message}`)
      }
      const config = validation.config

      const persistedPath = config.identity.persisted_path
        ?? path.join(sinkCtx.paths.stateDir, 'identity.json')

      const identityClient = new IdentityClient({
        centralUrl: config.url,
        bootstrapToken: config.identity.bootstrap_token,
        persistedPath,
      })
      const source = await identityClient.acquire()
      sinkCtx.log.info('central.identity.acquired', {
        hyp_sink_instance: sinkCtx.name,
        hyp_identity_source: source,
      })

      return createForwardSink({
        config,
        identityClient,
        query,
        storage,
        log: sinkCtx.log,
      })
    },
  })
}
