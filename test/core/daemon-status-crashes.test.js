// @ts-check

// A crashed processing child restarts in about a second, so `hyp daemon
// status` must say it crashed, or a crash loop reads as a healthy daemon.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

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
