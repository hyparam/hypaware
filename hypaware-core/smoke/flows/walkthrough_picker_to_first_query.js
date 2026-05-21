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
 * Phase 5 V1-milestone smoke. Drives `hyp init --yes --client claude
 * --client codex --source otel --export local-parquet --retention-days
 * 30 --dry-run --bin <stable-bin>` end-to-end against a tmp HYP_HOME
 * with all six first-party plugins active (ai-gateway, otel, local-fs,
 * format-parquet, claude, codex). Then exercises the resulting
 * install just like Phase 9 did so the `walkthrough_picker_to_first_query`
 * bead's full assertion list lands.
 *
 * Assertions (per bead hy-5oz4):
 *
 * - Non-interactive picker selections generate a config matching the
 *   expected v2 shape (both AI upstreams, OTEL, Parquet sink).
 * - Dry-run daemon install chooses the stable binary path passed via
 *   `--bin <stable-bin>` and outputs a sensible target path.
 * - Claude + Codex attach dry-runs produce expected file edits *without*
 *   touching the per-client settings/config files under the tmp HOME.
 * - One OTLP log POST + one gateway exchange each round-trip through
 *   the running sources with `dev_run_id` preserved.
 * - SQL count(*) on both `logs` and `ai_gateway_messages` returns 1
 *   under the same `dev_run_id`.
 * - The Phase 5 span contract (`walkthrough.start`,
 *   `walkthrough.write_config`, `daemon.install`, `client.attach`,
 *   `skills.install`, `walkthrough.finish`) is honored.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'walkthrough_picker_to_first_query: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
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
    codex: path.join(pluginsRoot, 'codex'),
  }

  const aiGatewayConfig = {
    listen: '127.0.0.1:0',
    upstreams: [
      { name: 'echo', base_url: echo.url, path_prefix: '/' },
    ],
  }
  const otelConfig = { listen_host: '127.0.0.1', listen_port: 0 }

  const fakeHome = path.join(harness.tmpDir, 'home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  await fs.mkdir(path.join(fakeHome, '.codex'), { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  // Pre-existing settings files would let us detect that dry-runs do
  // not modify them. Seed harmless baselines and snapshot them.
  const claudeSettingsPath = path.join(fakeHome, '.claude', 'settings.json')
  const codexConfigPath = path.join(fakeHome, '.codex', 'config.toml')
  await fs.writeFile(claudeSettingsPath, JSON.stringify({ _baseline: true }, null, 2) + '\n', 'utf8')
  await fs.writeFile(codexConfigPath, '# baseline codex config\n', 'utf8')
  const claudeBaseline = await fs.readFile(claudeSettingsPath, 'utf8')
  const codexBaseline = await fs.readFile(codexConfigPath, 'utf8')

  const stableBinPath = path.join(harness.tmpDir, 'stable', 'hypaware-bin', 'hypaware')

  try {
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'picker_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(Object.values(pluginDirs))
        if (loaded.length !== 6) {
          throw new Error(
            `walkthrough_picker_to_first_query: expected 6 manifests loaded, got ${loaded.length}`
          )
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `walkthrough_picker_to_first_query: unsatisfied requirements: ${
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

    // ----- 1. hyp init via Phase 5 flags -----
    const initStdout = makeBuf()
    const initStderr = makeBuf()
    const initCode = await dispatch(
      [
        'init',
        '--yes',
        '--client', 'claude',
        '--client', 'codex',
        '--source', 'claude',
        '--source', 'codex',
        '--source', 'otel',
        '--export', 'local-parquet',
        '--retention-days', '30',
        '--dry-run',
        '--bin', stableBinPath,
      ],
      {
        stdout: initStdout,
        stderr: initStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp init Phase 5 flags exited 0', initCode, (v) => v === 0)
    expect.that(
      'stderr: hyp init had no errors',
      initStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )

    const initText = initStdout.text()

    // Assert daemon install dry-run picked up the stable binary path.
    expect.that(
      'stdout: dry-run daemon install referenced the stable binary path',
      initText,
      (v) => typeof v === 'string' && v.includes(stableBinPath)
    )

    // Assert client attach dry-runs printed the per-client paths.
    expect.that(
      'stdout: dry-run claude attach referenced ~/.claude/settings.json',
      initText,
      (v) =>
        typeof v === 'string' &&
        v.includes(claudeSettingsPath) &&
        v.includes('(dry-run) Would attach Claude')
    )
    expect.that(
      'stdout: dry-run codex attach referenced ~/.codex/config.toml',
      initText,
      (v) =>
        typeof v === 'string' &&
        v.includes(codexConfigPath) &&
        v.includes('(dry-run) Would attach Codex')
    )

    // ----- 2. Config written matches Phase 5 shape -----
    const configPath = defaultConfigPath(harness.hypHome)
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'))
    const expected = goldenPickerConfig(harness.hypHome)
    expect.that(
      'config: Phase 5 picker config matches expected shape',
      written,
      (v) => deepEqual(v, expected)
    )

    // ----- 3. Dry-run did not touch real per-client files -----
    const claudeAfter = await fs.readFile(claudeSettingsPath, 'utf8')
    const codexAfter = await fs.readFile(codexConfigPath, 'utf8')
    expect.that(
      'dry-run preserved tmp HOME/.claude/settings.json',
      claudeAfter,
      (v) => v === claudeBaseline
    )
    expect.that(
      'dry-run preserved tmp HOME/.codex/config.toml',
      codexAfter,
      (v) => v === codexBaseline
    )

    // ----- 3b. Real attach during init uses the configured gateway port -----
    const realInitStdout = makeBuf()
    const realInitStderr = makeBuf()
    const realInitCode = await dispatch(
      [
        'init',
        '--yes',
        '--source', 'claude',
        '--export', 'keep-local',
        '--retention-days', '30',
        '--no-daemon',
        '--bin', stableBinPath,
      ],
      {
        stdout: realInitStdout,
        stderr: realInitStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: real hyp init attach exited 0', realInitCode, (v) => v === 0)
    expect.that(
      'stderr: real hyp init attach had no errors',
      realInitStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )
    const realClaudeSettings = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'))
    expect.that(
      'real init attach: claude marker uses configured gateway port',
      realClaudeSettings?._hypaware?.port,
      (v) => v === 8787
    )
    expect.that(
      'real init attach: claude base URL uses configured gateway endpoint',
      realClaudeSettings?.env?.ANTHROPIC_BASE_URL,
      (v) => v === 'http://127.0.0.1:8787'
    )

    // ----- 4. Start the sources and exercise both ingest paths -----
    const otelStarted = kernel.sources.started('otlp')
    if (!otelStarted) {
      throw new Error('walkthrough_picker_to_first_query: source `otlp` not started after activate')
    }
    const otelStatus = await /** @type {NonNullable<typeof otelStarted.status>} */ (otelStarted.status)()
    const otelDetails = /** @type {{ listen_host?: string, listen_port?: number }} */ (otelStatus.details ?? {})
    if (typeof otelDetails.listen_host !== 'string' || typeof otelDetails.listen_port !== 'number') {
      throw new Error(
        `walkthrough_picker_to_first_query: expected listen_host/listen_port in OTLP source details, got ${JSON.stringify(otelStatus.details)}`
      )
    }

    const runtime = requireAiGatewayRuntime()
    await kernel.sources.start('ai-gateway', runtime.ctx)
    runtime.started = true

    /** @type {import('../../../collectivus-plugin-kernel-types').AiGatewayCapability} */
    const gatewayApi = kernel.capabilities.require(
      '@smoke/walkthrough-picker',
      'hypaware.ai-gateway',
      '^1.0.0'
    )
    const gatewayUrl = gatewayApi.localEndpoint()

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

    const gatewayBody = JSON.stringify({ hello: 'picker', run: harness.devRunId })
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

    // ----- 5. SQL assertions on both datasets -----
    const sql = `
      select 'logs' as dataset, count(*) as n from logs
        where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
      union all
      select 'ai_gateway_messages' as dataset, count(*) as n from ai_gateway_messages
        where JSON_VALUE(metadata, '$.dev_run_id') = '${harness.devRunId}'
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

    // ----- 6. Span + log assertions -----
    await obs.shutdown()

    const traces = await expect.traces()

    const startSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'walkthrough.start'
    )
    expect.that(
      'traces: walkthrough.start span emitted with sources_available=5',
      startSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.sources_available === 5 &&
        v.exports_available === 3
    )

    const writeSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'walkthrough.write_config'
    )
    expect.that(
      'traces: walkthrough.write_config span emitted with plugin_count',
      writeSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        typeof v.plugin_count === 'number' &&
        v.plugin_count >= 4 &&
        typeof v.config_path === 'string'
    )

    const finishSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'walkthrough.finish'
    )
    expect.that(
      'traces: walkthrough.finish span has Phase 5 picks counts',
      finishSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.sources_picked === 3 &&
        v.export_picked === 'local-parquet' &&
        v.clients_picked === 2 &&
        v.retention_days === 30
    )

    const daemonInstallSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'daemon.install'
    )
    expect.that(
      'traces: daemon.install span emitted with dry_run=true + stable bin path',
      daemonInstallSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.dry_run === true &&
        v.bin_path === stableBinPath
    )

    const attachSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'client.attach'
    )
    const dryRunAttachSpans = attachSpans.filter(
      (/** @type {any} */ s) => s.attributes?.dry_run === true
    )
    const attachClients = new Set(
      dryRunAttachSpans.map((/** @type {any} */ s) => s.attributes?.client_name).filter(Boolean)
    )
    expect.that(
      'traces: client.attach span emitted for claude AND codex (dry-run)',
      attachClients,
      (v) => v instanceof Set && v.has('claude') && v.has('codex')
    )
    expect.that(
      'traces: client.attach dry_run=true for both clients',
      dryRunAttachSpans.length >= 2 &&
        dryRunAttachSpans.every((/** @type {any} */ s) => s.attributes?.dry_run === true),
      (v) => v === true
    )
    expect.that(
      'traces: real init emitted non-dry-run claude attach span',
      attachSpans.some(
        (/** @type {any} */ s) =>
          s.attributes?.client_name === 'claude' && s.attributes?.dry_run === false
      ),
      (v) => v === true
    )

    const skillsInstallSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'skills.install'
    )
    expect.that(
      'traces: skills.install span emitted with dry_run=true',
      skillsInstallSpans[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.dry_run === true &&
        typeof v.installed_count === 'number' &&
        v.installed_count >= 1
    )

    const logs = await expect.logs()
    const pickLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'walkthrough.pick'
    )
    const pickTypes = new Set(pickLogs.map((/** @type {any} */ l) => l.attributes?.pick_type))
    expect.that(
      'logs: walkthrough.pick emitted for sources AND exports',
      pickTypes,
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
function goldenPickerConfig(hypHome) {
  return {
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:8787',
          upstreams: [
            { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages', provider: 'anthropic' },
            { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1', provider: 'openai' },
            { name: 'chatgpt', base_url: 'https://chatgpt.com', path_prefix: '/backend-api/codex', provider: 'chatgpt' },
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
      {
        name: '@hypaware/codex',
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
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'picker-smoke' } }] },
        scopeLogs: [
          {
            scope: { name: 'walkthrough_picker_to_first_query' },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                body: { stringValue: 'picker smoke log row' },
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

async function startEchoUpstream() {
  /** @type {http.Server} */
  let server
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
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
