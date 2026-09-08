// @ts-check

import process from 'node:process'
import os from 'node:os'
import { installObservability } from '../observability/index.js'
import { createCaptureReceiver, setGatewayProcessTransport } from '../../../hypaware-core/plugins-workspace/ai-gateway/src/process_transport.js'

/** @import { DaemonHandle, RunDaemonOptions } from '../../../src/core/daemon/types.js' */
/** @type {DaemonHandle | undefined} */
let handle
let starting = false
let stopping = false

/** @param {object} message */
function send(message) {
  if (process.connected) process.send?.(message, () => {})
}

// A lost supervisor must not leave an orphan cache writer behind.
process.on('disconnect', () => { process.exit(0) })
process.on('message', async input => {
  const msg = /** @type {RunDaemonOptions & { type?: string, endpoint?: { host: string, port: number } }} */ (input)
  if (msg.type === 'processing.stop') {
    stopping = true
    if (handle) await handle.stop()
    else process.exit(0)
    return
  }
  if (msg.type !== 'processing.start' || starting || stopping) return
  starting = true
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* unavailable on this host */ }
  setGatewayProcessTransport({
    role: 'processing',
    endpoint: msg.endpoint,
    receive(onExchange) {
      const receiver = createCaptureReceiver({ onExchange, send })
      process.on('message', receiver.message)
      send({ type: 'gateway.capture_ready' })
      return async () => {
        process.off('message', receiver.message)
        send({ type: 'gateway.capture_paused' })
        await receiver.close()
      }
    },
  })
  try {
    const { runDaemon } = await import('./runtime.js')
    handle = await runDaemon({ ...msg, env: process.env })
    const code = await handle.done
    await installObservability().shutdown()
    process.exit(code)
  } catch (error) {
    process.stderr.write(`processing.boot_failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
})
