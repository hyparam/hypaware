// @ts-check

import { createOtlpServer, listenAndResolve } from './server.js'
import { makeReceiveHandler, stampBoundAddress } from './collector.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').SourceStatus} SourceStatus */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').StartedSource} StartedSource */

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4318

/**
 * `startOtelSource` is the `SourceContribution.start` callback. It owns
 * the lifecycle of one HTTP listener: binds it, stamps `listen_host` /
 * `listen_port` on the surrounding `source.start` span, and returns a
 * `StartedSource` whose `status()` echoes the bound address and the
 * running row tally.
 *
 * Config (read from `ctx.config`):
 *   - `listen_host` (string, default `127.0.0.1`)
 *   - `listen_port` (number, default `4318`; `0` requests a dynamic port)
 *
 * @param {PluginActivationContext} ctx
 * @returns {Promise<StartedSource>}
 */
export async function startOtelSource(ctx) {
  const { host, port } = readListenConfig(ctx)
  /** @type {{ rowsWritten: number, lastError: string | undefined }} */
  const state = { rowsWritten: 0, lastError: undefined }
  const handler = makeReceiveHandler(ctx, state, ctx.log)
  const server = createOtlpServer({ handle: handler })
  const bound = await listenAndResolve(server, host, port)
  stampBoundAddress(bound.host, bound.port)
  ctx.log.info('otel.listener_started', {
    listen_host: bound.host,
    listen_port: bound.port,
  })

  return {
    async status() {
      /** @type {SourceStatus} */
      const status = {
        state: 'ready',
        rowsWritten: state.rowsWritten,
        details: { listen_host: bound.host, listen_port: bound.port },
      }
      if (state.lastError) status.lastError = state.lastError
      return status
    },

    async stop() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve(undefined)))
        server.closeIdleConnections?.()
        server.closeAllConnections?.()
      })
    },
  }
}

/**
 * Read `listen_host` / `listen_port` out of the activation config slice.
 * Falls back to defaults when the keys are missing or wrongly typed —
 * mistyped values log a warning so the operator notices on first boot.
 *
 * @param {PluginActivationContext} ctx
 */
function readListenConfig(ctx) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const hostRaw = config.listen_host
  const portRaw = config.listen_port

  /** @type {string} */
  let host = DEFAULT_HOST
  if (typeof hostRaw === 'string' && hostRaw.length > 0) host = hostRaw
  else if (hostRaw !== undefined) {
    ctx.log.warn('otel.config_invalid', { key: 'listen_host', value_type: typeof hostRaw })
  }

  /** @type {number} */
  let port = DEFAULT_PORT
  if (typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw >= 0 && portRaw <= 65535) {
    port = portRaw
  } else if (portRaw !== undefined) {
    ctx.log.warn('otel.config_invalid', { key: 'listen_port', value_type: typeof portRaw })
  }

  return { host, port }
}
