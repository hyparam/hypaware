// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { requireAiGatewayRuntime } from '../../plugins-workspace/ai-gateway/src/runtime.js'

/**
 * @import { AiGatewayCapability } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * Phase 9 V1-milestone smoke. Boots the full first-party stack
 * (`@hypaware/ai-gateway` + `@hypaware/otel` + `@hypaware/local-fs` +
 * `@hypaware/format-parquet` + `@hypaware/claude`) against a tmp
 * HYP_HOME, drives `hyp init claude-and-otel-local`, then exercises
 * the resulting install end-to-end.
 *
 * Assertions (per bead hy-imw):
 *
 * - `hyp init claude-and-otel-local` exits 0 and writes the v2 config
 *   at `<HYP_HOME>/hypaware-config.json`. The config matches a golden
 *   shape that enumerates all five plugins and the
 *   `local` sink (writer=format-parquet, destination=local-fs).
 * - `hyp status` exits 0 and prints the four plugins (two sources,
 *   one sink contribution, one client) plus the cache retention
 *   window from the config.
 * - One OTLP log POST and one gateway request each round-trip through
 *   the running sources, with `dev_run_id` preserved.
 * - SQL count(*) on both `logs` and `ai_gateway_messages` returns 1
 *   under the same `dev_run_id`.
 * - `walkthrough.finish` span (via the preset shortcut: the preset
 *   does not emit it; the bead lists it as a walkthrough-specific
 *   contract, validated separately by an in-process walkthrough call
 *   inside this smoke) carries `sources_picked`/`sinks_picked`/
 *   `clients_picked`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'walkthrough_to_first_query: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const echo = await startEchoUpstream()

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = {
    aiGateway: path.join(pluginsRoot, 'ai-gateway'),
    otel: path.join(pluginsRoot, 'otel'),
    localFs: path.join(pluginsRoot, 'local-fs'),
    parquet: path.join(pluginsRoot, 'format-parquet'),
    claude: path.join(pluginsRoot, 'claude'),
  }

  // Plugins listen on ephemeral ports for the smoke. The preset's
  // written config carries the standard defaults (8787, 4318) but the
  // running test instances use port 0 so multiple smoke runs do not
  // collide. The golden assertion below checks the written config,
  // not the bound addresses.
  const aiGatewayConfig = {
    listen: '127.0.0.1:0',
    upstreams: [
      { name: 'echo', base_url: echo.url, path_prefix: '/' },
    ],
  }
  const otelConfig = { listen_host: '127.0.0.1', listen_port: 0 }

  const fakeHome = path.join(harness.tmpDir, 'home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  try {
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'walkthrough_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(Object.values(pluginDirs))
        if (loaded.length !== 5) {
          throw new Error(
            `walkthrough_to_first_query: expected 5 manifests loaded, got ${loaded.length}`
          )
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `walkthrough_to_first_query: unsatisfied requirements: ${
              resolution.unsatisfied.map((u) => `${u.plugin}:${u.errorKind}`).join(', ')
            }`
          )
        }
        const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
        const entries = resolution.order
          .map((name) => byName.get(name))
          .filter((l) => l !== undefined)
          .map((l) => ({
            manifest: l.manifest,
            rootDir: l.rootDir,
            config:
              l.manifest.name === '@hypaware/ai-gateway' ? aiGatewayConfig
              : l.manifest.name === '@hypaware/otel'      ? otelConfig
              : {},
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

    // ----- 1. hyp init claude-and-otel-local -----
    const initStdout = makeBuf()
    const initStderr = makeBuf()
    const initCode = await dispatch(
      ['init', 'claude-and-otel-local'],
      {
        stdout: initStdout,
        stderr: initStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp init claude-and-otel-local exited 0', initCode, (v) => v === 0)
    expect.that(
      'stderr: hyp init had no errors',
      initStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )

    const configPath = defaultConfigPath(harness.hypHome)
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'))
    const expectedConfig = goldenConfig(harness.hypHome)
    expect.that(
      'config: golden v2 shape matches the preset output',
      written,
      (v) => deepEqual(v, expectedConfig)
    )

    // ----- 2. hyp status -----
    const statusStdout = makeBuf()
    const statusStderr = makeBuf()
    const statusCode = await dispatch(
      ['status'],
      {
        stdout: statusStdout,
        stderr: statusStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp status exited 0', statusCode, (v) => v === 0)
    expect.that(
      'stderr: hyp status had no errors',
      statusStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )
    const statusText = statusStdout.text()
    for (const expected of ['ai-gateway', 'otlp', 'local-fs', 'claude', 'cache retention', '30 days']) {
      expect.that(
        `stdout: hyp status mentions '${expected}'`,
        statusText,
        (v) => typeof v === 'string' && v.includes(expected)
      )
    }

    // ----- 3. Start the sources and exercise both ingest paths -----
    const otelStarted = kernel.sources.started('otlp')
    if (!otelStarted) {
      throw new Error('walkthrough_to_first_query: source `otlp` not started after activate')
    }
    const otelStatus = await /** @type {NonNullable<typeof otelStarted.status>} */ (otelStarted.status)()
    const otelDetails = /** @type {{ listen_host?: string, listen_port?: number }} */ (otelStatus.details ?? {})
    if (typeof otelDetails.listen_host !== 'string' || typeof otelDetails.listen_port !== 'number') {
      throw new Error(
        `walkthrough_to_first_query: expected listen_host/listen_port in OTLP source details, got ${JSON.stringify(otelStatus.details)}`
      )
    }

    const runtime = requireAiGatewayRuntime()
    await kernel.sources.start('ai-gateway', runtime.ctx)
    runtime.started = true

    /** @type {AiGatewayCapability} */
    const gatewayApi = kernel.capabilities.require(
      '@smoke/walkthrough',
      'hypaware.ai-gateway',
      '^2.0.0'
    )
    const gatewayUrl = gatewayApi.localEndpoint()

    // POST one OTLP log payload: `attributes.dev_run_id` is what the
    // SQL assertion below counts on.
    const otlpPayload = buildOtlpLogPayload(harness.devRunId)
    const otlpResponse = await fetch(
      `http://${otelDetails.listen_host}:${otelDetails.listen_port}/v1/logs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(otlpPayload),
      }
    )
    expect.that('otlp POST: server returned 200', otlpResponse.status, (v) => v === 200)
    await otlpResponse.text()

    // Issue one request through the gateway with the contract header.
    const gatewayBody = JSON.stringify({
      model: 'claude-walkthrough',
      messages: [{ role: 'user', content: `gateway ${harness.devRunId}` }],
    })
    const gatewayResponse = await postThroughGateway({
      url: `${gatewayUrl}/v1/echo`,
      headers: {
        'content-type': 'application/json',
        'x-hyp-dev-run-id': harness.devRunId,
      },
      body: gatewayBody,
    })
    expect.that(
      'gateway: response status 200 from echo upstream',
      gatewayResponse.statusCode,
      (v) => v === 200
    )

    await kernel.sources.stop('ai-gateway')

    // ----- 4. SQL assertions on both datasets -----
    const sql = `
      select 'logs' as dataset, count(*) as n from logs
        where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
      union all
      select 'ai_gateway_messages' as dataset, count(*) as n from ai_gateway_messages
        where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
    `.trim().replace(/\s+/g, ' ')

    const sqlStdout = makeBuf()
    const sqlStderr = makeBuf()
    const sqlCode = await dispatch(
      ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
      {
        stdout: sqlStdout,
        stderr: sqlStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
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
        `stdout: query sql JSON parse failed (${message})`,
        false,
        (v) => v === true
      )
    }
    // `renderResult(..., 'json')` writes the row array directly.
    const rows = Array.isArray(parsed) ? parsed : []
    expect.that(
      'sql: both rows present (logs + ai_gateway_messages)',
      rows.map((/** @type {any} */ r) => r.dataset).sort(),
      (v) => Array.isArray(v) && v.join(',') === 'ai_gateway_messages,logs'
    )
    const logsRow = rows.find((/** @type {any} */ r) => r.dataset === 'logs')
    const aigwRow = rows.find((/** @type {any} */ r) => r.dataset === 'ai_gateway_messages')
    expect.that(
      'sql: logs has exactly one row for this dev_run_id',
      Number(logsRow?.n ?? 0),
      (v) => v === 1
    )
    expect.that(
      'sql: ai_gateway_messages has exactly one row for this dev_run_id',
      Number(aigwRow?.n ?? 0),
      (v) => v === 1
    )

    // ----- 5. Span assertions: walkthrough.start/finish + status.render -----
    // The preset path does not by itself invoke the walkthrough spans
    // (they're emitted by the interactive walkthrough), so drive a
    // headless picker walkthrough now with pre-baked picks to validate
    // the span contract documented on the bead.
    const { runPickerWalkthrough } = await import('../../../src/core/cli/walkthrough.js')
    const headlessStdout = makeBuf()
    const headlessStderr = makeBuf()
    await runPickerWalkthrough({
      capabilities: kernel.capabilities,
      stdout: headlessStdout,
      stderr: headlessStderr,
      env: { ...smokeEnv(harness), HYP_CONFIG: path.join(harness.tmpDir, 'walkthrough-config.json') },
      picks: { sources: ['claude', 'codex'], exportChoice: 'local-parquet', retentionDays: 30 },
    })

    await obs.shutdown()

    const traces = await expect.traces()

    const statusSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'status.render'
    )
    expect.that(
      'traces: status.render span emitted with source_count + sink_count + retention_days',
      statusSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.source_count === 2 &&
        v.sink_count === 1 &&
        v.client_count === 1 &&
        v.retention_days === 30
    )

    const startSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'walkthrough.start'
    )
    expect.that(
      'traces: walkthrough.start span emitted with sources_available',
      startSpans[0]?.attributes?.sources_available,
      (v) => typeof v === 'number' && v >= 2
    )

    const finishSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'walkthrough.finish'
    )
    expect.that(
      'traces: walkthrough.finish span emitted with picks counts',
      finishSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.sources_picked === 2 &&
        v.export_picked === 'local-parquet' &&
        v.clients_picked === 2 &&
        v.retention_days === 30
    )

    const logs = await expect.logs()
    const pickLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'walkthrough.pick'
    )
    expect.that(
      'logs: walkthrough.pick emitted at least once per pick category',
      new Set(pickLogs.map((/** @type {any} */ l) => l.attributes?.pick_type)),
      (v) => v instanceof Set && v.has('sources') && v.has('exports')
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await echo.close()
  }
}

/**
 * @param {string} hypHome
 */
function goldenConfig(hypHome) {
  return {
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:8787',
          upstreams: [
            {
              name: 'anthropic',
              base_url: 'https://api.anthropic.com',
              path_prefix: '/',
            },
          ],
        },
      },
      {
        name: '@hypaware/otel',
        config: { listen_host: '127.0.0.1', listen_port: 4318 },
      },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      {
        name: '@hypaware/claude',
        config: { proxy: '@hypaware/ai-gateway' },
      },
    ],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: {
          dir: path.join(hypHome, 'exports'),
          schedule: '*/5 * * * *',
        },
      },
    },
    query: {
      cache: {
        retention: { default_days: 30 },
      },
    },
  }
}

/**
 * @param {string} runId
 */
function buildOtlpLogPayload(runId) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'walkthrough-smoke' } }] },
        scopeLogs: [
          {
            scope: { name: 'walkthrough_to_first_query' },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                body: { stringValue: 'walkthrough smoke log row' },
                attributes: [{ key: 'dev_run_id', value: { stringValue: runId } }],
                severityNumber: 9,
                severityText: 'INFO',
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * Boot a one-shot HTTP echo server that the AI gateway forwards into.
 * Mirrors the helper in `ai_gateway_passthrough.js`.
 */
async function startEchoUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([])
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          url: req.url,
          method: req.method,
          headers: req.headers,
          bodyBytes: body.length,
        })
      )
    })
  })
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = /** @type {{ address: string, port: number }} */ (server.address())
  return {
    url: `http://${address.address}:${address.port}`,
    close: () => new Promise((res) => server.close(() => res(undefined))),
  }
}

/**
 * @param {{ url: string, headers: Record<string, string>, body: string }} req
 */
function postThroughGateway(req) {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url)
    const r = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: req.headers,
      },
      (res) => {
        const chunks = /** @type {Buffer[]} */ ([])
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      }
    )
    r.on('error', reject)
    r.write(req.body)
    r.end()
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

/**
 * Structural deep equality. Used for the v2-config golden compare;
 * arrays are order-sensitive (so plugin ordering is part of the
 * contract).
 *
 * @param {unknown} a
 * @param {unknown} b
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== /** @type {unknown[]} */ (b).length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], /** @type {unknown[]} */ (b)[i])) return false
    }
    return true
  }
  const ak = Object.keys(/** @type {object} */ (a))
  const bk = Object.keys(/** @type {object} */ (b))
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!bk.includes(k)) return false
    if (!deepEqual(
      /** @type {Record<string, unknown>} */ (a)[k],
      /** @type {Record<string, unknown>} */ (b)[k]
    )) return false
  }
  return true
}
