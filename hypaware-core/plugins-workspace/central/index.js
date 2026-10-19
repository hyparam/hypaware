// @ts-check

import path from 'node:path'

import { createHeldDatasetStore } from '../../../src/core/sinks/held_datasets.js'
import { createInstanceWatermarkStore, instanceWatermarkStateDir } from '../../../src/core/sinks/incremental.js'

import { validateCentralConfig } from './src/config.js'
import { createConfigPullLoop } from './src/config_client.js'
import { IdentityClient } from './src/identity_client.js'
import { createDatasetRolloutStore } from './src/rollout.js'
import { createForwardSink, eligibleOpenDatasetNames, initializeOpenDatasetRollouts, openDatasetsWithoutPartitions } from './src/sink.js'

/**
 * @import { PluginActivationContext, SinkCreateContext } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `@hypaware/central`: request sink that forwards ready cache
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
  // Present only in daemon mode. Without an apply engine there is no
  // one to hand a pulled document to, so the pull loop stays off (CLI
  // boots must not fire config polls as a side effect of `hyp status`).
  const configControl = ctx.configControl

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

      // Per-(sink instance, partition) incremental-read watermarks. The plugin
      // `stateDir` is per-PLUGIN, so two `@hypaware/central` instances would
      // share, and clobber, one watermark file and skip each other's rows;
      // `createInstanceWatermarkStore` namespaces by the instance name, matching
      // local-fs/s3. Each forward instance then reads only rows added since its
      // own last successful export.
      // @ref LLP 0040#watermark-contract [implements]: one watermark per (sink instance, partition), scoped by instance name
      const watermarks = createInstanceWatermarkStore({ paths: sinkCtx.paths, instanceName: sinkCtx.name })
      const rollouts = createDatasetRolloutStore({ paths: sinkCtx.paths, instanceName: sinkCtx.name })

      // Establish open-dataset rollout state during sink creation. On an
      // upgraded machine this baselines partitions already on disk; on a cold
      // machine it durably records an empty dataset before the first captured
      // row can be mistaken for rollout history.
      // @ref LLP 0307#rollout-instant [implements]: initialize dataset rollout state before scheduled exports can observe a first partition
      await initializeOpenDatasetRollouts({ query, storage, watermarks, rollouts, log: sinkCtx.log })

      // Datasets this destination refused to register, kept on disk so
      // `hyp status` can say their rows stay local. An unreadable record is not
      // fatal: status keeps reporting it until every dataset with local rows
      // has registered or been held again, and only then is it rewritten.
      const instanceStateDir = instanceWatermarkStateDir(sinkCtx.paths.stateDir, sinkCtx.name)
      const held = createHeldDatasetStore({ stateDir: instanceStateDir, destination: config.url })
      try {
        const unreadable = await held.load(eligibleOpenDatasetNames(query))
        if (unreadable) {
          sinkCtx.log.warn('central.forward.held_state_unreadable', { hyp_sink_instance: sinkCtx.name, reason: unreadable })
          await held.resolve(await openDatasetsWithoutPartitions(query, storage))
        }
      } catch (err) {
        sinkCtx.log.warn('central.forward.held_state_unavailable', {
          hyp_sink_instance: sinkCtx.name,
          message: err instanceof Error ? err.message : String(err),
        })
      }

      const sink = createForwardSink({
        config,
        identityClient,
        query,
        storage,
        watermarks,
        rollouts,
        receiptsDir: path.join(instanceStateDir, 'receipts'),
        held,
        log: sinkCtx.log,
      })

      if (!configControl) return sink

      // @ref LLP 0025#config-pull-loop [implements]: pull immediately on bootstrap success, then on the steady timer
      const pullLoop = createConfigPullLoop({
        centralUrl: config.url,
        identityClient,
        configControl,
        ...(config.poll_interval_seconds !== undefined
          ? { pollIntervalSeconds: config.poll_interval_seconds }
          : {}),
        log: sinkCtx.log,
      })
      pullLoop.start()

      return {
        ...sink,
        async close() {
          const closing = sink.close()
          const results = await Promise.allSettled([closing, pullLoop.stop()])
          for (const result of results) if (result.status === 'rejected') throw result.reason
        },
      }
    },
  })
}
