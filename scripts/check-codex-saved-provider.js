// @ts-check

// Optional installed-binary acceptance check:
// node scripts/check-codex-saved-provider.js /absolute/path/to/codex
// Uses synthetic saved history and no credentials or turn/start requests.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { isolatedClientEnv } from '../hypaware-core/smoke/lib/isolation.js'
import { detach } from '../hypaware-core/plugins-workspace/codex/src/settings.js'

const binary = process.argv[2] ?? 'codex'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-resume-'))
const home = path.join(root, 'home')
const cwd = path.join(root, 'workspace')
// Allowlist instead of inheriting API keys, auth overrides, proxies or client paths.
const env = isolatedClientEnv({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, home)
env.CODEX_HOME = path.join(home, '.codex')
env.TMPDIR = path.join(root, 'tmp')
const sessionId = randomUUID()
const timestamp = '2026-09-24T10:00:00.000Z'
const sessions = path.join(env.CODEX_HOME, 'sessions', '2026', '09', '24')
const configPath = path.join(env.CODEX_HOME, 'config.toml')
let step = 'fixture'
try {
  await Promise.all([cwd, sessions, env.TMPDIR].map(dir => fs.mkdir(dir, { recursive: true })))
  const records = [
    { type: 'session_meta', payload: {
      id: sessionId, timestamp, cwd, originator: 'codex-tui', cli_version: '0.149.1',
      source: 'cli', model_provider: 'hypaware', base_instructions: { text: 'Synthetic resume fixture.' },
    } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: randomUUID() } },
    { type: 'event_msg', payload: {
      type: 'user_message', message: 'Synthetic saved message.', images: [], local_images: [], text_elements: [],
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic saved message.' }],
    } },
  ]
  await fs.writeFile(path.join(sessions, `rollout-2026-09-24T10-00-00-${sessionId}.jsonl`),
    records.map(record => JSON.stringify({ timestamp, ...record })).join('\n') + '\n')
  const original = 'cli_auth_credentials_store = "file"\nmodel_provider = "custom"\nmodel_providers = { custom = { name = "Private", wire_api = "responses", base_url = "http://127.0.0.1:1/v1" } }\n'
  await fs.writeFile(configPath, original)

  step = 'missing_provider'
  await withServer(async request => {
    const response = await request('thread/resume', { threadId: sessionId })
    assert.match(response.error?.message ?? '', /provider.*hypaware.*not found/i)
  })
  report(step)

  step = 'repair'
  assert.equal((await detach({ configPath })).changed, true)
  const repaired = await fs.readFile(configPath, 'utf8')
  assert.match(repaired, /model_providers.custom = \{ name = "Private"/)
  assert.equal((await detach({ configPath })).changed, false)
  report(step)

  step = 'resume_and_default'
  await withServer(async request => {
    const resumed = await request('thread/resume', { threadId: sessionId })
    assert.equal(resumed.error, undefined, JSON.stringify(resumed.error))
    assert.equal(resumed.result.modelProvider, 'hypaware')
    assert.equal(resumed.result.thread.id, sessionId)
    assert.match(JSON.stringify(resumed.result.thread.turns), /Synthetic saved message/)
    const fresh = await request('thread/start', { cwd, ephemeral: true })
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.equal(fresh.result.modelProvider, 'custom')
  })
  report(step)
} catch (error) {
  console.error(JSON.stringify({ check: 'codex_saved_provider', binary, step, status: 'failed' }))
  throw error
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

/** @param {string} step */
function report(step) {
  console.log(JSON.stringify({ check: 'codex_saved_provider', binary, step, status: 'ok' }))
}

/**
 * Each server gets a fresh config load. Bound pending requests, diagnostics and
 * process lifetime; never initiate a turn or accept server tool requests.
 * @param {(request: (method: string, params: object) => Promise<any>) => Promise<void>} check
 */
async function withServer(check) {
  const child = spawn(binary, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise(resolve => child.once('close', resolve))
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192) })
  let id = 0
  /** @type {{ id: number, resolve: (response: any) => void, reject: (error: Error) => void } | undefined} */
  let pending
  child.on('error', error => pending?.reject(error))
  child.on('exit', code => pending?.reject(new Error(`app-server exited ${code}: ${stderr}`)))
  lines.on('line', line => {
    try {
      const response = JSON.parse(line)
      if (response.method && response.id !== undefined) {
        pending?.reject(new Error(`unexpected server request: ${response.method}`))
      } else if (response.id === pending?.id) pending?.resolve(response)
    } catch (error) {
      pending?.reject(new Error(`invalid app-server response: ${error}`))
    }
  })
  /** @param {string} method @param {object} params */
  async function request(method, params) {
    let timer
    try {
      return await new Promise((resolve, reject) => {
        pending = { id: ++id, resolve, reject }
        timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 30_000)
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    } finally {
      clearTimeout(timer)
      pending = undefined
    }
  }
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'hypaware_saved_provider_check', version: '1' },
      capabilities: { experimentalApi: true },
    })
    assert.equal(initialized.error, undefined, JSON.stringify(initialized.error))
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    await check(request)
  } finally {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    await closed.finally(() => clearTimeout(timer))
    lines.close()
  }
}
