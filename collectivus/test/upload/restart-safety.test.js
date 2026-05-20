import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryConnector } from '../../src/upload/connectors/memory.js'
import { uploadPending } from '../../src/upload/uploader.js'

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-restart-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

const yesterday = '2026-05-06'
const today = '2026-05-07'
const baseOptions = /** @type {const} */ ({
  bucket: 'b',
  prefix: 'collectivus',
  time: '00:10',
  signals: /** @type {ReadonlyArray<'logs' | 'traces' | 'metrics'>} */ (['logs', 'traces', 'metrics']),
  catchupDays: 7,
  region: 'us-east-1',
})

/**
 * Seed one row under the unified `<outputDir>/<gateway_id>/<signal>/<date>.jsonl`
 * layout that both standalone and server modes drain.
 *
 * @param {string} gatewayId
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {string} date
 * @returns {void}
 */
function seed(gatewayId, signal, date) {
  const dir = path.join(outputDir, gatewayId, signal)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${date}.jsonl`),
    JSON.stringify({ serviceName: gatewayId, body: 'x', resource: {}, scope: { attributes: {} }, attributes: {} }) + '\n'
  )
}

describe('restart safety', () => {
  it('ledger blocks a second run', async () => {
    seed('svc', 'logs', yesterday)
    const connector = memoryConnector()

    const first = await uploadPending(baseOptions, connector, outputDir, today)
    expect(first[0].uploaded).toBe(true)
    const firstSize = connector.store.size

    const second = await uploadPending(baseOptions, connector, outputDir, today)
    expect(second[0].uploaded).toBe(false)
    expect(connector.store.size).toBe(firstSize)
  })

  it('HEAD-based fallback blocks if the ledger is lost', async () => {
    seed('svc', 'logs', yesterday)
    const connector = memoryConnector()

    await uploadPending(baseOptions, connector, outputDir, today)
    fs.unlinkSync(path.join(outputDir, '.upload-ledger.jsonl'))

    const second = await uploadPending(baseOptions, connector, outputDir, today)
    expect(second[0].uploaded).toBe(false)

    // Ledger should be reconstructed from the HEAD probe.
    const ledger = fs.readFileSync(path.join(outputDir, '.upload-ledger.jsonl'), 'utf8')
    expect(ledger.trim().split('\n')).toHaveLength(1)
  })
})
