// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

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

/**
 * Gascity plugin-surface acceptance smoke. Boots `@hypaware/gascity`
 * from the in-repo workspace and exercises the full plugin lifecycle
 * through plugin-owned contributions:
 *
 * - `gascity attach` starts/reloads the source through plugin code
 * - `gascity list` shows attached city state
 * - `select count(*) from gascity_messages` returns captured rows
 * - `gascity detach` removes a city and reloads cleanly
 * - traces: `source.start` tagged `hyp_plugin=@hypaware/gascity`
 * - traces: `source.reload` on subsequent attach/detach
 * - cache: `cache.append` spans for `hyp_dataset=gascity_messages`
 *
 * The fixture supervisor lives entirely in this file and is wired to
 * the plugin via `globalThis[Symbol.for('hypaware-gascity:transport')]`,
 * the well-known escape hatch documented in
 * `plugins-workspace/gascity/src/transport.js`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'gascity_attach_writes_partition: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const fixture = installFixtureTransport(harness.devRunId)

  const pluginDir = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'plugins-workspace',
    'gascity'
  )
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'gascity_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([pluginDir])
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
      return activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
    }
  )

  // First attach: drives `source.start`.
  await dispatchCommand(['gascity', 'attach', 'hyptown'], { kernel, registry, harness })
  await fixture.flush()

  // Second attach: drives `source.reload`.
  await dispatchCommand(['gascity', 'attach', 'hypburb'], { kernel, registry, harness })
  await fixture.flush()

  // Push a few frames now that subscriptions are live for both cities.
  await fixture.push('hyptown', { event_kind: 'lifecycle.session_created', provider_session_id: 'sess-a1' })
  await fixture.push('hyptown', { event_kind: 'message.user', provider_session_id: 'sess-a1', content_text: 'hello' })
  await fixture.push('hypburb', { event_kind: 'lifecycle.session_created', provider_session_id: 'sess-b1' })
  await fixture.push('hypburb', { event_kind: 'message.assistant', provider_session_id: 'sess-b1', content_text: 'ack' })
  await fixture.flush()

  // Run the SQL assertion through the dispatcher so it exercises the
  // dataset registration that gascity contributed at activation.
  const sqlStdout = makeBuf()
  const sqlStderr = makeBuf()
  const sqlCode = await dispatch(
    [
      'query',
      'sql',
      'select count(*) as n from gascity_messages',
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
    'stdout: json result is an array with exactly one row',
    parsed,
    (v) => Array.isArray(v) && v.length === 1
  )
  const count = parsed?.[0]?.n
  expect.that(
    'stdout: select count(*) returned 4 (frames pushed by the fixture)',
    count,
    (v) => v === 4 || v === '4' || (typeof v === 'bigint' && Number(v) === 4)
  )

  // Run `hyp gascity list` to verify both cities are attached.
  const listStdout = makeBuf()
  const listStderr = makeBuf()
  const listCode = await dispatch(['gascity', 'list'], {
    stdout: listStdout,
    stderr: listStderr,
    kernel,
    registry,
    env: smokeEnv(harness),
  })
  expect.that('dispatch: gascity list exited 0', listCode, (v) => v === 0)
  const listText = listStdout.text()
  expect.that(
    'stdout: gascity list includes hyptown',
    listText.includes('hyptown'),
    (v) => v === true
  )
  expect.that(
    'stdout: gascity list includes hypburb',
    listText.includes('hypburb'),
    (v) => v === true
  )

  // Detach hypburb and verify the source reloads cleanly.
  const detachOut = await dispatchCommand(
    ['gascity', 'detach', 'hypburb'],
    { kernel, registry, harness }
  )
  expect.that(
    "stdout: detach prints confirmation for 'hypburb'",
    detachOut.includes('hypburb'),
    (v) => v === true
  )

  // After detach, list should still show hyptown but not hypburb.
  const list2Stdout = makeBuf()
  const list2Stderr = makeBuf()
  await dispatch(['gascity', 'list'], {
    stdout: list2Stdout,
    stderr: list2Stderr,
    kernel,
    registry,
    env: smokeEnv(harness),
  })
  const list2Text = list2Stdout.text()
  expect.that(
    'stdout: gascity list after detach still includes hyptown',
    list2Text.includes('hyptown'),
    (v) => v === true
  )
  expect.that(
    'stdout: gascity list after detach no longer includes hypburb',
    list2Text.includes('hypburb'),
    (v) => v === false
  )

  await obs.shutdown()
  fixture.uninstall()

  const traces = await expect.traces()

  const startSpans = traces.filter(
    (/** @type {any} */ t) => t.name === 'source.start'
  )
  expect.that(
    'traces: exactly one source.start span emitted',
    startSpans,
    (rows) => rows.length === 1
  )
  expect.that(
    'traces: source.start tagged hyp_plugin=@hypaware/gascity',
    startSpans[0]?.attributes?.[Attr.PLUGIN],
    (v) => v === '@hypaware/gascity'
  )
  expect.that(
    'traces: source.start tagged hyp_source=gascity',
    startSpans[0]?.attributes?.hyp_source,
    (v) => v === 'gascity'
  )

  const reloadSpans = traces.filter(
    (/** @type {any} */ t) => t.name === 'source.reload'
  )
  expect.that(
    'traces: at least 2 source.reload spans emitted (attach + detach)',
    reloadSpans,
    (rows) => rows.length >= 2
  )
  expect.that(
    'traces: source.reload tagged hyp_plugin=@hypaware/gascity',
    reloadSpans[0]?.attributes?.[Attr.PLUGIN],
    (v) => v === '@hypaware/gascity'
  )

  const cacheAppends = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'cache.append' && t.attributes?.hyp_dataset === 'gascity_messages'
  )
  expect.that(
    'traces: at least one cache.append for gascity_messages',
    cacheAppends,
    (rows) => rows.length >= 1
  )
  const totalRowsAppended = cacheAppends.reduce(
    (/** @type {number} */ sum, /** @type {any} */ span) =>
      sum + (typeof span.attributes?.row_count === 'number' ? span.attributes.row_count : 0),
    0
  )
  expect.that(
    'traces: cache.append spans sum to 4 rows for gascity_messages',
    totalRowsAppended,
    (v) => v === 4
  )
}

