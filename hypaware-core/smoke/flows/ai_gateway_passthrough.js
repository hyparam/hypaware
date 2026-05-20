// @ts-check

import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { requireAiGatewayRuntime } from '../../plugins-workspace/ai-gateway/src/runtime.js'

/**
 * Phase 8.2 smoke. Brings up an in-process echo upstream, activates
 * `@hypaware/ai-gateway` in a temp HYP_HOME pointed at it, starts the
 * source, issues one request through the gateway with the
 * `x-hyp-dev-run-id` contract header, and asserts the §Phase 8.2
 * contract from the implementation plan:
 *
 * - The echo upstream saw the request (header round-tripped, body
 *   echoed in the response).
 * - A row landed in `ai_gateway_messages` with `dev_run_id` in
 *   `metadata` matching the run.
 * - An `aigw.exchange` log row exists carrying `upstream`, `path`,
 *   `status_code`, `request_bytes`, `response_bytes`, `is_sse`.
 * - The `cache.append` span and `hyp_rows_written` counter both fire
 *   for `hyp_dataset=ai_gateway_messages`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'ai_gateway_passthrough: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const echo = await startEchoUpstream()

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginDir = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'plugins-workspace',
    'ai-gateway'
  )

  // Config slice handed to the plugin's activate(). Listen on
  // 127.0.0.1:0 so the test grabs an ephemeral port; route every path
  // ('/') to the echo upstream.
  const aiGatewayConfig = {
    listen: '127.0.0.1:0',
    upstreams: [
      {
        name: 'echo',
        base_url: echo.url,
        path_prefix: '/',
      },
    ],
  }

  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'ai_gateway_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([pluginDir])
      const entries = loaded.map((l) => ({
        manifest: l.manifest,
        rootDir: l.rootDir,
        config: aiGatewayConfig,
      }))
      return activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
      })
    }
  )

  // Start the source. The kernel wraps this in a `source.start` span,
  // so the assertion at the end can read it off the JSONL exporter.
  const runtime = requireAiGatewayRuntime()
  await kernel.sources.start('ai-gateway', runtime.ctx)
  runtime.started = true

  // Read the bound endpoint off the capability facade — exactly the
  // path an adapter plugin would use to discover the gateway.
  const registered = kernel.capabilities.list().find((c) => c.name === 'hypaware.ai-gateway')
  expect.that(
    'capability: hypaware.ai-gateway registered at 1.0.0',
    registered,
    (v) => v !== undefined && v.version === '1.0.0'
  )
  /** @type {import('../../../collectivus-plugin-kernel-types').AiGatewayCapability} */
  const aiGatewayApi = kernel.capabilities.require(
    '@smoke/ai-gateway-passthrough',
    'hypaware.ai-gateway',
    '^1.0.0'
  )
  const localUrl = aiGatewayApi.localEndpoint()
  expect.that(
    'capability: localEndpoint resolves to a loopback URL',
    localUrl,
    (v) => typeof v === 'string' && /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(v)
  )

  // Drive one request through the gateway with the contract header.
  const requestBody = JSON.stringify({ hello: 'gateway', run: harness.devRunId })
  const requestPath = '/v1/echo'
  const proxiedResponse = await postThroughGateway({
    url: `${localUrl}${requestPath}`,
    headers: {
      'content-type': 'application/json',
      'x-hyp-dev-run-id': harness.devRunId,
    },
    body: requestBody,
  })

  expect.that(
    'gateway: response status 200 from echo upstream',
    proxiedResponse.statusCode,
    (v) => v === 200
  )
  const echoed = JSON.parse(proxiedResponse.body)
  expect.that(
    'echo: upstream saw the request body bytes verbatim',
    echoed.bodyBytes,
    (v) => v === requestBody.length
  )
  expect.that(
    'echo: upstream saw the contract header',
    echoed.headers['x-hyp-dev-run-id'],
    (v) => v === harness.devRunId
  )
  expect.that(
    'echo: upstream saw the original request path',
    echoed.url,
    (v) => v === requestPath
  )

  // Stop the source so the listener closes and the recorder finishes
  // any in-flight exchange. The kernel emits a `source.stop` span here.
  await kernel.sources.stop('ai-gateway')

  // Query the dataset through the dispatcher — same shape the bead's
  // SQL assertion exercises: filter by JSON_VALUE on dev_run_id.
  const sqlStdout = makeBuf()
  const sqlStderr = makeBuf()
  const sqlCode = await dispatch(
    [
      'query',
      'sql',
      `select count(*) as n from ai_gateway_messages where JSON_VALUE(metadata, '$.dev_run_id') = '${harness.devRunId}'`,
      '--refresh',
      'never',
      '--format',
      'json',
    ],
    { stdout: sqlStdout, stderr: sqlStderr, kernel, registry, env: smokeEnv(harness) }
  )
  expect.that('dispatch: query sql exited 0', sqlCode, (v) => v === 0)
  expect.that(
    'stderr: query sql had no errors',
    sqlStderr.text(),
    (v) => typeof v === 'string' && v.length === 0
  )

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(sqlStdout.text())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    expect.that(
      `stdout: query sql --format json was valid JSON (parse error: ${message})`,
      false,
      (v) => v === true
    )
    return
  }
  expect.that(
    'stdout: select count returned 1 row',
    parsed,
    (v) => Array.isArray(v) && v.length === 1
  )
  const count = parsed?.[0]?.n
  expect.that(
    'stdout: count is 1 (exactly one exchange for the dev_run_id)',
    count,
    (v) => v === 1 || v === '1' || (typeof v === 'bigint' && Number(v) === 1)
  )

  await obs.shutdown()
  await echo.close()

  // Telemetry assertions.
  const traces = await expect.traces()
  const logs = await expect.logs()
  const metrics = await expect.metrics()

  const startSpans = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'source.start' && t.attributes?.[Attr.PLUGIN] === '@hypaware/ai-gateway'
  )
  expect.that(
    'traces: source.start emitted for @hypaware/ai-gateway',
    startSpans,
    (rows) => rows.length === 1
  )

  const cacheAppends = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages'
  )
  expect.that(
    'traces: at least one cache.append for ai_gateway_messages',
    cacheAppends,
    (rows) => rows.length >= 1
  )

  const exchangeLogs = logs.filter(
    (/** @type {any} */ l) =>
      l.body === 'aigw.exchange' &&
      l.attributes?.[Attr.PLUGIN] === '@hypaware/ai-gateway' &&
      l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId
  )
  expect.that(
    'logs: aigw.exchange row exists tagged with this dev_run_id',
    exchangeLogs,
    (rows) => rows.length === 1
  )
  const exchangeLog = exchangeLogs[0]
  expect.that(
    'logs: aigw.exchange carries upstream=echo',
    exchangeLog?.attributes?.upstream,
    (v) => v === 'echo'
  )
  expect.that(
    'logs: aigw.exchange carries path matching the proxied request',
    exchangeLog?.attributes?.path,
    (v) => v === requestPath
  )
  expect.that(
    'logs: aigw.exchange carries status_code=200',
    exchangeLog?.attributes?.status_code,
    (v) => v === 200
  )
  expect.that(
    'logs: aigw.exchange carries request_bytes matching the posted body',
    exchangeLog?.attributes?.request_bytes,
    (v) => v === requestBody.length
  )
  expect.that(
    'logs: aigw.exchange carries response_bytes > 0',
    exchangeLog?.attributes?.response_bytes,
    (v) => typeof v === 'number' && v > 0
  )
  expect.that(
    'logs: aigw.exchange is_sse=false for a JSON echo',
    exchangeLog?.attributes?.is_sse,
    (v) => v === false
  )

  const rowsWritten = metrics.find(
    (/** @type {any} */ m) =>
      m.name === 'hyp_rows_written' &&
      m.attributes?.hyp_dataset === 'ai_gateway_messages' &&
      m.attributes?.hyp_plugin === '@hypaware/ai-gateway'
  )
  expect.that(
    'metrics: hyp_rows_written{dataset=ai_gateway_messages, plugin=@hypaware/ai-gateway} emitted',
    rowsWritten,
    (v) => v !== undefined
  )
  expect.that(
    'metrics: hyp_rows_written value is 1',
    rowsWritten?.value,
    (v) => v === 1
  )

  const exchangeBytes = metrics.find(
    (/** @type {any} */ m) =>
      m.name === 'aigw.exchange_bytes' &&
      m.attributes?.hyp_upstream === 'echo'
  )
  expect.that(
    'metrics: aigw.exchange_bytes emitted for upstream=echo',
    exchangeBytes,
    (v) => v !== undefined
  )
  expect.that(
    'metrics: aigw.exchange_bytes value >= request_bytes',
    exchangeBytes?.value,
    (v) => typeof v === 'number' && v >= requestBody.length
  )
}

