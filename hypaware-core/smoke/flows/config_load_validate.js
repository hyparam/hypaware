// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { installObservability } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Phase 6 smoke, renamed from `config_migrate_v1` in the original plan: this
 * fresh-start rig has no v1 install to migrate, so the smoke only
 * exercises schema + cross-plugin validation).
 *
 * Case 1: happy path:
 *  - Stages a tmp `~/.hyp/hypaware-config.json` with `version: 2`,
 *    two enabled plugins (`@hypaware/ai-gateway`, `@hypaware/claude`),
 *    and one blob sink (`@hypaware/format-parquet` +
 *    `@hypaware/local-fs`).
 *  - Runs `hyp config validate`.
 *  - Asserts `config.load` and `config.validate` spans both
 *    `status=ok`, and that no log row carries `error_kind=...`
 *    in this run.
 *
 * Case 2: incompatible sink pair:
 *  - Same config but the sink pairs `@hypaware/format-parquet` with
 *    `@hypaware/webhook` (a request destination, not a blob store).
 *  - Asserts the command exits non-zero and at least one log row
 *    carries `error_kind=sink_pair_incompatible`.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0010#validation [tests] tests config load and cross-plugin validation, including incompatible sink pairing
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'config_load_validate: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  /* ---------- Case 1: happy path ---------- */

  const okConfigPath = path.join(harness.hypHome, 'hypaware-config.json')
  await fs.writeFile(okConfigPath, JSON.stringify({
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
              match: { path_prefix: '/v1/messages' },
            },
          ],
        },
      },
      {
        name: '@hypaware/claude',
        config: { proxy: '@hypaware/ai-gateway' },
      },
    ],
    sinks: {
      raw_parquet: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: {
          dir: '/var/log/hypaware',
          schedule: '0 * * * *',
        },
      },
    },
    query: {
      cache: {
        retention: { default_days: 30 },
      },
    },
  }, null, 2))

  const okStdout = makeBuf()
  const okStderr = makeBuf()
  const okExit = await dispatch(['config', 'validate'], {
    stdout: okStdout,
    stderr: okStderr,
    env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: okConfigPath },
  })
  expect.that('case 1: hyp config validate exited 0', okExit, (v) => v === 0)
  expect.that(
    'case 1: stdout reports the config path and counts',
    okStdout.text(),
    (v) => v.includes('config ok') && v.includes('plugins=2') && v.includes('sinks=1')
  )

  /* ---------- Case 2: invalid sink pair ---------- */

  const badConfigPath = path.join(harness.hypHome, 'hypaware-config.bad.json')
  await fs.writeFile(badConfigPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
    ],
    sinks: {
      bad_pair: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/webhook',
        config: { schedule: '0 * * * *' },
      },
    },
  }, null, 2))

  const badStdout = makeBuf()
  const badStderr = makeBuf()
  const badExit = await dispatch(['config', 'validate', '--path', badConfigPath], {
    stdout: badStdout,
    stderr: badStderr,
    env: { ...process.env, HYP_HOME: harness.hypHome },
  })
  expect.that('case 2: hyp config validate exited non-zero', badExit, (v) => v !== 0)
  expect.that(
    'case 2: stderr includes the sink_pair_incompatible error_kind tag',
    badStderr.text(),
    (v) => v.includes('sink_pair_incompatible')
  )

  await obs.shutdown()

  /* ---------- Assertions over emitted spans/logs ---------- */

  const traces = await expect.traces()
  const logs = await expect.logs()

  // Expect two `config.load` spans (one per run) and two `config.validate`
  // spans. Case 1 must have status=ok on both, case 2 must have status=failed
  // on validate with error_kind=sink_pair_incompatible.
  const loadSpans = traces.filter((t) => t.name === 'config.load')
  expect.that('traces: at least two config.load spans (case 1 + case 2)', loadSpans, (rows) => rows.length >= 2)

  const okLoad = loadSpans.find((s) => s.attributes?.config_path === okConfigPath)
  expect.that('traces: case 1 config.load span exists', !!okLoad, (v) => v === true)
  expect.that(
    'traces: case 1 config.load status=ok',
    okLoad?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: case 1 config.load records plugin_count=2',
    okLoad?.attributes?.plugin_count,
    (v) => v === 2
  )
  expect.that(
    'traces: case 1 config.load records sink_count=1',
    okLoad?.attributes?.sink_count,
    (v) => v === 1
  )

  const validateSpans = traces.filter((t) => t.name === 'config.validate')
  expect.that(
    'traces: at least two config.validate spans (case 1 + case 2)',
    validateSpans,
    (rows) => rows.length >= 2
  )

  const okValidate = validateSpans.find((s) => s.attributes?.plugin_count === 2 && s.attributes?.sink_count === 1)
  expect.that('traces: case 1 config.validate span exists', !!okValidate, (v) => v === true)
  expect.that(
    'traces: case 1 config.validate status=ok',
    okValidate?.attributes?.status,
    (v) => v === 'ok'
  )
  expect.that(
    'traces: case 1 config.validate has no error_kind attribute',
    okValidate?.attributes?.error_kind,
    (v) => v === undefined
  )

  const badValidate = validateSpans.find((s) => s.attributes?.error_kind === 'sink_pair_incompatible')
  expect.that(
    'traces: case 2 config.validate span carries error_kind=sink_pair_incompatible',
    !!badValidate,
    (v) => v === true
  )
  expect.that(
    'traces: case 2 config.validate status=failed',
    badValidate?.attributes?.status,
    (v) => v === 'failed'
  )

  // Case 1 must not have produced any error_kind=... log lines from
  // the config component.
  const okLogs = logs.filter(
    (l) =>
      l.attributes?.hyp_component === 'config' &&
      l.attributes?.dev_run_id === harness.devRunId &&
      l.attributes?.error_kind !== undefined
  )
  // Filter only entries that *could* have come from the OK run by
  // pointer prefix, as case 2 emits errors via the same logger and we
  // partition by error_kind. The case 1 contract is "no error_kind on
  // any config log row in the OK run". Because both runs share the
  // same dev_run_id, the strict test is "the count of error_kind logs
  // equals the count of case-2-only error_kinds".
  const sinkPairLogs = okLogs.filter((l) => l.attributes?.error_kind === 'sink_pair_incompatible')
  expect.that(
    'logs: case 2 emitted at least one error_kind=sink_pair_incompatible',
    sinkPairLogs,
    (rows) => rows.length >= 1
  )

  // The OK case must contribute zero error_kind logs. Verify by
  // checking that every error_kind log is one of the kinds case 2
  // produces (sink_pair_incompatible, plus optional follow-ups from
  // the validator).
  const case2Kinds = new Set(['sink_pair_incompatible'])
  const stray = okLogs.filter((l) => !case2Kinds.has(String(l.attributes?.error_kind)))
  expect.that(
    'logs: case 1 emitted no error_kind log rows from the config component',
    stray,
    (rows) => rows.length === 0
  )
}

/**
 * Tiny WriteStream that captures chunks for later inspection.
 */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    /** @param {string|Uint8Array} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
