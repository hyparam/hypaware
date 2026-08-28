// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, getLogger, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { detachClientFromDisk } from '../../../src/core/config/client_detach_disk.js'
import { buildPluginCatalog } from '../../../src/core/plugin_catalog.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { opencodePluginPath } from '../../plugins-workspace/opencode/src/attach.js'

/**
 * Hermetic first-party OpenCode CLI/Desktop capture:
 *
 * - activates only `@hypaware/opencode`, proving no gateway dependency;
 * - starts the loopback snapshot source, attaches the managed JavaScript file
 *   under a temporary XDG config home, and verifies its ownership marker;
 * - posts a realistic SDK snapshot with text and a completed tool call/result;
 * - replays the same native IDs through a fake exact-session `opencode export`
 *   and proves both backfill runs write zero duplicate rows;
 * - proves `.hypignore` and in-memory session-ignore drops, source health, and
 *   exact detach cleanup;
 * - asserts adapter and backfill telemetry under the smoke run id.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0306#health [tests]: one hermetic workflow proves live/recovery
 *   convergence, privacy, health signals, and managed-file cleanup
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('opencode_capture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }
  const log = getLogger('smoke')
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    PATH: process.env.PATH,
  }
  const fakeHome = path.join(harness.tmpDir, 'home')
  const xdgConfigHome = path.join(harness.tmpDir, 'xdg-config')
  const normalCwd = path.join(harness.tmpDir, 'work', 'normal')
  const ignoredCwd = path.join(harness.tmpDir, 'work', 'ignored')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(harness.stateDir, 'cache'),
  })
  let sourceStarted = false

  /** @param {string} name @param {() => Promise<any>} fn */
  const step = (name, fn) => runRoot(
    `smoke.step.${name}`,
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.OPERATION]: 'step',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: name,
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      log.info(`smoke step ${name}`, {
        [Attr.COMPONENT]: 'smoke',
        [Attr.OPERATION]: 'step',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: name,
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      })
      return fn()
    }
  )

  const sessionId = `ses-${harness.devRunId}`
  const ignoredSessionId = `ignored-${harness.devRunId}`
  const optoutSessionId = `optout-${harness.devRunId}`
  const exported = exportFixture(sessionId, normalCwd)
  const ignoredExport = exportFixture(ignoredSessionId, ignoredCwd)

  try {
    await step('setup', async () => {
      await fs.mkdir(fakeHome, { recursive: true })
      await fs.mkdir(xdgConfigHome, { recursive: true })
      await fs.mkdir(normalCwd, { recursive: true })
      await fs.mkdir(ignoredCwd, { recursive: true })
      await fs.writeFile(path.join(ignoredCwd, '.hypignore'), 'ignore\n', 'utf8')
      const binDir = path.join(harness.tmpDir, 'bin')
      await fs.mkdir(binDir, { recursive: true })
      const fakeCli = path.join(binDir, 'opencode')
      await fs.writeFile(fakeCli, fakeOpenCodeScript({ exported, ignoredExport }), 'utf8')
      await fs.chmod(fakeCli, 0o755)

      process.env.HOME = fakeHome
      process.env.XDG_CONFIG_HOME = xdgConfigHome
      process.env.PATH = `${binDir}:${previous.PATH ?? ''}`
    })

    const activated = await step('activate', async () => {
      const pluginDir = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace', 'opencode')
      const loaded = await loadManifests([pluginDir])
      expect.that('manifest: the OpenCode plugin loaded', loaded.loaded.length, (v) => v === 1)
      const activation = await activatePlugins({
        plugins: [{
          manifest: loaded.loaded[0].manifest,
          rootDir: loaded.loaded[0].rootDir,
          config: { listen_port: 0 },
        }],
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
      })
      expect.that('activation: OpenCode activated without failures', activation.results, (v) => v.every((result) => result.ok))
      expect.that(
        'activation: no gateway capability was composed',
        kernel.capabilities.has('hypaware.ai-gateway'),
        (v) => v === false
      )
      return loaded.loaded[0]
    })

    const ctx = kernel.activationContexts.get('@hypaware/opencode')
    if (!ctx) throw new Error('opencode_capture: missing activation context')

    const endpoint = await step('listen_and_attach', async () => {
      await kernel.sources.start('opencode', ctx)
      sourceStarted = true
      const started = kernel.sources.started('opencode')
      if (!started?.status) throw new Error('opencode_capture: source did not publish status')
      const status = await started.status()
      const port = Number(status.details?.listen_port)
      expect.that('listener: bound an ephemeral loopback port', port, (v) => Number.isInteger(v) && v > 0)

      // The production default is fixed. For this hermetic dynamic bind, make
      // attach render the actual port after the source reports it.
      ctx.config.listen_port = port
      const client = kernel.clients.getClient('opencode')
      if (!client) throw new Error('opencode_capture: client registration missing')
      const out = makeBuf()
      await client.attach({ config: {}, stdout: out, stderr: makeBuf(), json: true })
      const payload = JSON.parse(out.text())
      expect.that('attach: managed plugin file was created', payload.changed, (v) => v === true)
      const body = await fs.readFile(payload.settings_path, 'utf8')
      expect.that('attach: ownership marker is present', body, (v) => v.includes('// HYPWARE_OPENCODE_PLUGIN v1'))
      expect.that('attach: listener endpoint is embedded', body, (v) => v.includes(`http://127.0.0.1:${port}`))
      return `http://127.0.0.1:${port}`
    })

    // `hyp setup`'s attach lane, over the same registration. The gateway
    // capability is absent here and its getClient() filters out endpoint-free
    // registrations anyway, so a finale that resolved adapters through the
    // capability either skipped this lane outright or recorded the adapterless
    // not-applicable result meant for a plugin with no runtime adapter.
    // @ref LLP 0306#endpoint-free-clients [tests]: the setup attach lane
    //   reaches an endpoint-free client through the intrinsic registry
    await step('setup_attach_lane', async () => {
      const { runPickerFinale } = await import('../../../src/core/cli/walkthrough.js')
      const before = await fs.readFile(opencodePluginPath({ env: process.env }), 'utf8')
      const summary = await runPickerFinale({
        finale: { skipDaemon: true, dryRun: true },
        clientsPicked: ['opencode'],
        capabilities: kernel.capabilities,
        clients: kernel.clients,
        config: /** @type {any} */ ({ version: 2, plugins: [{ name: '@hypaware/opencode' }] }),
        configPath: path.join(harness.tmpDir, 'setup-lane-config.json'),
        env: process.env,
        stdout: makeBuf(),
        stderr: makeBuf(),
        retentionDays: 30,
        interactive: false,
      })
      expect.that(
        'setup: the attach lane ran for the endpoint-free client and reported no adapter gap',
        summary.attach,
        (v) => Array.isArray(v) && v.length === 1 &&
          v[0].client === 'opencode' && v[0].ok === true &&
          v[0].noAdapter === undefined && v[0].skipped === undefined
      )
      const after = await fs.readFile(opencodePluginPath({ env: process.env }), 'utf8')
      expect.that('setup: the dry run wrote nothing', after, (v) => v === before)
    })

    await step('live_capture', async () => {
      const first = await postJson(`${endpoint}/snapshot`, {
        session: exported.info,
        messages: exported.messages,
        entrypoint: 'desktop',
        entrypoint_source: 'plugin-process',
        trigger: 'message.updated',
      })
      expect.that('listener: live snapshot returned 200', first.status, (v) => v === 200)
      expect.that('listener: live snapshot wrote three rows', /** @type {any} */ (first.body).rowsWritten, (v) => v === 3)

      const replay = await postJson(`${endpoint}/snapshot`, {
        session: exported.info,
        messages: exported.messages,
        entrypoint: 'desktop',
        entrypoint_source: 'plugin-process',
        trigger: 'part.updated',
      })
      expect.that('listener: live replay returned 200', replay.status, (v) => v === 200)
      expect.that('listener: live replay wrote zero rows', /** @type {any} */ (replay.body).rowsWritten, (v) => v === 0)

      const rows = await queryRows({
        sql: `select part_id, part_type, content_text, tool_name, tool_call_id, entrypoint from ai_gateway_messages where session_id = '${sessionId}' order by message_index, part_index`,
        kernel,
        registry,
        env: process.env,
        expect,
        label: 'live OpenCode session',
      })
      expect.that('query: live text plus completed tool rows landed once', rows, (v) =>
        v.length === 3 &&
        v.every((row) => row.entrypoint === 'desktop') &&
        v.some((row) => row.part_id === `${sessionId}-tool` && row.tool_name === 'read' && row.tool_call_id === `${sessionId}-call`)
      )
    })

    await step('privacy', async () => {
      const ignored = await postJson(`${endpoint}/snapshot`, {
        session: ignoredExport.info,
        messages: ignoredExport.messages,
        entrypoint: 'cli',
      })
      expect.that('privacy: .hypignore snapshot was dropped', ignored, (v) => v.status === 202 && v.body.reason === 'usage_policy')

      const control = await postJson(`${endpoint}/_hypaware/ignore/session`, { session_id: optoutSessionId })
      expect.that('privacy: session ignore control accepted the id', control, (v) => v.status === 200 && v.body.ignored === true)
      const optout = exportFixture(optoutSessionId, normalCwd)
      const dropped = await postJson(`${endpoint}/snapshot`, { session: optout.info, messages: optout.messages, entrypoint: 'cli' })
      expect.that('privacy: ignored session snapshot was dropped', dropped, (v) => v.status === 202 && v.body.reason === 'session_ignored')
    })

    await step('export_recovery', async () => {
      for (const run of ['one', 'two']) {
        const out = makeBuf()
        const err = makeBuf()
        const code = await dispatch(
          ['backfill', 'opencode', '--since', '2000-01-01T00:00:00.000Z', '--json'],
          {
            stdout: out,
            stderr: err,
            kernel,
            registry,
            env: { ...process.env, DEV_RUN_ID: `${harness.devRunId}-backfill-${run}` },
          }
        )
        expect.that(`backfill ${run}: exited 0`, code, (v) => v === 0)
        expect.that(`backfill ${run}: stderr empty`, err.text(), (v) => v.length === 0)
        const report = JSON.parse(out.text())
        const opencode = report.providers.find((/** @type {any} */ provider) => provider.provider === 'opencode')
        expect.that(`backfill ${run}: export overlap wrote zero rows`, opencode, (v) => v?.status === 'ok' && v.rows_written === 0)
      }

      const rows = await queryRows({
        sql: `select count(*) as row_count from ai_gateway_messages where session_id = '${sessionId}'`,
        kernel,
        registry,
        env: process.env,
        expect,
        label: 'after export recovery replays',
      })
      expect.that('query: live/export convergence retained exactly three rows', rows, (v) => Number(v[0]?.row_count) === 3)
      const ignoredRows = await queryRows({
        sql: `select count(*) as row_count from ai_gateway_messages where session_id = '${ignoredSessionId}'`,
        kernel,
        registry,
        env: process.env,
        expect,
        label: 'ignored export',
      })
      expect.that('query: ignored export retained zero rows', ignoredRows, (v) => Number(v[0]?.row_count) === 0)
    })

    await step('health_and_cleanup', async () => {
      const started = kernel.sources.started('opencode')
      const status = await started?.status?.()
      expect.that('status: listener ready', status?.state, (v) => v === 'ready')
      expect.that('status: live rows and replay events accounted', status, (v) =>
        v?.rowsWritten === 3 &&
        Number(v.details?.plugin_events) === 4 &&
        Number(v.details?.policy_drops) === 1 &&
        Number(v.details?.session_drops) === 1 &&
        v.details?.reconciliation_cursor === `${sessionId}:${sessionId}-assistant`
      )

      await kernel.sources.stop('opencode')
      sourceStarted = false
      const catalog = buildPluginCatalog([activated])
      const descriptor = catalog.clientDescriptors.get('opencode')
      if (!descriptor) throw new Error('opencode_capture: manifest client descriptor missing')
      const detached = await detachClientFromDisk({
        descriptor,
        homeDir: fakeHome,
        env: process.env,
      })
      expect.that('detach: managed plugin file was removed', detached.changed, (v) => v === true)
      if (!detached.settingsPath) throw new Error('opencode_capture: detach did not report the managed path')
      await expectMissing(detached.settingsPath)
    })

    await obs.shutdown()
    const traces = await expect.traces()
    expect.that(
      'traces: snapshot receive spans prove the listener path ran',
      traces.filter((/** @type {any} */ trace) => trace.name === 'opencode.snapshot.receive'),
      (v) => v.length === 4
    )
    expect.that(
      'traces: every named smoke step carries the run id',
      traces.filter((/** @type {any} */ trace) =>
        String(trace.name).startsWith('smoke.step.') && trace.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId
      ),
      (v) => v.length === 8
    )
    const logs = await expect.logs()
    expect.that(
      'logs: reconciliation reports the three live rows',
      logs.find((/** @type {any} */ entry) => entry.body === 'opencode.snapshot.reconciled')?.attributes,
      (v) => Number(v?.rows_written) === 3 && v?.entrypoint === 'desktop'
    )
    expect.that(
      'logs: .hypignore drop is observable',
      logs.some((/** @type {any} */ entry) => entry.body === 'opencode.snapshot.usage_policy_drop'),
      (v) => v === true
    )
  } finally {
    if (sourceStarted) await kernel.sources.stop('opencode').catch(() => {})
    await obs.shutdown().catch(() => {})
    restoreEnv('HOME', previous.HOME)
    restoreEnv('XDG_CONFIG_HOME', previous.XDG_CONFIG_HOME)
    restoreEnv('PATH', previous.PATH)
  }
}