/**
 * Spawn a tiny HTTP echo server that the proxy forwards to. Returns
 * `{ url, close }`. The server echoes the request's URL, headers (only
 * a few normalized) and request byte count back as JSON.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startEchoUpstream() {
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      /** @type {Record<string, string>} */
      const headers = {}
      for (const key of Object.keys(req.headers)) {
        const value = req.headers[key]
        if (typeof value === 'string') headers[key] = value
        else if (Array.isArray(value) && typeof value[0] === 'string') headers[key] = value[0]
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          url: req.url ?? '',
          method: req.method ?? '',
          headers,
          bodyBytes: body.byteLength,
        })
      )
    })
    req.on('error', () => res.end())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve(undefined))
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address !== 'object') {
    throw new Error('echo: failed to read bound address')
  }
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve(undefined)))
      )
    },
  }
}

/**
 * Issue one POST through the gateway. Uses node:http directly so the
 * smoke does not depend on global fetch availability across Node
 * versions hypaware targets (>=20).
 *
 * @param {{ url: string, headers: Record<string, string>, body: string }} req
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postThroughGateway(req) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(req.url)
    const request = http.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: Number.parseInt(parsed.port, 10),
        path: parsed.pathname + parsed.search,
        headers: {
          ...req.headers,
          'content-length': String(Buffer.byteLength(req.body)),
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        )
        res.on('error', reject)
      }
    )
    request.on('error', reject)
    request.write(req.body)
    request.end()
  })
}

/**
 * @param {{ hypHome: string }} harness
 */
function smokeEnv(harness) {
  return { ...process.env, HYP_HOME: harness.hypHome }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
