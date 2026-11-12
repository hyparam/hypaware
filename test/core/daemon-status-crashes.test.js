// @ts-check

// A crashed processing child restarts in about a second, so `hyp daemon
// status` must say it crashed, or a crash loop reads as a healthy daemon.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runDaemonStatus } from '../../src/core/commands/daemon.js'

/** @param {Record<string, unknown>} processing */
async function statusText(processing) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-daemon-status-crashes-'))
  try {
    const runDir = path.join(hypHome, 'hypaware', 'run')
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({
      state: 'healthy',
      pid: 4321,
      startedAt: '2026-11-11T00:00:00.000Z',
      healthyAt: '2026-11-11T00:00:01.000Z',
      uptimeMs: 1000,
      sources: [],
      sinks: [],
      processes: { gateway: { pid: 4321, state: 'healthy' }, processing },
    }))
    let out = ''
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome },
      stdout: { write: (/** @type {string} */ chunk) => { out += chunk; return true } },
      stderr: { write: () => true },
      argv: [],
    })
    await runDaemonStatus([], ctx)
    return out
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
}

test('hyp daemon status names the crash count and the last exit signal', async () => {
  const out = await statusText({ pid: 4322, state: 'healthy', restarts: 3, lastExit: { code: null, signal: 'SIGABRT', at: '2026-11-11T10:33:00.000Z' } })
  assert.match(out, /crashes:\s+3, last SIGABRT at 2026-11-11T10:33:00.000Z/)
})

test('an exit code is shown when the child exited without a signal', async () => {
  const out = await statusText({ pid: 4322, state: 'healthy', restarts: 1, lastExit: { code: 1, signal: null, at: '2026-11-11T10:33:00.000Z' } })
  assert.match(out, /crashes:\s+1, last code 1 at /)
})

test('a child that never crashed prints no crash line', async () => {
  const out = await statusText({ pid: 4322, state: 'healthy', restarts: 0 })
  assert.doesNotMatch(out, /crashes:/)
})

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATEWAY_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'daemon', 'gateway.js')).href

// Through a real gateway: a requested restart is not a crash, a killed child
// is. The daemon runs outside the test runner, as gateway-stop-deadline does,
// because its forked child inherits stdout (#1527).
test('a requested processing restart is not a crash, a killed child is', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-daemon-crash-record-'))
  try {
    const configPath = path.join(hypHome, 'hypaware-config.json')
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      auto_update: false,
      plugins: [{
        name: '@hypaware/ai-gateway',
        config: { listen: '127.0.0.1:0', upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }] },
      }],
    }))
    const resultPath = path.join(hypHome, 'result.json')
    const scriptPath = path.join(hypHome, 'crash-record.mjs')
    const errPath = path.join(hypHome, 'crash-record.err')
    const daemonOpts = { hypHome, configPath, runId: 'daemon-crash-record-test', tickIntervalMs: 0, installSignalHandlers: false }
    writeFileSync(scriptPath, [
      `import { runGatewayDaemon } from ${JSON.stringify(GATEWAY_URL)}`,
      "import fs from 'node:fs'",
      `const handle = await runGatewayDaemon({ ...${JSON.stringify(daemonOpts)}, env: { ...process.env } })`,
      'const processing = () => ({ ...handle.snapshot().processes?.processing })',
      'const replaced = async (pid) => {',
      '  const deadline = Date.now() + 30_000',
      "  while (processing().state !== 'healthy' || processing().pid === pid) {",
      "    if (Date.now() > deadline) throw new Error('processing child was not replaced')",
      '    await new Promise(resolve => setTimeout(resolve, 50))',
      '  }',
      '}',
      'await replaced(undefined)',
      'const first = processing().pid',
      'await handle.restartProcessing()',
      'await replaced(first)',
      'const afterRequested = processing()',
      "process.kill(afterRequested.pid, 'SIGKILL')",
      'await replaced(afterRequested.pid)',
      'const afterKill = processing()',
      'await handle.stop()',
      'await handle.done',
      `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ afterRequested, afterKill }))`,
      'process.exit(0)',
      '',
    ].join('\n'))
    const errFd = openSync(errPath, 'w')
    let run
    try {
      run = spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome },
        stdio: ['ignore', 'ignore', errFd],
        timeout: 90_000,
      })
    } finally {
      closeSync(errFd)
    }
    const stderr = readFileSync(errPath, 'utf8')
    assert.equal(run.signal, null, stderr)
    assert.equal(run.status, 0, stderr)
    const { afterRequested, afterKill } = JSON.parse(readFileSync(resultPath, 'utf8'))

    assert.equal(afterRequested.restarts, 0, 'a requested restart was counted as a crash')
    assert.equal(afterRequested.lastExit, undefined)
    assert.equal(afterKill.restarts, 1)
    assert.ok(afterKill.lastExit && typeof afterKill.lastExit.at === 'string')
    // Windows reports a killed child by exit code, not by signal.
    if (process.platform !== 'win32') assert.equal(afterKill.lastExit.signal, 'SIGKILL')

    const log = (await fs.readFile(path.join(hypHome, 'hypaware', 'logs', 'daemon.log'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'processing.exited')
    assert.deepEqual(log.map(row => row.level), ['warn', 'error', 'warn'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
