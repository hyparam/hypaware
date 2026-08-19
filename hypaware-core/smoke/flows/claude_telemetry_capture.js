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
import { claudeBodySpoolDir } from '../../plugins-workspace/claude/src/telemetry/spool.js'

/**
 * The Claude telemetry listener, end to end in a temp HypAware home.
 *
 * Activates `@hypaware/ai-gateway` + `@hypaware/claude`, drives the
 * SessionStart hook, starts the listener source on a dynamic port, and
 * POSTs a real-shaped Claude Code OTLP/JSON batch at it (`user_prompt`,
 * `api_request`, `assistant_response`, the two body events pointing at
 * spooled body files, plus the behavioral events - `tool_decision`,
 * `permission_mode_changed`, `tool_result`, and the hook pair). Then
 * asserts, through `hyp query sql`:
 *
 *  - the rows landed in `ai_gateway_messages` with native uuid identity,
 *    the prompt and response text, the model, the usage the
 *    `api_request` event carried, and the cwd the hook recorded;
 *  - the behavioral events landed in `claude_telemetry_events`, one row
 *    per event with the hot fields typed (name, session, tool, decision,
 *    source, cost) and the rest preserved in the attributes JSON, with
 *    the content events NOT among them; a metrics POST lands its data
 *    points in the same dataset; the dataset enumerates alongside
 *    `ai_gateway_messages` and carries its central-forwarding signal;
 *  - the spooled bodies filled the gaps events never carry: system_text
 *    and the tools list on every row, the untruncated tool args, the
 *    tool result, and the thinking signature, and both body files are
 *    DELETED once projected;
 *  - the spool is owner-only and its byte cap evicts oldest-first at
 *    startup (a pre-staged over-cap body is gone before the first POST);
 *  - a session whose body was evicted still completes: its events land,
 *    and transcript backfill recovers the tool content the body held;
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
 *   in at the HTTP endpoint, body fixtures in the spool, rows out of
 *   `hyp query sql`
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
  const systemText = 'You are Claude Code, operating inside the smoke.'
  const tools = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }]
  // Long enough that the event-side 512-char clip would have truncated it:
  // only the spooled body carries it whole.
  const longToolArg = 'n'.repeat(600)
  const toolResultText = 'notes.txt: spike findings'
  const thinkingText = 'The file confirms this is a spike repo.'
  const thinkingSignature = `sig-${harness.devRunId}`

  // The evicted-session cast: its body is pre-staged over the cap and
  // swept away at listener start, before its events ever arrive.
  const session2 = `otel2-${harness.devRunId}`
  const user2Uuid = `u2-user-${harness.devRunId}`
  const toolAsst2Uuid = `u2-tool-${harness.devRunId}`
  const toolResult2Uuid = `u2-result-${harness.devRunId}`
  const assistant2Uuid = `u2-asst-${harness.devRunId}`
  const request2Id = `req2_${harness.devRunId}`
  const prompt2Text = 'What files are here?'
  const response2Text = 'Just a README.'

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

  // The body spool, as Claude Code would leave it: created by the client at
  // the default mode (the listener must tighten it), already holding one
  // body larger than the configured cap (the startup sweep must evict it).
  // @ref LLP 0253#byte-cap [tests]: the cap is config, eviction is oldest-first
  const spoolDir = claudeBodySpoolDir(harness.hypHome)
  await fs.mkdir(spoolDir, { recursive: true, mode: 0o755 })
  await fs.chmod(spoolDir, 0o755)
  const evictedBodyPath = path.join(spoolDir, `${session2}-req.json`)
  await fs.writeFile(evictedBodyPath, JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    system: [{ type: 'text', text: systemText }],
    tools,
    messages: [
      { role: 'user', content: prompt2Text },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_evicted', name: 'Bash', input: { command: `ls ${longToolArg}` } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_evicted', content: 'README.md' }],
      },
    ],
  }), 'utf8')
  const spoolCapBytes = 256

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
              ? { telemetry: { listen_host: '127.0.0.1', listen_port: 0, spool_max_bytes: spoolCapBytes } }
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
    const hook2Code = await dispatch(
      ['claude-hook', 'session-context', '--state-file', stateFile],
      {
        stdout: makeBuf(),
        stderr: makeBuf(),
        stdin: /** @type {any} */ (Readable.from([JSON.stringify({
          session_id: session2,
          cwd: harness.tmpDir,
          hook_event_name: 'SessionStart',
        })])),
        kernel,
        registry,
        env,
      }
    )
    expect.that('hook: session-context invocation for the evicted session exited 0', hook2Code, (v) => v === 0)

    // ----- Start the listener -----
    const ctx = kernel.activationContexts.get('@hypaware/claude')
    if (!ctx) throw new Error('claude_telemetry_capture: no activation context for @hypaware/claude')
    await kernel.sources.start('claude-telemetry', ctx)
    const started = kernel.sources.started('claude-telemetry')
    if (!started) throw new Error('claude_telemetry_capture: source `claude-telemetry` not started')
    const status = await /** @type {NonNullable<typeof started.status>} */ (started.status)()
    const details = /** @type {{ listen_host?: string, listen_port?: number, spool_bytes?: number, bodies_evicted?: number }} */ (status.details ?? {})
    expect.that(
      'status: listener reports a loopback host and a bound port',
      details,
      (v) => v.listen_host === '127.0.0.1' && typeof v.listen_port === 'number' && v.listen_port > 0
    )
    const endpoint = `http://${details.listen_host}:${details.listen_port}`

    // ----- The spool after listener start: tightened, capped, swept -----
    const spoolMode = (await fs.stat(spoolDir)).mode & 0o777
    expect.that('spool: the listener tightened the client-created directory to owner-only', spoolMode, (v) => v === 0o700)
    expect.that(
      'spool: the pre-staged over-cap body was evicted at startup',
      await fileExists(evictedBodyPath),
      (v) => v === false
    )
    expect.that(
      'status: the eviction and the swept spool size are visible in the source status',
      details,
      (v) => v.bodies_evicted === 1 && v.spool_bytes === 0
    )

    // ----- Session 1's body files, dropped the way Claude Code drops them -----
    const requestBodyPath = path.join(spoolDir, `${sessionId}-req.json`)
    const responseBodyPath = path.join(spoolDir, `${sessionId}-resp.json`)
    await fs.writeFile(requestBodyPath, JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      system: [{ type: 'text', text: systemText }],
      tools,
      messages: [
        { role: 'user', content: promptText },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading notes.txt now.' },
            { type: 'tool_use', id: 'toolu_smoke', name: 'Read', input: { file_path: '/tmp/notes.txt', notes: longToolArg } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_smoke', content: toolResultText }],
        },
      ],
    }), 'utf8')
    await fs.writeFile(responseBodyPath, JSON.stringify({
      id: `msg_${harness.devRunId}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [
        { type: 'thinking', thinking: thinkingText, signature: thinkingSignature },
        { type: 'text', text: responseText },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 73, output_tokens: 113 },
    }), 'utf8')

    // ----- Refuse a non-JSON content type, like the OTLP receiver -----
    const badType = await fetch(`${endpoint}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not otlp',
    })
    expect.that('listener: a non-json content type is refused with 415', badType.status, (v) => v === 415)
    await badType.text()

    // ----- POST one real-shaped batch -----
    const payload = buildTelemetryBatch({
      sessionId,
      userUuid,
      assistantUuid,
      requestId,
      promptText,
      responseText,
      requestBodyPath,
      responseBodyPath,
    })
    const posted = await postJson(`${endpoint}/v1/logs`, payload)
    expect.that('listener: OTLP/JSON POST returned 200', posted.status, (v) => v === 200)

    // Projected, then deleted: the batch's write succeeded, so the raw
    // bodies must be gone from disk.
    // @ref LLP 0252#project-then-delete [tests]: deletion is the normal end of
    //   a body's life
    expect.that(
      'spool: the request body file was deleted after projection',
      await fileExists(requestBodyPath),
      (v) => v === false
    )
    expect.that(
      'spool: the response body file was deleted after projection',
      await fileExists(responseBodyPath),
      (v) => v === false
    )

    const sqlFor = (/** @type {string} */ session) => `
      select
        role,
        part_type,
        content_text,
        message_id,
        part_id,
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
        system_text,
        tool_name,
        tool_call_id,
        tool_result_for,
        thinking_signature,
        JSON_VALUE(tools, '$[0].name') as tool0_name,
        JSON_VALUE(tool_args, '$.notes') as tool_arg_notes,
        JSON_VALUE(tool_args, '$.command') as tool_arg_command,
        JSON_VALUE(raw_frame, '$.type') as frame_type,
        JSON_VALUE(raw_frame, '$.body_file') as frame_body_file,
        raw_frame,
        JSON_VALUE(attributes, '$.usage.output_tokens') as output_tokens,
        JSON_VALUE(attributes, '$.usage.cache_read_tokens') as cache_read_tokens,
        JSON_VALUE(attributes, '$.gateway.source') as producer,
        JSON_VALUE(attributes, '$.claude.query_source') as query_source
      from ai_gateway_messages
      where session_id = '${session}'
      order by message_index, part_index
    `.trim().replace(/\s+/g, ' ')
    const sql = sqlFor(sessionId)

    const rows = await queryRows({ sql, kernel, registry, env, expect, label: 'after the first batch' })
    expect.that(
      'query: the turn landed as five rows (prompt, tool_use, tool_result, thinking, response)',
      rows,
      (v) => Array.isArray(v) && v.length === 5,
    )
    expect.that(
      'query: the rows follow the body\'s canonical message ordering',
      rows.map((/** @type {any} */ r) => r.part_type),
      (v) => JSON.stringify(v) === JSON.stringify(['text', 'tool_call', 'tool_result', 'reasoning', 'text']),
    )

    const user = rows.find((/** @type {any} */ r) => r.role === 'user' && r.part_type === 'text')
    const assistant = rows.find((/** @type {any} */ r) => r.content_text === responseText)
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

    // ----- The gaps only the spooled bodies could fill -----
    // @ref LLP 0252#bodies-for-gaps [tests]: system text, tools, untruncated
    //   args, tool results, and thinking signatures come from the body files
    const toolUse = rows.find((/** @type {any} */ r) => r.part_type === 'tool_call')
    expect.that(
      'query: the tool_use row carries the FULL untruncated tool args from the body',
      toolUse,
      (v) => v !== undefined && v.tool_name === 'Read' && v.tool_call_id === 'toolu_smoke' &&
        v.tool_arg_notes === longToolArg,
    )
    const toolResult = rows.find((/** @type {any} */ r) => r.part_type === 'tool_result')
    expect.that(
      'query: the tool_result row carries the result the wire events never showed',
      toolResult,
      (v) => v !== undefined && v.role === 'user' && v.tool_result_for === 'toolu_smoke' &&
        v.content_text === toolResultText,
    )
    const reasoning = rows.find((/** @type {any} */ r) => r.part_type === 'reasoning')
    expect.that(
      'query: the thinking row carries the signature from the response body',
      reasoning,
      (v) => v !== undefined && v.thinking_signature === thinkingSignature && v.content_text === thinkingText,
    )
    for (const gapRow of [toolUse, toolResult, reasoning]) {
      const frame = JSON.stringify(gapRow?.raw_frame ?? '')
      expect.that(
        `query: the ${gapRow?.part_type} row's raw_frame is a body pointer, never content`,
        gapRow,
        (v) => v !== undefined &&
          (v.frame_type === 'api_request_body' || v.frame_type === 'api_response_body') &&
          typeof v.frame_body_file === 'string' &&
          !frame.includes(longToolArg.slice(0, 32)) &&
          !frame.includes(thinkingText),
      )
    }

    for (const row of rows) {
      expect.that(
        `query: the ${row.part_type} ${row.role} row carries the cwd the hook recorded`,
        row.cwd,
        (v) => v === harness.tmpDir,
      )
      expect.that(
        `query: the ${row.part_type} ${row.role} row is attributed to the claude client over anthropic`,
        row,
        (v) => v.client_name === 'claude' && v.provider === 'anthropic' && v.conversation_source === 'claude_code',
      )
      expect.that(
        `query: the ${row.part_type} ${row.role} row records the OTEL producer and the query source`,
        row,
        (v) => v.producer === 'otel' && v.query_source === 'sdk',
      )
      expect.that(
        `query: the ${row.part_type} ${row.role} row leaves the transcript-only columns null`,
        row,
        (v) => (v.parent_uuid ?? null) === null && (v.permission_mode ?? null) === null,
      )
      expect.that(
        `query: the ${row.part_type} ${row.role} row carries the app entrypoint`,
        row.entrypoint,
        (v) => v === 'sdk-cli',
      )
      // Stamped exchange-level from the request body, on every row, exactly
      // where the proxy path puts them.
      expect.that(
        `query: the ${row.part_type} ${row.role} row carries the body's system text and tools`,
        row,
        (v) => v.system_text === systemText && v.tool0_name === 'Read',
      )
    }

    // ----- The behavioral half: claude_telemetry_events -----
    // @ref LLP 0255#row-shape [tests]: one row per event, hot fields typed
    //   (name, session, tool, decision, source, cost), attributes JSON for
    //   the rest
    const eventsSqlFor = (/** @type {string} */ session) => `
      select
        event_name,
        session_id,
        tool_name,
        decision,
        source,
        cost_usd,
        event_timestamp,
        JSON_VALUE(attributes, '$.from_mode') as from_mode,
        JSON_VALUE(attributes, '$.to_mode') as to_mode,
        JSON_VALUE(attributes, '$.hook_name') as hook_name,
        JSON_VALUE(attributes, '$.success') as hook_success,
        JSON_VALUE(attributes, '$.input_tokens') as input_tokens,
        JSON_VALUE(attributes, '$.decision') as json_decision,
        JSON_VALUE(attributes, '$.value') as metric_value,
        JSON_VALUE(attributes, '$.unit') as metric_unit
      from claude_telemetry_events
      where session_id = '${session}'
      order by event_timestamp, event_name
    `.trim().replace(/\s+/g, ' ')
    const eventsSql = eventsSqlFor(sessionId)

    const eventRows = await queryRows({ sql: eventsSql, kernel, registry, env, expect, label: 'behavioral events' })
    expect.that(
      'events: one row per behavioral event, content and body events excluded',
      eventRows.map((/** @type {any} */ r) => r.event_name),
      (v) => JSON.stringify(v) === JSON.stringify([
        'permission_mode_changed',
        'tool_decision',
        'tool_result',
        'hook_execution_start',
        'hook_execution_complete',
        'api_request',
      ]),
    )
    for (const row of eventRows) {
      expect.that(
        `events: the ${row.event_name} row carries the session id and a timestamp`,
        row,
        (v) => v.session_id === sessionId && typeof v.event_timestamp === 'string' && v.event_timestamp.length > 0,
      )
    }
    const toolDecision = eventRows.find((/** @type {any} */ r) => r.event_name === 'tool_decision')
    expect.that(
      'events: the tool_decision row types the tool, the decision, and its source',
      toolDecision,
      (v) => v !== undefined && v.tool_name === 'Read' && v.decision === 'reject' && v.source === 'user_reject',
    )
    expect.that(
      'events: a promoted hot field leaves the attributes JSON',
      toolDecision,
      (v) => v !== undefined && (v.json_decision ?? null) === null,
    )
    const modeChange = eventRows.find((/** @type {any} */ r) => r.event_name === 'permission_mode_changed')
    expect.that(
      'events: the permission_mode_changed row keeps its unpromoted attributes in the JSON',
      modeChange,
      (v) => v !== undefined && v.from_mode === 'default' && v.to_mode === 'acceptEdits' &&
        (v.tool_name ?? null) === null && (v.decision ?? null) === null,
    )
    const apiRequest = eventRows.find((/** @type {any} */ r) => r.event_name === 'api_request')
    expect.that(
      'events: the api_request row types the cost and keeps the token counts in the JSON',
      apiRequest,
      (v) => v !== undefined && Math.abs(Number(v.cost_usd) - 0.0047732) < 1e-9 &&
        Number(v.input_tokens) === 73,
    )
    const hookComplete = eventRows.find((/** @type {any} */ r) => r.event_name === 'hook_execution_complete')
    expect.that(
      'events: the hook_execution_complete row carries the hook identity and outcome',
      hookComplete,
      (v) => v !== undefined && v.hook_name === 'hypaware-session-context' && v.hook_success === 'true',
    )

    // The registration surfaces: the dataset enumerates alongside the
    // existing ones, and carries the ingest signal central forwarding
    // needs so it never falls back to the dataset name.
    // @ref LLP 0255#owned-by-claude [tests]: registration sets the source signal
    const statusOut = makeBuf()
    const statusCode = await dispatch(
      ['query', 'status'],
      { stdout: statusOut, stderr: makeBuf(), kernel, registry, env }
    )
    expect.that('dispatch: query status exited 0', statusCode, (v) => v === 0)
    expect.that(
      'enumeration: claude_telemetry_events is listed alongside ai_gateway_messages',
      statusOut.text(),
      (v) => v.includes('claude_telemetry_events  (@hypaware/claude)') &&
        v.includes('ai_gateway_messages  (@hypaware/ai-gateway)'),
    )
    expect.that(
      'registration: the dataset declares the claude_telemetry source signal',
      kernel.query.getDataset('claude_telemetry_events')?.sourceSignal,
      (v) => v === 'claude_telemetry',
    )

    // ----- A replayed batch adds nothing -----
    // The body files are already gone, so on replay the content events
    // dedupe by part_id and the body refs read as missing, not as errors.
    const replay = await postJson(`${endpoint}/v1/logs`, payload)
    expect.that('listener: the replayed POST returned 200', replay.status, (v) => v === 200)
    const afterReplay = await queryRows({ sql, kernel, registry, env, expect, label: 'after the replay' })
    expect.that(
      'query: replaying the same events did not duplicate the rows',
      afterReplay,
      (v) => Array.isArray(v) && v.length === 5,
    )
    // The behavioral dataset has no pre-write dedupe by design (single
    // producer, one POST per batch; a retry only follows a failed write,
    // which wrote nothing). A manually re-POSTed identical batch is the
    // lost-success-response window: the rows double, byte-identical, and
    // cache compaction's content-hash layer owns the collapse.
    const eventsAfterReplay = await queryRows({ sql: eventsSql, kernel, registry, env, expect, label: 'behavioral events after the replay' })
    expect.that(
      'events: the replayed batch appended its behavioral rows again, byte-identical',
      eventsAfterReplay,
      (v) => Array.isArray(v) && v.length === 12,
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
      (v) => Array.isArray(v) && v.length === 5,
    )

    // ----- An evicted session still completes via transcript backfill -----
    // Its body was swept at startup, so the batch lands only what the
    // events carry: the prompt and the response text, no tool content and
    // no system text.
    // @ref LLP 0253#eviction-degrades [tests]: eviction degrades to backfill,
    //   never to loss
    const payload2 = buildEvictedSessionBatch({
      sessionId: session2,
      userUuid: user2Uuid,
      assistantUuid: assistant2Uuid,
      requestId: request2Id,
      promptText: prompt2Text,
      responseText: response2Text,
      requestBodyPath: evictedBodyPath,
    })
    const posted2 = await postJson(`${endpoint}/v1/logs`, payload2)
    expect.that('listener: the evicted session\'s POST returned 200', posted2.status, (v) => v === 200)
    const sql2 = sqlFor(session2)
    const evictedRows = await queryRows({ sql: sql2, kernel, registry, env, expect, label: 'evicted session, events only' })
    expect.that(
      'query: the evicted session landed its two content events and nothing else',
      evictedRows,
      (v) => Array.isArray(v) && v.length === 2 &&
        v.every((r) => r.part_type === 'text' && (r.system_text ?? null) === null),
    )

    // The recovery path: the transcript Claude Code wrote all along holds
    // the tool content the evicted body held. Staged only now, so the
    // earlier zero-rows backfill assertion stays meaningful.
    await fs.writeFile(
      path.join(projectsDir, `${session2}.jsonl`),
      [
        JSON.stringify({
          sessionId: session2,
          uuid: user2Uuid,
          parentUuid: null,
          type: 'user',
          message: { role: 'user', content: prompt2Text },
          timestamp: '2026-08-17T19:40:01.000Z',
        }),
        JSON.stringify({
          sessionId: session2,
          uuid: toolAsst2Uuid,
          parentUuid: user2Uuid,
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'tool_use', id: 'toolu_evicted', name: 'Bash', input: { command: `ls ${longToolArg}` } }],
          },
          timestamp: '2026-08-17T19:40:02.000Z',
        }),
        JSON.stringify({
          sessionId: session2,
          uuid: toolResult2Uuid,
          parentUuid: toolAsst2Uuid,
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_evicted', content: 'README.md' }],
          },
          timestamp: '2026-08-17T19:40:03.000Z',
        }),
        JSON.stringify({
          sessionId: session2,
          uuid: assistant2Uuid,
          parentUuid: toolResult2Uuid,
          type: 'assistant',
          message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: response2Text }] },
          timestamp: '2026-08-17T19:40:04.000Z',
        }),
      ].join('\n') + '\n',
      'utf8'
    )
    const recoverOut = makeBuf()
    const recoverCode = await dispatch(
      ['backfill', 'claude', '--since', '2000-01-01T00:00:00.000Z', '--json'],
      { stdout: recoverOut, stderr: makeBuf(), kernel, registry, env: { ...env, DEV_RUN_ID: `${harness.devRunId}-recover` } }
    )
    expect.that('dispatch: the recovery backfill exited 0', recoverCode, (v) => v === 0)
    const recoverRun = JSON.parse(recoverOut.text())
    const recoverProvider = recoverRun.providers.find((/** @type {any} */ p) => p.provider === 'claude')
    expect.that(
      'backfill: recovery wrote exactly the two rows the evicted body held',
      recoverProvider,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written === 2,
    )
    const recoveredRows = await queryRows({ sql: sql2, kernel, registry, env, expect, label: 'evicted session, recovered' })
    expect.that(
      'query: the evicted session completed to four rows',
      recoveredRows,
      (v) => Array.isArray(v) && v.length === 4,
    )
    const recoveredTool = recoveredRows.find((/** @type {any} */ r) => r.part_type === 'tool_call')
    expect.that(
      'query: the recovered tool_use row carries native identity and the full args',
      recoveredTool,
      (v) => v !== undefined && v.part_id === `${toolAsst2Uuid}#0` &&
        v.tool_arg_command === `ls ${longToolArg}` && v.producer === 'backfill',
    )
    expect.that(
      'query: the event-captured rows of the evicted session were not disturbed',
      recoveredRows.filter((/** @type {any} */ r) => r.producer === 'otel').length,
      (v) => v === 2,
    )

    // ----- The metrics half of the exporter config -----
    // The same env block turns on OTEL_METRICS_EXPORTER, so Claude Code
    // POSTs its activity counters at /v1/metrics; each data point lands
    // as one behavioral row named by its metric.
    const postedMetrics = await postJson(`${endpoint}/v1/metrics`, buildMetricsBatch({ sessionId }))
    expect.that('listener: the metrics POST returned 200', postedMetrics.status, (v) => v === 200)
    const withMetrics = await queryRows({ sql: eventsSql, kernel, registry, env, expect, label: 'behavioral events with metrics' })
    const costRow = withMetrics.find((/** @type {any} */ r) => r.event_name === 'claude_code.cost.usage')
    expect.that(
      'events: the cost metric data point landed with its value, unit, and session',
      costRow,
      (v) => v !== undefined && Math.abs(Number(v.metric_value) - 0.0047732) < 1e-9 &&
        v.metric_unit === 'USD' && v.session_id === sessionId &&
        typeof v.event_timestamp === 'string' && v.event_timestamp.length > 0,
    )
    const locRow = withMetrics.find((/** @type {any} */ r) => r.event_name === 'claude_code.lines_of_code.count')
    expect.that(
      'events: the lines-of-code metric data point landed with its integer value',
      locRow,
      (v) => v !== undefined && Number(v.metric_value) === 42,
    )

    const finalStatus = await /** @type {NonNullable<typeof started.status>} */ (started.status)()
    const finalDetails = /** @type {any} */ (finalStatus.details ?? {})
    expect.that(
      'status: the listener counted the two projected bodies and an empty spool',
      finalDetails,
      (v) => v.bodies_projected === 2 && v.spool_bytes === 0 && v.bodies_evicted === 1,
    )
    // 6 from the first batch, 6 from its replay, 1 (api_request) from the
    // evicted session, 2 metric data points.
    expect.that(
      'status: the behavioral row count is reported apart from the message rows',
      finalDetails,
      (v) => v.telemetry_rows_written === 15,
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
      (v) => Array.isArray(v) && v.length === 4,
    )
    expect.that(
      'traces: the first receive span reports ok, the events it saw, and the rows it wrote',
      receives[0]?.attributes,
      (v) => v !== undefined &&
        v.status === 'ok' &&
        v.signal === 'logs' &&
        Number(v.payload_bytes) > 0 &&
        Number(v.event_count) === 10 &&
        Number(v.session_count) === 1 &&
        Number(v.row_count) === 5 &&
        Number(v.telemetry_row_count) === 6,
    )
    expect.that(
      'traces: the first receive span counted the two bodies it projected and deleted',
      receives[0]?.attributes,
      (v) => v !== undefined && Number(v.body_count) === 2 &&
        Number(v.bodies_projected) === 2 && Number(v.bodies_deleted) === 2,
    )
    expect.that(
      'traces: the replay receive span wrote nothing',
      receives[1]?.attributes,
      (v) => v !== undefined && Number(v.row_count) === 0,
    )
    expect.that(
      'traces: the evicted session\'s receive span wrote its event rows without a body',
      receives[2]?.attributes,
      (v) => v !== undefined && Number(v.row_count) === 2 && Number(v.body_count) === 0,
    )
    expect.that(
      'traces: the metrics receive span wrote only behavioral rows',
      receives[3]?.attributes,
      (v) => v !== undefined && v.signal === 'metrics' && Number(v.event_count) === 2 &&
        Number(v.row_count) === 0 && Number(v.telemetry_row_count) === 2,
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
    const eventAppends = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'cache.append' && t.attributes?.hyp_dataset === 'claude_telemetry_events'
    )
    expect.that(
      'traces: at least one cache.append for claude_telemetry_events',
      eventAppends,
      (v) => Array.isArray(v) && v.length >= 1,
    )

    const logs = await expect.logs()
    const batchLogs = logs.filter((/** @type {any} */ l) => l.body === 'claude.telemetry.batch')
    expect.that(
      'logs: the batch log reports the event, row, and body counts',
      batchLogs[0]?.attributes,
      (v) => v !== undefined && Number(v.event_count) === 10 &&
        Number(v.rows_written) === 5 && Number(v.telemetry_rows_written) === 6 &&
        Number(v.bodies_projected) === 2,
    )
    expect.that(
      'logs: the evicted session\'s batch log counts its missing body',
      batchLogs[2]?.attributes,
      (v) => v !== undefined && Number(v.bodies_missing) === 1,
    )
    const evictLogs = logs.filter((/** @type {any} */ l) => l.body === 'claude.telemetry.spool_evicted')
    expect.that(
      'logs: the startup sweep logged the eviction with counts',
      evictLogs[0]?.attributes,
      (v) => v !== undefined && Number(v.evicted_count) === 1 &&
        Number(v.spool_max_bytes) === spoolCapBytes,
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
 * One turn as Claude Code 2.1.233 exports it: `user_prompt` and
 * `assistant_response` project into messages, the two body events'
 * `body_ref`s point into the spool, and the behavioral events
 * (`permission_mode_changed`, `tool_decision`, `tool_result`, the hook
 * pair, and `api_request`, which also feeds usage onto the assistant
 * row) land in `claude_telemetry_events`.
 *
 * @param {{
 *   sessionId: string,
 *   userUuid: string,
 *   assistantUuid: string,
 *   requestId: string,
 *   promptText: string,
 *   responseText: string,
 *   requestBodyPath: string,
 *   responseBodyPath: string,
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
              logRecord('api_request_body', '2026-08-17T19:30:26.000Z', {
                ...common,
                body_ref: args.requestBodyPath,
                request_id: args.requestId,
              }),
              logRecord('tool_decision', '2026-08-17T19:30:26.500Z', {
                ...common,
                tool_name: 'Read',
                decision: 'reject',
                source: 'user_reject',
              }),
              logRecord('tool_result', '2026-08-17T19:30:27.679Z', {
                ...common,
                tool_name: 'Read',
                tool_use_id: 'toolu_smoke',
                success: 'true',
                duration_ms: '1',
              }),
              logRecord('hook_execution_start', '2026-08-17T19:30:28.000Z', {
                ...common,
                hook_name: 'hypaware-session-context',
                hook_event: 'SessionStart',
              }),
              logRecord('hook_execution_complete', '2026-08-17T19:30:28.200Z', {
                ...common,
                hook_name: 'hypaware-session-context',
                hook_event: 'SessionStart',
                success: 'true',
                duration_ms: '12',
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
              logRecord('api_response_body', '2026-08-17T19:30:31.000Z', {
                ...common,
                body_ref: args.responseBodyPath,
                request_id: args.requestId,
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
 * The evicted session's batch: the same wire shape, but its
 * `api_request_body` names a file the startup sweep already removed, so
 * only the event-carried content can land.
 *
 * @param {{
 *   sessionId: string,
 *   userUuid: string,
 *   assistantUuid: string,
 *   requestId: string,
 *   promptText: string,
 *   responseText: string,
 *   requestBodyPath: string,
 * }} args
 */
function buildEvictedSessionBatch(args) {
  const common = {
    'session.id': args.sessionId,
    'app.version': '2.1.233',
    'app.entrypoint': 'sdk-cli',
    'user.account_uuid': 'c9f39145-595f-4b31-9c66-c5c658a80aed',
    'prompt.id': `p-${args.sessionId}`,
  }
  return {
    resourceLogs: [
      {
        resource: { attributes: kv({ 'service.name': 'claude-code', 'service.version': '2.1.233' }) },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.233' },
            logRecords: [
              logRecord('user_prompt', '2026-08-17T19:40:01.000Z', {
                ...common,
                prompt_length: String(args.promptText.length),
                prompt: args.promptText,
                'message.uuid': args.userUuid,
              }),
              logRecord('api_request_body', '2026-08-17T19:40:01.500Z', {
                ...common,
                body_ref: args.requestBodyPath,
                request_id: args.requestId,
              }),
              logRecord('api_request', '2026-08-17T19:40:04.000Z', {
                ...common,
                model: 'claude-haiku-4-5-20251001',
                input_tokens: 12,
                output_tokens: 7,
                request_id: args.requestId,
                query_source: 'sdk',
              }),
              logRecord('assistant_response', '2026-08-17T19:40:04.100Z', {
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
 * The metrics half as Claude Code exports it: monotonic sums under the
 * `com.anthropic.claude_code` meter scope, `session.id` on every data
 * point, int64 values as strings on the OTLP/JSON wire.
 *
 * @param {{ sessionId: string }} args
 */
function buildMetricsBatch(args) {
  const nanos = String(BigInt(Date.parse('2026-08-17T19:31:00.000Z')) * 1_000_000n)
  return {
    resourceMetrics: [
      {
        resource: { attributes: kv({ 'service.name': 'claude-code', 'service.version': '2.1.233' }) },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code', version: '2.1.233' },
            metrics: [
              {
                name: 'claude_code.cost.usage',
                unit: 'USD',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: kv({ 'session.id': args.sessionId, model: 'claude-haiku-4-5-20251001' }),
                      timeUnixNano: nanos,
                      asDouble: 0.0047732,
                    },
                  ],
                },
              },
              {
                name: 'claude_code.lines_of_code.count',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: kv({ 'session.id': args.sessionId, type: 'added' }),
                      timeUnixNano: nanos,
                      asInt: '42',
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

/** @param {string} file */
async function fileExists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
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
  // `--max-cell 0`: the display-value clip would truncate the long tool
  // args this smoke exists to prove untruncated.
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json', '--max-cell', '0', '--max-bytes', '0'],
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
