import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Collector } from '../../src/collector.js'
import { OutboxSink } from '../../src/gateway/outbox_sink.js'
import { Proxy } from '../../src/proxy.js'
import { Recorder } from '../../src/recorder.js'
import { createConfigRegistry, setConfig } from '../../src/server/config_registry.js'
import { ControlPlane } from '../../src/server/control_plane.js'
import { signJwt } from '../../src/server/identity.js'

/**
 * @import { Server, IncomingMessage, ServerResponse } from 'node:http'
 * @import { IngestSignal } from '../../src/server/types.d.ts'
 */

const SECRET = 'a'.repeat(32)

/** @type {string} */
let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-gateway-e2e-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @returns {object}
 */
function gatewayConfig() {
  return {
    version: 1,
    role: 'gateway',
    central_server: {
      url: 'https://central.example.com',
      identity: {},
    },
  }
}

/**
 * @param {string} gatewayId
 * @param {string} sinkDir
 * @returns {Promise<{ plane: ControlPlane, baseUrl: string }>}
 */
async function startCentral(gatewayId, sinkDir) {
  const registry = createConfigRegistry({ configsDir: path.join(tmpDir, 'configs') })
  setConfig(registry, gatewayId, gatewayConfig())
  const plane = new ControlPlane(
    {
      control_plane_listen: '127.0.0.1:0',
      identity_issuer: { secret: SECRET },
      sink_dir: sinkDir,
    },
    { configRegistry: registry }
  )
  await plane.start()
  const addr = plane.server?.address()
  if (!addr || typeof addr === 'string') throw new Error('central did not bind')
  return { plane, baseUrl: `http://127.0.0.1:${addr.port}` }
}

/**
 * @param {string} gatewayId
 * @returns {{ getCurrentJwt(): Promise<string>, refresh(): Promise<void> }}
 */
function identity(gatewayId) {
  return {
    getCurrentJwt() {
      return Promise.resolve(signJwt({ gatewayId, ttlSeconds: 3600, secret: SECRET }))
    },
    refresh() {
      return Promise.resolve()
    },
  }
}

/**
 * @param {string} centralUrl
 * @param {string} outboxDir
 * @param {string} gatewayId
 * @param {IngestSignal} signal
 * @returns {OutboxSink}
 */
function outboxSink(centralUrl, outboxDir, gatewayId, signal) {
  return new OutboxSink({
    outboxDir,
    centralUrl,
    identityClient: identity(gatewayId),
    signal,
    batch: { maxRows: 1, maxBytes: 1024 * 1024, maxSeconds: 60 },
    stderr: { write: () => {} },
  })
}

