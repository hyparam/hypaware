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
 * Gateway core 2.0 pass-through smoke. Brings up an in-process echo
 * upstream, activates `@hypaware/ai-gateway@2.0.0` in a temp HYP_HOME
 * pointed at it (with NO exchange projector registered), drives one
 * request through the gateway with the `x-hyp-dev-run-id` contract
 * header, and asserts the post-2.0 zero-projector contract:
 *
 *  - Capability `hypaware.ai-gateway` registered at `2.0.0`.
 *  - The echo upstream saw the request verbatim (gateway is a
 *    pass-through).
 *  - No rows are written into `ai_gateway_messages` — phase 1
 *    intentionally ships no built-in projector, so without an adapter
 *    plugin the gateway records nothing into the dataset.
 *  - Pass-through telemetry STILL fires: the `aigw.exchange` log
 *    (carrying upstream/path/status/bytes/is_sse and dev_run_id), the
 *    `aigw.exchange_bytes` meter, and the `source.start` span.
 *  - `hyp_rows_written{dataset=ai_gateway_messages}` does NOT fire
 *    because nothing was written.
 *
 * Phases 2 and 3 will add Claude/Codex exchange projectors and bring
 * row writes back through their respective smokes
 * (`gateway_claude_capture`, `gateway_codex_capture`).
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
  // ('/') to the echo upstream. No exchange projector is registered —
  // the gateway 2.0 contract is that with no projector the dataset
  // gets zero rows but pass-through telemetry still flows.
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
    'capability: hypaware.ai-gateway registered at 2.0.0',
    registered,
    (v) => v !== undefined && v.version === '2.0.0'
  )
  /** @type {import('../../../collectivus-plugin-kernel-types').AiGatewayCapability} */
  const aiGatewayApi = kernel.capabilities.require(
    '@smoke/ai-gateway-passthrough',
    'hypaware.ai-gateway',
    '^2.0.0'
  )
  const localUrl = aiGatewayApi.localEndpoint()
  expect.that(
    'capability: localEndpoint resolves to a loopback URL',
    localUrl,
    (v) => typeof v === 'string' && /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(v)
  )

  // Drive one request through the gateway with the contract header.
  const requestBody = JSON.stringify({
    model: 'claude-smoke',
    messages: [{ role: 'user', content: `gateway ${harness.devRunId}` }],
  })
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

  // Query the dataset through the dispatcher. With no projector
  // registered the gateway must have written ZERO rows for this
  // dev_run_id — the zero-projector contract.
  const sqlStdout = makeBuf()
  const sqlStderr = makeBuf()
  const sqlCode = await dispatch(
    [
      'query',
      'sql',
      `select count(*) as n from ai_gateway_messages where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'`,
      '--refresh',
      'always',
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
    'stdout: count is 0 (no projector → zero rows in ai_gateway_messages)',
    count,
    (v) => v === 0 || v === '0' || (typeof v === 'bigint' && Number(v) === 0)
  )

  await obs.shutdown()
  await echo.close()

  // Telemetry assertions — pass-through telemetry MUST fire even
  // without a projector.
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
    'traces: no cache.append for ai_gateway_messages (zero rows means zero appends)',
    cacheAppends,
    (rows) => rows.length === 0
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
  expect.that(
    'logs: aigw.exchange reports rows_written=0 (no projector)',
    exchangeLog?.attributes?.rows_written,
    (v) => v === 0
  )

  const rowsWritten = metrics.find(
    (/** @type {any} */ m) =>
      m.name === 'hyp_rows_written' &&
      m.attributes?.hyp_dataset === 'ai_gateway_messages' &&
      m.attributes?.hyp_plugin === '@hypaware/ai-gateway'
  )
  expect.that(
    'metrics: hyp_rows_written for ai_gateway_messages is absent — projector wrote zero rows',
    rowsWritten,
    (v) => v === undefined
  )

  const exchangeBytes = metrics.find(
    (/** @type {any} */ m) =>
      m.name === 'aigw.exchange_bytes' &&
      m.attributes?.hyp_upstream === 'echo'
  )
  expect.that(
    'metrics: aigw.exchange_bytes still emitted for upstream=echo (pass-through telemetry)',
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