/** @param {string} sessionId @param {string} cwd */
function exportFixture(sessionId, cwd) {
  const created = Date.parse('2026-08-24T10:00:00.000Z')
  return {
    info: { id: sessionId, directory: cwd, version: '1.18.22', time: { created, updated: created + 3_000 } },
    messages: [
      {
        info: { id: `${sessionId}-user`, role: 'user', time: { created: created + 1_000 } },
        parts: [{ id: `${sessionId}-user-part`, type: 'text', text: 'Read notes.txt' }],
      },
      {
        info: {
          id: `${sessionId}-assistant`,
          role: 'assistant',
          parentID: `${sessionId}-user`,
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          finish: 'stop',
          cost: 0.002,
          tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: created + 2_000 },
        },
        parts: [
          { id: `${sessionId}-text`, type: 'text', text: 'Reading it.' },
          {
            id: `${sessionId}-tool`,
            type: 'tool',
            callID: `${sessionId}-call`,
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: 'notes.txt' },
              output: 'smoke fixture',
              title: 'Read notes.txt',
              metadata: {},
              time: { start: created + 2_100, end: created + 2_900 },
            },
          },
        ],
      },
    ],
  }
}

/** @param {{ exported: ReturnType<typeof exportFixture>, ignoredExport: ReturnType<typeof exportFixture> }} fixtures */
function fakeOpenCodeScript(fixtures) {
  const sessions = [fixtures.exported.info, fixtures.ignoredExport.info].map((info) => ({
    id: info.id,
    updated: info.time.updated,
    created: info.time.created,
    directory: info.directory,
  }))
  return `#!/usr/bin/env node
const args = process.argv.slice(2)
const sessions = ${JSON.stringify(sessions)}
const exportsById = ${JSON.stringify({
    [fixtures.exported.info.id]: fixtures.exported,
    [fixtures.ignoredExport.info.id]: fixtures.ignoredExport,
  })}
if (args[0] === 'session' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(sessions))
  process.exit(0)
}
if (args[0] === 'export' && typeof args[1] === 'string' && exportsById[args[1]]) {
  process.stdout.write(JSON.stringify(exportsById[args[1]]))
  process.exit(0)
}
process.stderr.write('unsupported fake opencode args')
process.exit(2)
`
}

/** @param {string} url @param {unknown} body */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/** @param {{ sql: string, kernel: any, registry: any, env: any, expect: any, label: string }} args */
async function queryRows(args) {
  const out = makeBuf()
  const err = makeBuf()
  const code = await dispatch(
    ['query', 'sql', args.sql, '--refresh', 'always', '--format', 'json'],
    { stdout: out, stderr: err, kernel: args.kernel, registry: args.registry, env: args.env }
  )
  args.expect.that(`query ${args.label}: exited 0`, code, (/** @type {number} */ value) => value === 0)
  args.expect.that(`query ${args.label}: stderr empty`, err.text(), (/** @type {string} */ value) => value.length === 0)
  return JSON.parse(out.text())
}

function makeBuf() {
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) { chunks.push(String(chunk)); return true },
    text() { return chunks.join('') },
  }
}

/** @param {string} filePath */
async function expectMissing(filePath) {
  try {
    await fs.stat(filePath)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
  throw new Error(`expected managed file to be removed: ${filePath}`)
}

/** @param {string} key @param {string | undefined} value */
function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
