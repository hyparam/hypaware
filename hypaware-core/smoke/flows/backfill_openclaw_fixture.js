// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { writeOpenclawSessionFixture } from '../lib/openclaw_session_fixture.js'

/**
 * Hermetic smoke: OpenClaw session backfill → query → idempotent rerun.
 *
 * The sibling of `backfill_codex_fixture.js` and `backfill_claude_fixture.js`,
 * and the tier-2 gate whose absence let #543 ship green. A real OpenClaw v3
 * `type: "message"` record nests `role`/`content`/`provider`/`usage` under a
 * `message` key; the reader took them off the record line, found nothing,
 * excluded every record fail-closed, and reported a clean "0 rows" for every
 * real session. Nothing in the hermetic tier ever wrote an OpenClaw session
 * file, in any shape, so nothing caught it. The fixture here is written in
 * the verified two-level shape through
 * {@link writeOpenclawSessionFixture}, so "the reader read the wrong level"
 * and "the backfill wrote no rows" are the same failure again.
 *
 * Boots `@hypaware/ai-gateway` + `@hypaware/openclaw` against a tmp
 * HYP_HOME with a staged session file under the fake HOME's
 * `.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`, then drives
 * `hyp backfill openclaw` directly (no daemon: backfill is a local file
 * import) and asserts:
 *
 *  - **User-visible query result**: `ai_gateway_messages` holds NON-ZERO
 *    rows for the session, carrying the record lines' native `message_id`s,
 *    the envelope's content, and `provider = anthropic` /
 *    `conversation_source = openclaw` / `client_name = openclaw`. The
 *    non-zero assertion is the literal #543 regression.
 *  - **Internal telemetry**: a `backfill.provider_finish` span and a
 *    `backfill.finish` log carrying the run's `dev_run_id`, `provider`, and
 *    matching row counts, plus a `backfill.write` span for
 *    `ai_gateway_messages`.
 *  - **Idempotency**: a second `hyp backfill openclaw` (a fresh run id, so
 *    the materializer re-scans committed partitions) writes ZERO new rows
 *    and the query still returns exactly the same rows.
 *
 * @ref LLP 0161#backfill-provider [tests]: the provider's whole path, from
 * the session file's two-level records to native-identity rows that dedupe
 * against themselves on a rerun
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'backfill_openclaw_fixture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [
    path.join(pluginsRoot, 'ai-gateway'),
    path.join(pluginsRoot, 'openclaw'),
  ]

  // The OpenClaw provider captures its agents root from `ctx.env.HOME`
  // (→ `<HOME>/.openclaw/agents`) at activation, so stage the session and
  // point HOME at it BEFORE activating plugins.
  const fakeHome = path.join(harness.tmpDir, 'home')
  // A real directory with no `.hypignore` above it, so the per-file usage
  // policy gate resolves and records rather than being skipped for want of
  // a usable cwd. The header states it, which is where the provider reads
  // the session's one cwd from.
  const workspaceDir = path.join(harness.tmpDir, 'workspace')
  await fs.mkdir(workspaceDir, { recursive: true })

  const agentId = 'main'
  const sessionId = `oc-${harness.devRunId}`
  const userMessageId = `${sessionId}-msg-user-1`
  const assistantMessageId = `${sessionId}-msg-asst-1`
  const fixture = await writeOpenclawSessionFixture({
    homeDir: fakeHome,
    agentId,
    sessionId,
    header: { cwd: workspaceDir },
    records: [
      // A user prompt states no `provider` (only an assistant record does),
      // so it rides the forward fill onto the assistant turn's backend.
      {
        id: userMessageId,
        timestamp: '2026-05-20T10:00:01.000Z',
        role: 'user',
        content: 'list the files',
      },
      {
        id: assistantMessageId,
        parentId: userMessageId,
        timestamp: '2026-05-20T10:00:02.000Z',
        // Distinct from the record line's `timestamp` on purpose: this is
        // the one field this fixture makes differ at the two levels, so the
        // projected row's `message_created_at` (below) can pin the reader's
        // envelope-first precedence instead of the two levels being
        // byte-identical and unable to tell one read order from the other.
        messageTimestamp: '2026-05-20T10:00:09.000Z',
        role: 'assistant',
        content: [{ type: 'text', text: 'here they are' }],
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        api: 'anthropic-messages',
        stopReason: 'end_turn',
        usage: { input: 12, output: 7, cacheRead: 3, cacheWrite: 0 },
      },
    ],
  })

  // The fixture states the two-level shape; assert that before asserting
  // anything downstream of it. A flow that quietly wrote a flat record
  // would pass every assertion below against the pre-#543 reader too, which
  // is exactly the hole this flow exists to close.
  const staged = (await fs.readFile(fixture.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const assistantLine = staged.find((/** @type {any} */ r) => r.type === 'message' && r.id === assistantMessageId)
  expect.that(
    'fixture: the assistant record line states only id/message/parentId/timestamp/type',
    assistantLine === undefined ? undefined : Object.keys(assistantLine).sort().join(','),
    (v) => v === 'id,message,parentId,timestamp,type',
  )
  expect.that(
    'fixture: role/content/provider/usage are nested under the message key',
    assistantLine?.message,
    (v) => v !== undefined && v.role === 'assistant' && v.provider === 'anthropic' && v.usage !== undefined,
  )
  // The record line and the nested envelope state DIFFERENT timestamps here
  // on purpose, so the query assertion below can tell an envelope-first
  // read from a line-first one instead of the two levels being
  // byte-identical and unable to prove precedence either way.
  expect.that(
    'fixture: the assistant record states a different envelope timestamp than the line',
    assistantLine,
    (v) => v !== undefined
      && v.timestamp === '2026-05-20T10:00:02.000Z'
      && v.message?.timestamp === '2026-05-20T10:00:09.000Z',
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
        [Attr.SMOKE_STEP]: 'backfill_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(pluginDirs)
        if (loaded.length !== pluginDirs.length) {
          throw new Error(`backfill_openclaw_fixture: expected ${pluginDirs.length} manifests, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `backfill_openclaw_fixture: unsatisfied requirements: ${
              resolution.unsatisfied.map((u) => `${u.plugin}:${u.errorKind}`).join(', ')
            }`
          )
        }
        const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
        const entries = resolution.order
          .map((name) => byName.get(name))
          .filter((l) => l !== undefined)
          .map((l) => ({ manifest: l.manifest, rootDir: l.rootDir, config: {} }))
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
    // An explicit open-ended `--since` keeps the import window deterministic
    // regardless of when the smoke runs, matching the Claude/Codex flows.
    const since = '2000-01-01T00:00:00.000Z'

    // ----- 1. First backfill run -----
    const bf1out = makeBuf()
    const bf1err = makeBuf()
    const bf1code = await dispatch(
      ['backfill', 'openclaw', '--since', since, '--json'],
      { stdout: bf1out, stderr: bf1err, kernel, registry, env }
    )
    expect.that('dispatch: backfill openclaw (run 1) exited 0', bf1code, (v) => v === 0)
    expect.that('stderr: backfill run 1 had no errors', bf1err.text(), (v) => typeof v === 'string' && v.length === 0)

    const run1 = JSON.parse(bf1out.text())
    const openclaw1 = run1.providers.find((/** @type {any} */ p) => p.provider === 'openclaw')
    // #543 reported `status: ok` with `rows_written: 0`. An exit code and a
    // status token both said "done", so the row count is the only assertion
    // that could have caught it.
    expect.that(
      'backfill run 1: openclaw provider ok and wrote NON-ZERO rows (#543 reported ok with 0)',
      openclaw1,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written >= 2,
    )
    expect.that(
      'backfill run 1: at least one session scanned',
      openclaw1,
      (v) => v !== undefined && v.sessions_seen >= 1,
    )

    // ----- 2. Query the projected rows -----
    const sql = `
      select role, content_text, message_id, model, provider, conversation_source, client_name, message_created_at
      from ai_gateway_messages
      where session_id = '${sessionId}'
      order by message_index, part_index
    `.trim().replace(/\s+/g, ' ')

    const rows1 = await queryRows({ dispatch, sql, kernel, registry, env, expect, label: 'after run 1' })
    expect.that(
      'query: NON-ZERO rows for the backfilled session (the literal #543 regression)',
      rows1,
      (v) => Array.isArray(v) && v.length > 0,
    )
    expect.that('query: exactly two rows for the backfilled session', rows1, (v) => Array.isArray(v) && v.length === 2)

    const user = rows1.find((/** @type {any} */ r) => r.role === 'user')
    const assistant = rows1.find((/** @type {any} */ r) => r.role === 'assistant')
    expect.that(
      'query: user row carries the record line id + the envelope content',
      user,
      (v) => v !== undefined && v.message_id === userMessageId && v.content_text === 'list the files',
    )
    expect.that(
      'query: assistant row carries the record line id + the envelope content and model',
      assistant,
      (v) => v !== undefined
        && v.message_id === assistantMessageId
        && v.content_text === 'here they are'
        && v.model === 'claude-sonnet-4-5',
    )
    // The fixture states 10:00:02 on the record line and 10:00:09 on the
    // nested envelope (LLP 0158#decision). A line-first read, or the
    // pre-#552 flat read of `openclawMessageEnvelope`, would land on
    // 10:00:02; only an envelope-first read lands here.
    expect.that(
      'query: assistant row carries the envelope timestamp, not the record line one (envelope-first precedence)',
      assistant,
      (v) => v !== undefined && v.message_created_at === '2026-05-20T10:00:09.000Z',
    )
    // `provider` is the field the two-level read actually gates on: read off
    // the line it is absent, the allowlist resolves the record to `unknown`,
    // and the session is excluded fail-closed.
    expect.that(
      'query: every row tagged provider=anthropic, source=client_name=openclaw',
      rows1,
      (v) => Array.isArray(v) && v.every((r) => r.provider === 'anthropic' && r.conversation_source === 'openclaw' && r.client_name === 'openclaw'),
    )

    // ----- 3. Idempotent rerun: a fresh run id forces a committed-partition
    //          re-scan, so every re-materialized row is recognized and skipped.
    const bf2out = makeBuf()
    const bf2err = makeBuf()
    const bf2code = await dispatch(
      ['backfill', 'openclaw', '--since', since, '--json'],
      { stdout: bf2out, stderr: bf2err, kernel, registry, env: { ...env, DEV_RUN_ID: `${harness.devRunId}-rerun` } }
    )
    expect.that('dispatch: backfill openclaw (run 2) exited 0', bf2code, (v) => v === 0)
    const run2 = JSON.parse(bf2out.text())
    const openclaw2 = run2.providers.find((/** @type {any} */ p) => p.provider === 'openclaw')
    // `rows_written === 0` alone does not pin that the session was actually
    // re-read: a run that skipped the file entirely (e.g. an mtime-based
    // quiesce-window skip, LLP 0173 T12) would report the same zero and pass
    // just as well. Requiring `items_seen` and `rows_skipped` pins the
    // mechanism the comment claims: the file WAS seen and its rows WERE
    // recognized and skipped by part_id dedupe, not merely absent from the
    // scan.
    expect.that(
      'backfill run 2: rerun re-read the session and skipped its rows via dedupe (all part_ids already present)',
      openclaw2,
      (v) => v !== undefined
        && v.status === 'ok'
        && v.rows_written === 0
        && v.items_seen >= 1
        && v.rows_skipped >= 1,
    )

    const rows2 = await queryRows({ dispatch, sql, kernel, registry, env, expect, label: 'after run 2' })
    expect.that('query: rerun did not duplicate rows (still exactly two)', rows2, (v) => Array.isArray(v) && v.length === 2)

    // ----- 4. Internal telemetry: dev_run_id + provider + row counts -----
    await obs.shutdown()
    const traces = await expect.traces()

    const providerFinish = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.provider_finish' &&
        t.attributes?.provider === 'openclaw' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.provider_finish for openclaw under the run dev_run_id with rows_written>=2',
      providerFinish[0]?.attributes,
      (v) => v !== undefined && v.status === 'ok' && Number(v.rows_written) >= 2,
    )

    const writeSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.write' &&
        t.attributes?.[Attr.DATASET] === 'ai_gateway_messages' &&
        t.attributes?.provider === 'openclaw' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.write span for ai_gateway_messages with row_count>=2',
      writeSpans[0]?.attributes,
      (v) => v !== undefined && Number(v.row_count) >= 2,
    )

    const logs = await expect.logs()
    const finishLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'backfill.finish' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'logs: backfill.finish carries the run dev_run_id and total_rows_written>=2',
      finishLogs[0]?.attributes,
      (v) => v !== undefined && Number(v.total_rows_written) >= 2,
    )

    // The provider's own projection log, which names the identity source the
    // native-id path is supposed to take. A record read at the wrong level
    // never reaches it at all.
    const projected = logs.filter(
      (/** @type {any} */ l) => l.body === 'openclaw.backfill.session_projected',
    )
    expect.that(
      'logs: openclaw.backfill.session_projected with native identity and both messages',
      projected[0]?.attributes,
      (v) => v !== undefined && v.identity_source === 'native' && Number(v.message_count) >= 2,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/**
 * Run a `query sql ... --format json` dispatch and return the parsed
 * rows, asserting a clean exit and parseable output.
 *
 * @param {{ dispatch: any, sql: string, kernel: any, registry: any, env: any, expect: any, label: string }} args
 * @returns {Promise<any[]>}
 */
async function queryRows(args) {
  const { dispatch, sql, kernel, registry, env, expect, label } = args
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
