// @ts-check

// Optional installed-binary acceptance check:
// node scripts/check-codex-saved-provider.js /absolute/path/to/codex
// Uses synthetic saved history. Follow-up inference goes only to a local
// Responses fixture with a synthetic API key, never a real provider.
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isolatedClientEnv } from '../hypaware-core/smoke/lib/isolation.js'
import { withCodexServer } from '../hypaware-core/plugins-workspace/codex/src/app_server.js'
import { createAutomaticCodexProviderRepair, repairCodexProviders, readCodexRepairConfig } from '../hypaware-core/plugins-workspace/codex/src/provider_repair.js'
import { detach } from '../hypaware-core/plugins-workspace/codex/src/settings.js'

/** @import { AddressInfo } from 'node:net' */

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
    assert.match(response.error?.message ?? '', /provider.*hypaware.*(?:not found|no longer configured)/i)
  })
  report(step)

  step = 'repair'
  assert.equal((await detach({ configPath })).changed, true)
  const repaired = await fs.readFile(configPath, 'utf8')
  assert.match(repaired, /model_providers.custom = \{ name = "Private"/)
  assert.equal((await detach({ configPath })).changed, false)
  report(step)

  step = 'resume_and_default'
  let needsScopedProvider = false
  await withServer(async request => {
    const resumed = await request('thread/resume', { threadId: sessionId })
    if (resumed.error?.data?.type === 'modelProviderMismatch') {
      assert.equal(resumed.error.data.modelProvider, 'hypaware')
      assert.equal(resumed.error.data.currentModelProvider, 'custom')
      needsScopedProvider = true
    } else checkResumed(resumed)
    const fresh = await request('thread/start', { cwd, ephemeral: true })
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.equal(fresh.result.modelProvider, 'custom')
  })
  report(step)

  if (needsScopedProvider) {
    step = 'scoped_provider_resume'
    // Codex 0.166 validates saved and active provider IDs. A process-local
    // override satisfies that guard without rewriting history or config.
    await withServer(async request => {
      checkResumed(await request('thread/resume', { threadId: sessionId }))
    }, ['-c', 'model_provider="hypaware"'])
    assert.equal(await fs.readFile(configPath, 'utf8'), repaired)
    report(step)
  }

  step = 'automatic_upgrade_repair'
  // Only the synthetic fixture changes provider. Real custom-provider
  // configurations are refused by the command and never redirected.
  const nativeConfig = repaired.replace('model_provider = "custom"', 'model_provider = "openai"')
  await fs.writeFile(configPath, nativeConfig)
  const resolved = await readCodexRepairConfig({ codexHome: env.CODEX_HOME, binary, env, cwd })
  const stateDir = path.join(root, 'hyp-plugin-state')
  await createAutomaticCodexProviderRepair({
    codexHome: env.CODEX_HOME,
    stateDir, env, cwd,
  }, {
    // These processes have exited; the home contains no real customer data.
    // Other Codex instances on the host use different homes.
    assertStopped: async () => {},
    readConfig: async () => resolved,
  })(/** @type {any} */ ({ info() {}, warn() {} }))
  const result = JSON.parse(await fs.readFile(path.join(stateDir, 'codex-provider-repair.json'), 'utf8'))
  assert.equal(result.repaired_threads, 1)
  assert.equal(result.databases, 1, 'the real native metadata row must be repaired too')
  assert.ok(result.backup_path)
  assert.equal(await fs.readFile(configPath, 'utf8'), nativeConfig)
  report(step)

  step = 'repaired_native_resume'
  await withServer(async request => {
    checkResumed(await request('thread/resume', { threadId: sessionId }), 'openai')
    const fresh = await request('thread/start', { cwd, ephemeral: true })
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.equal(fresh.result.modelProvider, 'openai')
  })
  assert.equal((await repairCodexProviders({ codexHome: env.CODEX_HOME, sqliteHome: resolved.sqliteHome, assertStopped: async () => {} })).repaired_threads, 0)
  report(step)

  step = 'repaired_follow_up_turn'
  await checkFollowUp()
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

/** @param {any} resumed @param {string} [provider] */
function checkResumed(resumed, provider = 'hypaware') {
  assert.equal(resumed.error, undefined, JSON.stringify(resumed.error))
  assert.equal(resumed.result.modelProvider, provider)
  assert.equal(resumed.result.thread.id, sessionId)
  assert.match(JSON.stringify(resumed.result.thread.turns), /Synthetic saved message/)
}

/**
 * Each server gets a fresh config load. Bound pending requests, diagnostics and
 * process lifetime. History checks never initiate a turn or accept native
 * tool requests; checkFollowUp alone uses the local synthetic provider.
 * @param {(request: (method: string, params: object) => Promise<any>) => Promise<void>} check
 * @param {string[]} [overrides]
 */
async function withServer(check, overrides = []) {
  return withCodexServer(binary, { cwd, env, overrides }, check)
}

async function checkFollowUp() {
  let requests = 0
  const fixture = http.createServer((req, res) => {
    requests++
    req.resume()
    const message = { type: 'message', id: 'msg_synthetic_reply', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic follow-up succeeded.', annotations: [] }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'Synthetic follow-up succeeded.' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const port = /** @type {AddressInfo} */ (fixture.address()).port
  const notifications = []
  try {
    await withCodexServer(binary, {
      cwd, env: { ...env, OPENAI_API_KEY: 'sk-synthetic-local-fixture' },
      overrides: ['-c', `openai_base_url="http://127.0.0.1:${port}/v1"`],
      onNotification: notification => notifications.push(notification),
    }, async request => {
      checkResumed(await request('thread/resume', { threadId: sessionId }), 'openai')
      const turn = await request('turn/start', { threadId: sessionId, input: [{ type: 'text', text: 'Synthetic follow-up request.', text_elements: [] }] })
      assert.equal(turn.error, undefined, JSON.stringify(turn.error))
      for (let count = 0; count < 200 && !notifications.some(item => item.method === 'turn/completed'); count++) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const completed = notifications.find(item => item.method === 'turn/completed')
      assert.equal(completed?.params.turn.status, 'completed', JSON.stringify(completed))
      assert.match(JSON.stringify(notifications), /Synthetic follow-up succeeded/)
      assert.ok(requests > 0)
    })
  } finally {
    fixture.closeAllConnections()
    await new Promise(resolve => fixture.close(resolve))
  }
}
