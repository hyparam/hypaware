// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { setGithubRuntime } from '../../hypaware-core/plugins-workspace/github/src/runtime.js'
import { BACKLOG_RETRY_MS, nextCaptureDelay, startGithubSource } from '../../hypaware-core/plugins-workspace/github/src/source.js'
import { fakeClient } from './github-fake-client.js'

test('unfinished work resumes on the bounded backlog cadence', () => {
  assert.equal(nextCaptureDelay(24 * 60 * 60_000, true), BACKLOG_RETRY_MS)
  assert.equal(nextCaptureDelay(5 * 60_000, true), 5 * 60_000)
  assert.equal(nextCaptureDelay(24 * 60 * 60_000, false), 24 * 60 * 60_000)
})

test('source runs shortly after boot and reports structured completion-relative cadence', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-source-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  /** @type {Array<{ name: string, attrs: Record<string, unknown> }>} */
  const logs = []

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    config: {
      ignore: [],
      token_env: 'GITHUB_TOKEN',
      poll_interval: '10ms',
      inventory: 'session_repos',
    },
    observedRepos: { async list() { return [] } },
    clientFactory: () => fakeClient({}),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() { throw new Error('empty inventory must not append') },
    },
    log: {
      info(name, attrs) { logs.push({ name, attrs }) },
      error(name, attrs) { logs.push({ name, attrs }) },
    },
  }))

  const source = await startGithubSource()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.ok(source.status)
  const status = await source.status()
  await source.stop()

  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_started'))
  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_completed'))
  assert.equal(status.state, 'ready')
  assert.equal(status.details?.cadence, '10ms')
  assert.equal(status.details?.inventory, 'session_repos')
  assert.equal(typeof status.details?.next_tick_at, 'string')
  assert.ok(logs.every((entry) => !JSON.stringify(entry).includes('GITHUB_TOKEN')))
  assert.ok(logs.some((entry) => entry.name === 'github.poll_tick_completed'
    && entry.attrs.operation === 'poll'
    && entry.attrs.repos === 0
    && entry.attrs.events === 0))
})

test('source never overlaps slow ticks', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypaware-github-no-overlap-'))
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }))
  let active = 0
  let maxActive = 0
  let scans = 0
  /** @type {() => void} */
  let noteSecondScan = () => {}
  const secondScanStarted = new Promise((resolve) => {
    noteSecondScan = () => resolve(undefined)
  })

  setGithubRuntime(/** @type {any} */ ({
    stateDir,
    config: {
      ignore: [],
      token_env: 'GITHUB_TOKEN',
      poll_interval: '5ms',
      inventory: 'session_repos',
    },
    observedRepos: {
      async list() {
        scans += 1
        if (scans === 2) noteSecondScan()
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
        return []
      },
    },
    clientFactory: () => fakeClient({}),
    storage: {
      cacheTablePath() { return '/cache/github_events' },
      async appendRows() {},
    },
    log: { info() {}, error() {} },
  }))

  const source = await startGithubSource()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout
  try {
    await Promise.race([
      secondScanStarted,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('second GitHub scan did not start')), 1000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  await source.stop()

  assert.ok(scans >= 2)
  assert.equal(maxActive, 1)
})