describe('gateway durable data path', () => {
  it('ships proxy recordings from gateway outbox into Central server ingest JSONL', async () => {
    const gatewayId = 'gw-proxy'
    const centralSink = path.join(tmpDir, 'central-ingested')
    const outboxDir = path.join(tmpDir, 'outbox')
    const { plane, baseUrl: centralUrl } = await startCentral(gatewayId, centralSink)
    /** @type {Server} */
    let upstream
    try {
      upstream = http.createServer((req, res) => {
        req.resume()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
      const upstreamAddr = upstream.address()
      if (!upstreamAddr || typeof upstreamAddr === 'string') throw new Error('upstream did not bind')

      const sink = outboxSink(centralUrl, outboxDir, gatewayId, 'proxy')
      const recorder = new Recorder({ sink })
      const proxy = new Proxy({
        listen: '127.0.0.1:0',
        upstreams: [
          {
            name: 'upstream',
            base_url: `http://127.0.0.1:${upstreamAddr.port}`,
            match: { path_prefix: '/v1/messages' },
          },
        ],
      }, { recorder })

      await proxy.start()
      try {
        const proxyAddr = proxy.server?.address()
        if (!proxyAddr || typeof proxyAddr === 'string') throw new Error('proxy did not bind')
        const res = await fetch(`http://127.0.0.1:${proxyAddr.port}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hello: 'central' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })

        await recorder.drain()
        await sink.whenIdle()

        const rows = readSignalRows(centralSink, gatewayId, 'proxy')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          kind: 'exchange',
          upstream: 'upstream',
          request: { method: 'POST', path: '/v1/messages' },
          response: { status: 200, body: JSON.stringify({ ok: true }) },
          _ingest: { gateway_id: gatewayId },
        })
      } finally {
        await proxy.stop()
        await recorder.drain()
        await sink.close()
      }
    } finally {
      if (upstream) await new Promise((resolve) => upstream.close(() => resolve(undefined)))
      await plane.stop()
    }
  })

  it('ships normalized OTLP logs, traces, and metrics into Central server ingest JSONL', async () => {
    const gatewayId = 'gw-otlp'
    const centralSink = path.join(tmpDir, 'central-ingested')
    const outboxDir = path.join(tmpDir, 'outbox')
    const { plane, baseUrl: centralUrl } = await startCentral(gatewayId, centralSink)
    const sinks = {
      logs: outboxSink(centralUrl, outboxDir, gatewayId, 'logs'),
      traces: outboxSink(centralUrl, outboxDir, gatewayId, 'traces'),
      metrics: outboxSink(centralUrl, outboxDir, gatewayId, 'metrics'),
    }
    const unusedOutputDir = path.join(tmpDir, 'unused-otel-data')
    const collector = new Collector({
      port: 0,
      host: '127.0.0.1',
      outputDir: unusedOutputDir,
      gatewayId,
      rowSinks: sinks,
    })
    try {
      await collector.start()
      expect(fs.existsSync(unusedOutputDir)).toBe(false)
      const addr = collector.server?.address()
      if (!addr || typeof addr === 'string') throw new Error('collector did not bind')
      const otlpUrl = `http://127.0.0.1:${addr.port}`

      const headers = { 'content-type': 'application/json' }
      expect((await fetch(`${otlpUrl}/v1/logs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(logPayload()),
      })).status).toBe(200)
      expect((await fetch(`${otlpUrl}/v1/traces`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tracePayload()),
      })).status).toBe(200)
      expect((await fetch(`${otlpUrl}/v1/metrics`, {
        method: 'POST',
        headers,
        body: JSON.stringify(metricPayload()),
      })).status).toBe(200)

      await Promise.all(Object.values(sinks).map((sink) => sink.whenIdle()))

      expect(readSignalRows(centralSink, gatewayId, 'logs')).toEqual([
        expect.objectContaining({
          serviceName: 'svc-logs',
          severityText: 'INFO',
          body: 'hello',
          _ingest: { gateway_id: gatewayId, received_at: expect.any(String) },
        }),
      ])
      expect(readSignalRows(centralSink, gatewayId, 'traces')).toEqual([
        expect.objectContaining({
          serviceName: 'svc-traces',
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanId: 'bbbbbbbbbbbbbbbb',
          name: 'live span',
          _ingest: { gateway_id: gatewayId, received_at: expect.any(String) },
        }),
      ])
      expect(readSignalRows(centralSink, gatewayId, 'metrics')).toEqual([
        expect.objectContaining({
          serviceName: 'svc-metrics',
          metricName: 'live.metric',
          metricType: 'gauge',
          value: 1.25,
          _ingest: { gateway_id: gatewayId, received_at: expect.any(String) },
        }),
      ])
    } finally {
      await collector.stop()
      await Promise.all(Object.values(sinks).map((sink) => sink.close()))
      await plane.stop()
    }
  })
})

/**
 * @param {string} root
 * @param {string} gatewayId
 * @param {string} signal
 * @returns {Record<string, unknown>[]}
 */
function readSignalRows(root, gatewayId, signal) {
  const dir = path.join(root, gatewayId, signal)
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.length > 0) rows.push(JSON.parse(line))
    }
  }
  return rows
}

function logPayload() {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-logs' } }] },
      scopeLogs: [{
        scope: { name: 'live.scope' },
        logRecords: [{
          timeUnixNano: '1776886719688000000',
          severityNumber: 9,
          severityText: 'INFO',
          body: { stringValue: 'hello' },
        }],
      }],
    }],
  }
}

function tracePayload() {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-traces' } }] },
      scopeSpans: [{
        scope: { name: 'live.scope' },
        spans: [{
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanId: 'bbbbbbbbbbbbbbbb',
          name: 'live span',
          startTimeUnixNano: '1776886719688000000',
          endTimeUnixNano: '1776886719689000000',
        }],
      }],
    }],
  }
}

function metricPayload() {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-metrics' } }] },
      scopeMetrics: [{
        scope: { name: 'live.scope' },
        metrics: [{
          name: 'live.metric',
          gauge: { dataPoints: [{ asDouble: 1.25, timeUnixNano: '1776886719689000000' }] },
        }],
      }],
    }],
  }
}
