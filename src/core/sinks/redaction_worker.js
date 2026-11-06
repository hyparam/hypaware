// @ts-check
import { parentPort, workerData } from 'node:worker_threads'
import { createRowRedactor } from './redaction.js'

const redact = createRowRedactor(workerData, true)
parentPort?.on('message', row => {
  try {
    const result = redact(row)
    const changes = Object.entries(result).filter(([key, value]) => value !== row[key])
    parentPort?.postMessage({ ok: true, changes })
  }
  catch { parentPort?.postMessage({ ok: false }) }
})