/**
 * Install an in-process fixture supervisor and wire the gascity
 * transport global to it. Returns a controller that lets the smoke
 * push frames and flush the buffered writes back to the kernel cache
 * before assertions.
 *
 * @param {string} devRunId
 */
function installFixtureTransport(devRunId) {
  const TRANSPORT_KEY = Symbol.for('hypaware-gascity:transport')

  /** @type {Map<string, (frame: any) => Promise<void> | void>} */
  const subscribers = new Map()
  /** @type {Promise<unknown>[]} */
  const inflight = []

  const transport = {
    /**
     * @param {{
     *   city: string,
     *   onFrame: (frame: any) => Promise<void> | void,
     *   signal: AbortSignal,
     * }} opts
     */
    async subscribe(opts) {
      subscribers.set(opts.city, opts.onFrame)
      return {
        async close() {
          subscribers.delete(opts.city)
        },
      }
    },
  }
  /** @type {Record<symbol, unknown>} */
  const slot = /** @type {any} */ (globalThis)
  const previous = slot[TRANSPORT_KEY]
  slot[TRANSPORT_KEY] = transport

  return {
    /**
     * @param {string} city
     * @param {Partial<{ event_kind: string, provider_session_id: string, content_text: string, template: string }>} frame
     */
    async push(city, frame) {
      const onFrame = subscribers.get(city)
      if (!onFrame) {
        throw new Error(`fixture: no subscriber attached for city '${city}'`)
      }
      const fullFrame = {
        city,
        provider_session_id: frame.provider_session_id ?? 'session-default',
        event_time: new Date().toISOString(),
        event_kind: frame.event_kind ?? 'message.user',
        template: frame.template,
        content_text: frame.content_text,
        metadata: { dev_run_id: devRunId },
      }
      const result = Promise.resolve(onFrame(fullFrame))
      inflight.push(result)
      await result
    },
    async flush() {
      const pending = inflight.splice(0)
      await Promise.all(pending)
    },
    uninstall() {
      slot[TRANSPORT_KEY] = previous
    },
  }
}

/**
 * @param {string[]} argv
 * @param {{ kernel: ReturnType<typeof createKernelRuntime>, registry: ReturnType<typeof createCommandRegistry>, harness: any }} ctx
 */
async function dispatchCommand(argv, { kernel, registry, harness }) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, {
    stdout,
    stderr,
    kernel,
    registry,
    env: smokeEnv(harness),
  })
  if (code !== 0) {
    throw new Error(
      `dispatch failed: argv=${argv.join(' ')} exit=${code} stderr=${stderr.text()}`
    )
  }
  if (stderr.text().length > 0) {
    throw new Error(`dispatch wrote to stderr: argv=${argv.join(' ')} stderr=${stderr.text()}`)
  }
  return stdout.text()
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
