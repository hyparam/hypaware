// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import {
  runPickerWalkthrough,
  WALKTHROUGH_CANCEL_EXIT_CODE,
} from '../../src/core/cli/walkthrough.js'
import {
  installObservability,
  readObservabilityEnv,
} from '../../src/core/observability/index.js'
import { devTelemetryDir } from '../../src/core/observability/env.js'

/**
 * Build a PassThrough pair that satisfies the TUI runtime's `isTTY` and
 * `setRawMode` checks. The runtime never queries any other TTY API, so
 * the polyfill is intentionally tiny.
 */
function makeFakeTty() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.defineProperty(stdin, 'isTTY', { value: true })
  Object.defineProperty(stdout, 'isTTY', { value: true })
  // @ts-expect-error: PassThrough does not declare setRawMode but the runtime probes for it.
  stdin.setRawMode = () => {}
  /** @type {string[]} */
  const writes = []
  stdout.on('data', (chunk) => writes.push(String(chunk)))
  return { stdin, stdout, output: () => writes.join('') }
}

/**
 * @param {PassThrough} stdin
 * @param {string[]} chunks
 */
async function feed(stdin, chunks) {
  for (const c of chunks) {
    stdin.write(c)
    await new Promise((r) => setImmediate(r))
  }
}

/** Settle several microtask + immediate ticks so the next prompt has
 * a chance to attach its keypress listener before the next chunk lands.
 */
async function settle(ticks = 5) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

test('runPickerWalkthrough drives the TUI multiselect end-to-end when stdin+stdout are TTYs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-walkthrough-tui-happy-'))
  const io = makeFakeTty()
  const stderr = makeBuf()

  // Force NO_COLOR so the rendered frames stay simple and the runtime's
  // ANSI color escapes don't clutter the assertion on output.
  const prevNoColor = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
  // Ensure HYP_NO_TUI is unset so the router picks TUI.
  const prevNoTui = process.env.HYP_NO_TUI
  delete process.env.HYP_NO_TUI

  try {
    const promise = runPickerWalkthrough({
      capabilities: /** @type {any} */ ({}),
      stdout: io.stdout,
      stderr,
      stdin: io.stdin,
      // Stub detection: the default detector probes machine-global paths
      // (e.g. /Applications/Claude.app), which would pre-check rows and
      // change the picks depending on the host running the test.
      detect: async () => new Set(),
      env: {
        HOME: tmp,
        HYP_HOME: path.join(tmp, '.hyp'),
      },
    })

    // Sources prompt (PICKER_SOURCES: claude, codex, raw-anthropic,
    // raw-openai, otel). Move down twice to land on raw-anthropic,
    // toggle, then enter.
    await settle()
    await feed(io.stdin, ['\x1b[B', '\x1b[B', ' ', '\r'])

    // No export prompt: the picker always defaults to local-parquet now.
    // Retention prompt: empty buffer + enter accepts the 30-day default.
    await settle()
    await feed(io.stdin, ['\r'])

    const result = await promise
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.sourcesPicked, ['raw-anthropic'])
    assert.equal(result.exportPicked, 'local-parquet')
    assert.equal(result.retentionDays, 30)
    assert.deepEqual(result.clientsPicked, [])

    // The config file landed at HYP_HOME and carries the local-parquet
    // sink that the default export pre-check produced.
    const configRaw = await fs.readFile(result.configPath, 'utf8')
    const config = JSON.parse(configRaw)
    assert.equal(config.version, 2)
    assert.equal(config.sinks?.local?.destination, '@hypaware/local-fs')
    assert.equal(config.sinks?.local?.writer, '@hypaware/format-parquet')
    // Wire-through evidence: the TUI rendered the source list at least once.
    assert.match(io.output(), /capture raw Anthropic API traffic/)
  } finally {
    if (prevNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prevNoColor
    if (prevNoTui === undefined) delete process.env.HYP_NO_TUI
    else process.env.HYP_NO_TUI = prevNoTui
  }
})

