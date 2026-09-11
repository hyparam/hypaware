// @ts-check

import process from 'node:process'
import os from 'node:os'
import { installObservability } from '../observability/index.js'

/** @import { DaemonHandle, RunDaemonOptions } from '../../../src/core/daemon/types.js' */
/** @type {DaemonHandle | undefined} */
let handle
let starting = false
let stopping = false

// The transport lives in the plugin workspace, so it is reached by URL rather
// than by any static specifier; the reason is at the import site below.
const PROCESS_TRANSPORT_ENTRY = new URL('../../../hypaware-core/plugins-workspace/ai-gateway/src/process_transport.js', import.meta.url).href

/** @param {object} message */
function send(message) {
  if (process.connected) process.send?.(message, () => {})
}

// A lost supervisor must not leave an orphan cache writer behind.
process.on('disconnect', () => { process.exit(0) })

/** @param {RunDaemonOptions & { type?: string, endpoint?: { host: string, port: number } }} msg */
async function control(msg) {
  if (msg.type === 'processing.stop') {
    if (!handle) process.exit(0)
    try { await handle.stop() } catch (error) {
      process.stderr.write(`processing.stop_failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
    return
  }
  try {
    try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* unavailable on this host */ }
    // Imported here, not statically, so the declaration build's `rootDir: src`
    // never has to contain plugin-workspace code (../runtime/loader.js reaches
    // plugin entrypoints the same way). Inside the catch so a resolution
    // failure is reported like any other boot failure instead of escaping as
    // an unhandled rejection.
    const { createCaptureReceiver, setGatewayProcessTransport } = await import(PROCESS_TRANSPORT_ENTRY)
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
    const { runDaemon } = await import('./runtime.js')
    handle = await runDaemon({ ...msg, env: process.env })
    const code = await handle.done
    await installObservability().shutdown()
    process.exit(code)
  } catch (error) {
    process.stderr.write(`processing.boot_failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

// Capture frames have their own listener and outnumber control messages by
// orders of magnitude, so this one decides synchronously: recognising a frame
// as none of its business must not cost a promise per frame. The guards are
// still set before the async hop, so a repeat start cannot race through.
process.on('message', input => {
  const msg = /** @type {RunDaemonOptions & { type?: string, endpoint?: { host: string, port: number } }} */ (input)
  if (msg.type === 'processing.stop') {
    stopping = true
    void control(msg)
    return
  }
  if (msg.type !== 'processing.start' || starting || stopping) return
  starting = true
  void control(msg)
})
