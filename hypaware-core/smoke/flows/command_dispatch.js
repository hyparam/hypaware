// @ts-check

import { installObservability } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Phase 3 smoke. Boots the kernel CLI dispatcher with the default core
 * command set (no plugin contributions in Phase 3) and runs three
 * built-in commands. Asserts the §Phase 3 contract:
 *
 * - traces: exactly one `command.run` root span per invocation with
 *   `status=ok`, `exit_code=0`, and matching `command_name`
 * - traces: the `command.run` for `query schema logs` is followed by a
 *   `query.resolve_tables` child span carrying `hyp_dataset=logs`
 * - logs: a `cli.help_rendered` record fires when help is requested,
 *   tagged with the current command count
 * - metrics: `hyp_command_runs_total` records each invocation,
 *   `hyp_command_duration_ms` is a histogram with one observation per
 *   invocation
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'command_dispatch: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const stdout = makeBuf()
  const stderr = makeBuf()

  // Three command invocations exactly as named in the Phase 3 plan
  // smoke contract. Each one boots through the dispatcher; the
  // dispatcher's `installObservability()` call shares state with this
  // flow's call, so spans land in the harness's tmp telemetry dir.
  const statusCode = await dispatch(['status'], { stdout, stderr })
  expect.that('dispatch: status exited 0', statusCode, (v) => v === 0)

  const schemaCode = await dispatch(['query', 'schema', 'logs'], { stdout, stderr })
  expect.that('dispatch: query schema logs exited 0', schemaCode, (v) => v === 0)

  const listCode = await dispatch(['plugin', 'list', '--json'], { stdout, stderr })
  expect.that('dispatch: plugin list --json exited 0', listCode, (v) => v === 0)

  // Help path — verifies `cli.help_rendered` log + command_count.
  const helpCode = await dispatch(['--help'], { stdout, stderr })
  expect.that('dispatch: --help exited 0', helpCode, (v) => v === 0)

  // plugin list --json must produce valid JSON on stdout.
  const pluginListJson = stdout.findJsonObject((obj) => Array.isArray(obj?.plugins))
  expect.that(
    'stdout: plugin list --json emitted a JSON object with a plugins array',
    pluginListJson,
    (v) => v !== undefined
  )

  await obs.shutdown()

  const traces = await expect.traces()
  const logs = await expect.logs()
  const metrics = await expect.metrics()

  const commandRuns = traces.filter((t) => t.name === 'command.run')
  expect.that(
    'traces: exactly four command.run spans (status, query schema, plugin list, help)',
    commandRuns,
    (rows) => rows.length === 4
  )

  /** @type {Map<string, any>} */
  const byCmd = new Map()
  for (const span of commandRuns) {
    const cmd = span.attributes?.command_name
    if (typeof cmd === 'string') byCmd.set(cmd, span)
  }

  for (const cmd of ['status', 'query schema', 'plugin list', 'help']) {
    const span = byCmd.get(cmd)
    expect.that(`traces: command.run span exists for '${cmd}'`, !!span, (v) => v === true)
    expect.that(
      `traces: command.run for '${cmd}' has status=ok attribute`,
      span?.attributes?.status,
      (v) => v === 'ok'
    )
    expect.that(
      `traces: command.run for '${cmd}' has span.status=ok`,
      span?.status,
      (v) => v === 'ok'
    )
    expect.that(
      `traces: command.run for '${cmd}' has exit_code=0`,
      span?.attributes?.exit_code,
      (v) => v === 0
    )
    expect.that(
      `traces: command.run for '${cmd}' is a root span (no parentSpanId)`,
      span?.parentSpanId,
      (v) => v === null
    )
    expect.that(
      `traces: command.run for '${cmd}' carries dev_run_id=${harness.devRunId}`,
      span?.attributes?.dev_run_id,
      (v) => v === harness.devRunId
    )
  }

  const querySchemaSpan = byCmd.get('query schema')
  const resolveTables = traces.filter(
    (t) =>
      t.name === 'query.resolve_tables' &&
      t.parentSpanId === querySchemaSpan?.spanId
  )
  expect.that(
    'traces: command.run for query schema is followed by exactly one query.resolve_tables child',
    resolveTables,
    (rows) => rows.length === 1
  )
  expect.that(
    'traces: query.resolve_tables has hyp_dataset=logs',
    resolveTables[0]?.attributes?.hyp_dataset,
    (v) => v === 'logs'
  )
  expect.that(
    'traces: query.resolve_tables has status=ok',
    resolveTables[0]?.status,
    (v) => v === 'ok'
  )

  const helpRendered = logs.filter(
    (l) =>
      l.body === 'cli.help_rendered' &&
      l.attributes?.hyp_component === 'cmd-dispatch'
  )
  expect.that(
    'logs: cli.help_rendered emitted (at least once for --help)',
    helpRendered,
    (rows) => rows.length >= 1
  )
  expect.that(
    'logs: cli.help_rendered records command_count > 0',
    helpRendered[0]?.attributes?.command_count,
    (v) => typeof v === 'number' && v > 0
  )

  const runsTotal = metrics.filter((m) => m.name === 'hyp_command_runs_total')
  expect.that(
    'metrics: hyp_command_runs_total emitted at least once',
    runsTotal,
    (rows) => rows.length >= 1
  )
  const seenCommands = new Set(runsTotal.map((m) => m.attributes?.command).filter(Boolean))
  for (const cmd of ['status', 'query schema', 'plugin list']) {
    expect.that(
      `metrics: hyp_command_runs_total has a data point for '${cmd}'`,
      seenCommands.has(cmd),
      (v) => v === true
    )
  }

  const duration = metrics.filter((m) => m.name === 'hyp_command_duration_ms')
  expect.that(
    'metrics: hyp_command_duration_ms emitted at least once',
    duration,
    (rows) => rows.length >= 1
  )
}

/**
 * Tiny WriteStream that captures chunks for later inspection. JSON
 * outputs land on a single stdout.write call but we tolerate
 * fragmentation by concatenating before parsing.
 */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
    /**
     * Find the first JSON object in the captured stream that satisfies
     * `predicate`. Returns undefined if nothing matches. JSON objects
     * are expected to be pretty-printed (matching `JSON.stringify(obj, null, 2)`)
     * so we look for the first `{...}` block.
     *
     * @param {(value: any) => boolean} predicate
     */
    findJsonObject(predicate) {
      const text = chunks.join('')
      let depth = 0
      let start = -1
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '{') {
          if (depth === 0) start = i
          depth += 1
        } else if (ch === '}') {
          depth -= 1
          if (depth === 0 && start !== -1) {
            const slice = text.slice(start, i + 1)
            try {
              const parsed = JSON.parse(slice)
              if (predicate(parsed)) return parsed
            } catch {
              /* keep scanning */
            }
            start = -1
          }
        }
      }
      return undefined
    },
  }
}