test('runPickerWalkthrough returns a deterministic cancel exit code when the user cancels at the source prompt', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-walkthrough-cancel-'))
  const io = makeFakeTty()
  const stderr = makeBuf()
  const env = {
    HOME: tmp,
    HYP_HOME: path.join(tmp, '.hyp'),
    HYP_DEV_TELEMETRY: '1',
    DEV_RUN_ID: 'walkthrough-tui-cancel-test',
  }
  const obsEnv = readObservabilityEnv(env)
  const obs = installObservability({ env: obsEnv })

  const prevNoColor = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
  const prevNoTui = process.env.HYP_NO_TUI
  delete process.env.HYP_NO_TUI

  try {
    const promise = runPickerWalkthrough({
      capabilities: /** @type {any} */ ({}),
      stdout: io.stdout,
      stderr,
      stdin: io.stdin,
      env,
    })

    // ctrl+c at the first prompt cancels the walkthrough.
    await settle()
    await feed(io.stdin, ['\x03'])

    const result = await promise
    assert.equal(result.exitCode, WALKTHROUGH_CANCEL_EXIT_CODE)
    assert.equal(result.exitCode, 130)
    assert.match(stderr.text(), /hyp init: cancelled/)

    await obs.shutdown()
    const traces = await readJsonl(path.join(devTelemetryDir(obsEnv.stateDir), `traces-${process.pid}.jsonl`))
    const finish = traces.find((record) => (
      record.name === 'walkthrough.finish' &&
      record.attributes?.status === 'cancelled'
    ))
    assert.ok(finish, 'cancelled walkthrough.finish span not emitted')
    assert.equal(finish.attributes.exit_code, WALKTHROUGH_CANCEL_EXIT_CODE)
  } finally {
    await obs.shutdown()
    if (prevNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prevNoColor
    if (prevNoTui === undefined) delete process.env.HYP_NO_TUI
    else process.env.HYP_NO_TUI = prevNoTui
  }
})

test('runPickerWalkthrough falls back to the legacy numbered prompt under HYP_NO_TUI=1', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-walkthrough-tui-fallback-'))
  const input = new PassThrough()
  // Mark BOTH ends as TTYs so the only signal that flips the router is
  // the HYP_NO_TUI escape. This proves the env override wins over the
  // TTY probe. Answers: source '3' (raw-anthropic), then retention
  // default: the export question is no longer asked.
  Object.defineProperty(input, 'isTTY', { value: true })
  const stdout = answerDrivenOutput(input, ['3\n', '\n'], true)
  const stderr = makeBuf()

  // HYP_NO_TUI flows through opts.env: the same channel real callers
  // use. So this test also exercises the env-threading contract.
  const result = await runPickerWalkthrough({
    capabilities: /** @type {any} */ ({}),
    stdout,
    stderr,
    stdin: /** @type {any} */ (input),
    env: {
      HOME: tmp,
      HYP_HOME: path.join(tmp, '.hyp'),
      HYP_NO_TUI: '1',
    },
  })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.sourcesPicked, ['raw-anthropic'])
  assert.equal(result.exportPicked, 'local-parquet')
  // The legacy prompt prints the numbered-list signature.
  assert.match(stdout.text(), /select \(e\.g\. 1,3 or "all"\):/)
})

/**
 * @param {PassThrough} input
 * @param {string[]} answers
 * @param {boolean} [withIsTty]
 */
function answerDrivenOutput(input, answers, withIsTty = false) {
  let value = ''
  const sink = {
    write(chunk) {
      const text = String(chunk)
      value += text
      if (text.includes('select (e.g. 1,3 or "all"): ') || text.includes('Cache retention (days)')) {
        const answer = answers.shift()
        if (answer !== undefined) input.write(answer)
        if (answers.length === 0) input.end()
      }
    },
    text() {
      return value
    },
  }
  if (withIsTty) {
    Object.defineProperty(sink, 'isTTY', { value: true })
  }
  return sink
}

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
    },
    text() {
      return value
    },
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<Record<string, any>[]>}
 */
async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
