// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

/** @import { AddressInfo } from 'node:net' */
import { dispatch } from '../../../src/core/cli/dispatch.js'
import {
  getLogger,
  installObservability
} from '../../../src/core/observability/index.js'
import {
  writePolicy,
  productRoot
} from '../../../src/core/product_telemetry/policy.js'
import { createOutbox } from '../../../src/core/product_telemetry/outbox.js'
import { createDelivery } from '../../../src/core/product_telemetry/delivery.js'
import { validateBatch } from '../../../src/core/product_telemetry/contract.js'

/** @param {{harness:any,expect:any}} args */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('product-telemetry-smoke')
  const root = productRoot(process.env)
  const journal = path.join(harness.tmpDir, 'receiver.jsonl')
  const received = new Set()
  let loseAck = true
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.end(
        JSON.stringify({
          schema_versions: [1],
          max_records: 100,
          max_batch_bytes: 32768,
          max_queue_age_seconds: 604800,
          dedup_seconds: 691200
        })
      )
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const batch = JSON.parse(raw)
    if (validateBatch(batch, Date.now())) {
      res.writeHead(422).end('{}')
      return
    }
    const duplicate = received.has(batch.batch_id)
    if (!duplicate) {
      const fd = fs.openSync(journal, 'a', 0o600)
      try {
        fs.writeFileSync(fd, raw + '\n')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      received.add(batch.batch_id)
    }
    if (loseAck) {
      loseAck = false
      req.socket.destroy()
      return
    }
    res.writeHead(202).end(JSON.stringify({ status: 202, duplicate }))
  })
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  )
  const address = /** @type {AddressInfo} */ (server.address())
  const url = `http://127.0.0.1:${address.port}`
  const identityPath = path.join(harness.tmpDir, 'gateway.json')
  fs.writeFileSync(
    identityPath,
    JSON.stringify({
      central_url: url,
      gateway_id: randomUUID(),
      jwt: `header.${Buffer.from(JSON.stringify({ org: 'fixture' })).toString('base64url')}.signature`,
      expires_at: Date.now() / 1000 + 86400
    })
  )
  writePolicy(root, 'organization', { url, identityPath })
  const signal = (smoke_step, status) =>
    log.info('product.smoke.step', {
      dev_run_id: harness.devRunId,
      smoke_name: harness.smokeName,
      smoke_step,
      status
    })
  try {
    signal('invoke', 'ok')
    let output = ''
    const code = await dispatch(['--version'], {
      env: process.env,
      stdout: {
        write: (value) => {
          output += value
        }
      }
    })
    expect.that(
      'CLI version succeeds',
      { code, output },
      (v) => v.code === 0 && v.output.startsWith('hypaware ')
    )
    const queue = createOutbox(root)
    expect.that(
      'one batch contains one invocation',
      queue.entries(),
      (entries) =>
        entries.length === 1 &&
        JSON.parse(entries[0].wire).records.filter(
          (r) => r.name === 'cli.invocation'
        ).length === 1
    )
    let now = Date.now()
    await createDelivery(root, { now: () => now, random: () => 0 }).drain()
    signal('lost_ack', 'ok')
    expect.that(
      'durable receiver wrote but sender retained the batch',
      queue.entries().length,
      (n) => n === 1
    )
    now += 10000
    await createDelivery(root, { now: () => now }).drain()
    signal('replay', 'ok')
    expect.that(
      'replay acknowledged without duplicate records',
      {
        pending: queue.entries().length,
        lines: fs.readFileSync(journal, 'utf8').trim().split('\n').length
      },
      (v) => v.pending === 0 && v.lines === 1
    )
    expect.that(
      'test traffic is identified without run-id leakage',
      JSON.parse(fs.readFileSync(journal, 'utf8').trim()),
      (b) =>
        b.resource['deployment.environment'] === 'test' &&
        !JSON.stringify(b).includes(harness.devRunId)
    )
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that(
      'run-specific step signals prove the exercised path',
      logs.filter((row) => row.body === 'product.smoke.step'),
      (rows) =>
        rows.length === 3 &&
        rows.every(
          (row) =>
            row.attributes.dev_run_id === harness.devRunId &&
            row.attributes.smoke_name === harness.smokeName
        )
    )
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await obs.shutdown()
  }
}
