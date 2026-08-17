// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'

/**
 * The Claude telemetry listener, end to end in a temp HypAware home.
 *
 * Activates `@hypaware/ai-gateway` + `@hypaware/claude`, drives the
 * SessionStart hook, starts the listener source on a dynamic port, and
 * POSTs a real-shaped Claude Code OTLP/JSON batch at it (`user_prompt`,
 * `api_request`, `assistant_response`, plus behavioral events this
 * ticket does not model). Then asserts, through `hyp query sql`:
 *
 *  - the rows landed in `ai_gateway_messages` with native uuid identity,
 *    the prompt and response text, the model, the usage the
 *    `api_request` event carried, and the cwd the hook recorded;
 *  - a replay of the same batch adds nothing;
 *  - a SECOND producer over the same session (transcript backfill,
 *    whose transcript carries the same uuids) adds nothing either, so
 *    the migration overlap window is harmless;
 *  - a non-JSON content type is refused the way the OTLP receiver
 *    refuses it, without disturbing the rows;
 *  - the capture spans say the intended path ran.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0257#testing [tests]: the primary seam is a hermetic smoke, content
 *   in at the HTTP endpoint and rows out of `hyp query sql`
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'claude_telemetry_capture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const sessionId = `otel-${harness.devRunId}`
  const userUuid = `u-user-${harness.devRunId}`
  const assistantUuid = `u-asst-${harness.devRunId}`
  const requestId = `req_${harness.devRunId}`
  const promptText = 'Run ls, then read notes.txt.'
  const responseText = 'This is a spike repo.'

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [
    path.join(pluginsRoot, 'ai-gateway'),
    path.join(pluginsRoot, 'claude'),
  ]

  // The SECOND producer for the overlap assertion: a transcript whose
  // uuids are the ones the events carry. `hyp backfill claude` reads it
  // from `<HOME>/.claude/projects`, and the Claude plugin captures HOME
  // at activation, so it is staged first.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const projectsDir = path.join(fakeHome, '.claude', 'projects', 'some-repo')
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.writeFile(
    path.join(projectsDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        sessionId,
        uuid: userUuid,
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: promptText },
        timestamp: '2026-08-17T19:30:24.450Z',
      }),
      JSON.stringify({
        sessionId,
        uuid: assistantUuid,
        parentUuid: userUuid,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: responseText }] },
        timestamp: '2026-08-17T19:30:31.009Z',
      }),
    ].join('\n') + '\n',
    'utf8'
  )

  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  try {
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'claude_telemetry_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(pluginDirs)
        if (loaded.length !== pluginDirs.length) {
          throw new Error(`claude_telemetry_capture: expected ${pluginDirs.length} manifests, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `claude_telemetry_capture: unsatisfied requirements: ${
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
            // Port 0: the smoke reads the bound port back off the source
            // status, the same way `hyp attach claude` will.
            config: /** @type {any} */ (l.manifest.name === '@hypaware/claude'
              ? { telemetry: { listen_host: '127.0.0.1', listen_port: 0 } }
              : {}),
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

    const env = { ...process.env, HYP_HOME: harness.hypHome }

    // ----- SessionStart hook: the source of cwd and git identity -----
    const stateFile = path.join(
      harness.stateDir, 'plugins', '@hypaware/claude', 'session-context.jsonl'
    )
    await fs.mkdir(path.dirname(stateFile), { recursive: true })
    const hookCode = await dispatch(
      ['claude-hook', 'session-context', '--state-file', stateFile],
      {
        stdout: makeBuf(),
        stderr: makeBuf(),
        stdin: /** @type {any} */ (Readable.from([JSON.stringify({
          session_id: sessionId,
          cwd: harness.tmpDir,
          hook_event_name: 'SessionStart',
        })])),
        kernel,
        registry,
        env,
      }
    )
    expect.that('hook: session-context invocation exited 0', hookCode, (v) => v === 0)

    // ----- Start the listener -----
    const ctx = kernel.activationContexts.get('@hypaware/claude')
    if (!ctx) throw new Error('claude_telemetry_capture: no activation context for @hypaware/claude')
    await kernel.sources.start('claude-telemetry', ctx)
    const started = kernel.sources.started('claude-telemetry')
    if (!started) throw new Error('claude_telemetry_capture: source `claude-telemetry` not started')
    const status = await /** @type {NonNullable<typeof started.status>} */ (started.status)()
    const details = /** @type {{ listen_host?: string, listen_port?: number }} */ (status.details ?? {})
    expect.that(
      'status: listener reports a loopback host and a bound port',
      details,
      (v) => v.listen_host === '127.0.0.1' && typeof v.listen_port === 'number' && v.listen_port > 0
    )
    const endpoint = `http://${details.listen_host}:${details.listen_port}`

    // ----- Refuse a non-JSON content type, like the OTLP receiver -----
    const badType = await fetch(`${endpoint}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not otlp',
    })
    expect.that('listener: a non-json content type is refused with 415', badType.status, (v) => v === 415)
    await badType.text()

    // ----- POST one real-shaped batch -----
    const payload = buildTelemetryBatch({ sessionId, userUuid, assistantUuid, requestId, promptText, responseText })
    const posted = await postJson(`${endpoint}/v1/logs`, payload)
    expect.that('listener: OTLP/JSON POST returned 200', posted.status, (v) => v === 200)

    const sql = `
      select
        role,
        content_text,
        message_id,
        provider_uuid,
        model,
        cwd,
        client_name,
        conversation_source,
        provider,
        entrypoint,
        parent_uuid,
        permission_mode,
        request_id,
        JSON_VALUE(attributes, '$.usage.output_tokens') as output_tokens,
        JSON_VALUE(attributes, '$.usage.cache_read_tokens') as cache_read_tokens,
        JSON_VALUE(attributes, '$.gateway.source') as producer,
        JSON_VALUE(attributes, '$.claude.query_source') as query_source
      from ai_gateway_messages
      where session_id = '${sessionId}'
      order by message_index, part_index
    `.trim().replace(/\s+/g, ' ')

    const rows = await queryRows({ sql, kernel, registry, env, expect, label: 'after the first batch' })
    expect.that('query: the turn landed as two rows', rows, (v) => Array.isArray(v) && v.length === 2)

    const user = rows.find((/** @type {any} */ r) => r.role === 'user')
    const assistant = rows.find((/** @type {any} */ r) => r.role === 'assistant')
    expect.that(
      'query: the user row carries the native message uuid and the prompt text',
      user,
      (v) => v !== undefined && v.message_id === userUuid && v.provider_uuid === userUuid && v.content_text === promptText,
    )
    expect.that(
      'query: the assistant row carries the native message uuid and the response text',
      assistant,
      (v) => v !== undefined && v.message_id === assistantUuid && v.content_text === responseText,
    )
    expect.that(
      'query: the assistant row carries the model and the request id',
      assistant,
      (v) => v !== undefined && v.model === 'claude-haiku-4-5-20251001' && v.request_id === requestId,
    )
    expect.that(
      'query: the api_request usage landed on the assistant row',
      assistant,
      (v) => v !== undefined && Number(v.output_tokens) === 113 && Number(v.cache_read_tokens) === 35212,
    )
    for (const row of rows) {
      expect.that(
        `query: the ${row.role} row carries the cwd the hook recorded`,
        row.cwd,
        (v) => v === harness.tmpDir,
      )
      expect.that(
        `query: the ${row.role} row is attributed to the claude client over anthropic`,
        row,
        (v) => v.client_name === 'claude' && v.provider === 'anthropic' && v.conversation_source === 'claude_code',
      )
      expect.that(
        `query: the ${row.role} row records the OTEL producer and the query source`,
        row,
        (v) => v.producer === 'otel' && v.query_source === 'sdk',
      )
      expect.that(
        `query: the ${row.role} row leaves the transcript-only columns null`,
        row,
        (v) => (v.parent_uuid ?? null) === null && (v.permission_mode ?? null) === null,
      )
      expect.that(
        `query: the ${row.role} row carries the app entrypoint`,
        row.entrypoint,
        (v) => v === 'sdk-cli',
      )
    }

    // ----- A replayed batch adds nothing -----
    const replay = await postJson(`${endpoint}/v1/logs`, payload)
    expect.that('listener: the replayed POST returned 200', replay.status, (v) => v === 200)
    const afterReplay = await queryRows({ sql, kernel, registry, env, expect, label: 'after the replay' })
    expect.that(
      'query: replaying the same events did not duplicate the rows',
      afterReplay,
      (v) => Array.isArray(v) && v.length === 2,
    )

    // ----- A second producer over the same session adds nothing -----
    // The overlap window of the proxy-to-OTEL migration, in miniature:
    // transcript backfill re-materializes the same parts and the
    // `part_id` dedupe collapses them onto the rows already stored.
    const backfillOut = makeBuf()
    const backfillErr = makeBuf()
    const backfillCode = await dispatch(
      ['backfill', 'claude', '--since', '2000-01-01T00:00:00.000Z', '--json'],
      { stdout: backfillOut, stderr: backfillErr, kernel, registry, env: { ...env, DEV_RUN_ID: `${harness.devRunId}-backfill` } }
    )
    expect.that('dispatch: backfill claude exited 0', backfillCode, (v) => v === 0)
    const backfillRun = JSON.parse(backfillOut.text())
    const claudeProvider = backfillRun.providers.find((/** @type {any} */ p) => p.provider === 'claude')
    expect.that(
      'backfill: the transcript producer wrote ZERO new rows over the OTEL capture',
      claudeProvider,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written === 0,
    )
    const afterBackfill = await queryRows({ sql, kernel, registry, env, expect, label: 'after backfill' })
    expect.that(
      'query: two producers over one session still dedupe to one set of rows',
      afterBackfill,
      (v) => Array.isArray(v) && v.length === 2,
    )

    await kernel.sources.stop('claude-telemetry')
    await obs.shutdown()

    // ----- Capture telemetry -----
    const traces = await expect.traces()

    const startSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'source.start' && t.attributes?.hyp_source === 'claude-telemetry'
    )
    expect.that(
      'traces: exactly one source.start span for the claude telemetry listener',
      startSpans,
      (v) => Array.isArray(v) && v.length === 1,
    )
    expect.that(
      'traces: source.start carries the bound address',
      startSpans[0]?.attributes,
      (v) => v !== undefined && v.listen_host === details.listen_host && v.listen_port === details.listen_port,
    )
    expect.that(
      'traces: source.start is tagged with the owning plugin',
      startSpans[0]?.attributes?.[Attr.PLUGIN],
      (v) => v === '@hypaware/claude',
    )

    const receives = traces.filter(
      (/** @type {any} */ t) => t.name === 'claude.telemetry.receive'
    )
    expect.that(
      'traces: one claude.telemetry.receive span per accepted batch',
      receives,
      (v) => Array.isArray(v) && v.length === 2,
    )
    expect.that(
      'traces: the first receive span reports ok, the events it saw, and the rows it wrote',
      receives[0]?.attributes,
      (v) => v !== undefined &&
        v.status === 'ok' &&
        v.signal === 'logs' &&
        Number(v.payload_bytes) > 0 &&
        Number(v.event_count) === 5 &&
        Number(v.session_count) === 1 &&
        Number(v.row_count) === 2,
    )
    expect.that(
      'traces: the replay receive span wrote nothing',
      receives[1]?.attributes,
      (v) => v !== undefined && Number(v.row_count) === 0,
    )

    const cacheAppends = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages'
    )
    expect.that(
      'traces: at least one cache.append for ai_gateway_messages',
      cacheAppends,
      (v) => Array.isArray(v) && v.length >= 1,
    )

    const logs = await expect.logs()
    const batchLogs = logs.filter((/** @type {any} */ l) => l.body === 'claude.telemetry.batch')
    expect.that(
      'logs: the batch log reports the event and row counts',
      batchLogs[0]?.attributes,
      (v) => v !== undefined && Number(v.event_count) === 5 && Number(v.rows_written) === 2,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

// ---------------------------------------------------------------------
// Fixture + helpers
// ---------------------------------------------------------------------

/**
 * One turn as Claude Code 2.1.233 exports it: the three content-bearing
 * events this listener models, plus two behavioral events it does not,
 * so the flow proves the unmodelled ones are skipped rather than
 * breaking the batch.
 *
 * @param {{
 *   sessionId: string,
 *   userUuid: string,
 *   assistantUuid: string,
 *   requestId: string,
 *   promptText: string,
 *   responseText: string,
 * }} args
 */
function buildTelemetryBatch(args) {
  const common = {
    'session.id': args.sessionId,
    'app.version': '2.1.233',
    'app.entrypoint': 'sdk-cli',
    'organization.id': '2efcd21e-aea6-42c6-9eda-a6e997ddcde4',
    'user.account_uuid': 'c9f39145-595f-4b31-9c66-c5c658a80aed',
    'user.email': 'someone@example.com',
    'terminal.type': 'ghostty',
    'prompt.id': `p-${args.sessionId}`,
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: kv({
            'service.name': 'claude-code',
            'service.version': '2.1.233',
            'os.type': 'darwin',
          }),
        },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: [
              logRecord('permission_mode_changed', '2026-08-17T19:30:20.000Z', {
                ...common,
                from_mode: 'default',
                to_mode: 'acceptEdits',
                trigger: 'user',
              }),
              logRecord('user_prompt', '2026-08-17T19:30:24.450Z', {
                ...common,
                prompt_length: String(args.promptText.length),
                prompt: args.promptText,
                'message.uuid': args.userUuid,
              }),
              logRecord('tool_result', '2026-08-17T19:30:27.679Z', {
                ...common,
                tool_name: 'Read',
                tool_use_id: 'toolu_smoke',
                success: 'true',
                duration_ms: '1',
              }),
              logRecord('api_request', '2026-08-17T19:30:31.009Z', {
                ...common,
                model: 'claude-haiku-4-5-20251001',
                input_tokens: 73,
                output_tokens: 113,
                cache_read_tokens: 35212,
                cache_creation_tokens: 307,
                cost_usd: 0.0047732,
                duration_ms: 1842,
                request_id: args.requestId,
                speed: 'normal',
                query_source: 'sdk',
              }),
              logRecord('assistant_response', '2026-08-17T19:30:31.009Z', {
                ...common,
                response_length: args.responseText.length,
                response: args.responseText,
                request_id: args.requestId,
                'message.uuid': args.assistantUuid,
                model: 'claude-haiku-4-5-20251001',
                query_source: 'sdk',
              }),
            ],
          },
        ],
      },
    ],
  }
}

/**
 * @param {string} name
 * @param {string} timestamp
 * @param {Record<string, unknown>} attrs
 */
function logRecord(name, timestamp, attrs) {
  const nanos = String(BigInt(Date.parse(timestamp)) * 1_000_000n)
  return {
    timeUnixNano: nanos,
    observedTimeUnixNano: nanos,
    body: { stringValue: `claude_code.${name}` },
    attributes: kv({ ...attrs, 'event.name': name, 'event.timestamp': timestamp }),
  }
}

/** @param {Record<string, unknown>} attrs */
function kv(attrs) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: value } }
        : { key, value: { doubleValue: value } }
    }
    if (typeof value === 'boolean') return { key, value: { boolValue: value } }
    return { key, value: { stringValue: String(value) } }
  })
}

/**
 * @param {string} url
 * @param {unknown} payload
 */
async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  // Drain so the socket is released before the listener closes.
  await response.text()
  return response
}

/**
 * @param {{ sql: string, kernel: any, registry: any, env: any, expect: any, label: string }} args
 * @returns {Promise<any[]>}
 */
async function queryRows(args) {
  const { sql, kernel, registry, env, expect, label } = args
  const out = makeBuf()
  const err = makeBuf()
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: out, stderr: err, kernel, registry, env }
  )
  expect.that(`dispatch: query (${label}) exited 0`, code, (v) => v === 0)
  expect.that(`stderr: query (${label}) had no errors`, err.text(), (v) => typeof v === 'string' && v.length === 0)
  try {
    return JSON.parse(out.text())
  } catch (e) {
    expect.that(
      `stdout: query (${label}) was valid JSON (${e instanceof Error ? e.message : String(e)})`,
      false,
      (v) => v === true,
    )
    return []
  }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
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
