// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Attr, getLogger, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { pluginStateDir } from '../../../src/core/runtime/paths.js'
import { atomicWriteJson } from '../../../src/core/util/fs_atomic.js'
import { cursorCloudConnectionPath } from '../../plugins-workspace/cursor/src/cloud-state.js'
import { CURSOR_CLOUD_EVENTS } from '../../plugins-workspace/cursor/src/cloud.js'
import { attachCursorHooks } from '../../plugins-workspace/cursor/src/attach.js'

/**
 * Synthetic documented API shapes and native hooks, with real adapter/kernel,
 * privacy, storage, SQL and telemetry. No enrollment or external requests.
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0593#validation: first-turn recovery and edit observations share real materialization and durable replay checks.
 */
export async function run({ harness, expect }) {
  if (process.platform === 'win32') throw new Error('Cursor Cloud metadata uses a Linux Unix socket; run this flow on Linux or macOS')
  const obs = installObservability()
  const log = getLogger('smoke')
  const agentId = 'bc-11111111-2222-4333-8444-555555555555'
  const repository = 'https://github.com/example/synthetic'
  const cwd = await fs.realpath(await fs.mkdir(path.join(harness.tmpDir, 'workspace'), { recursive: true }).then(() => path.join(harness.tmpDir, 'workspace')))
  const oldSocket = process.env.CURSOR_AGENT_SOCKET
  const oldKey = process.env.CURSOR_API_KEY
  const originalFetch = globalThis.fetch
  // macOS Unix sockets have a short pathname limit. This socket-only temp root
  // is separate from the long smoke run directory and is always removed.
  const socketRoot = await fs.mkdtemp('/tmp/hyp-cs-')
  const metadataSocket = path.join(socketRoot, 'meta.sock')
  const metadata = http.createServer((req, res) => res.end(req.url?.endsWith('/agent/id') ? agentId : 'github.com/example/synthetic'))
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  const stateDir = pluginStateDir(harness.stateDir, '@hypaware/cursor')
  let started = false
  let apiRequests = 0
  const step = (name, fn) => runRoot(`smoke.step.${name}`, {
    [Attr.COMPONENT]: 'smoke', [Attr.OPERATION]: 'step', [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name, [Attr.DEV_RUN_ID]: harness.devRunId,
  }, async () => {
    log.info('cursor.cloud.smoke.step', { [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: name, [Attr.DEV_RUN_ID]: harness.devRunId })
    return fn()
  })
  try {
    await new Promise(resolve => metadata.listen(metadataSocket, () => resolve(undefined)))
    process.env.CURSOR_AGENT_SOCKET = metadataSocket
    process.env.CURSOR_API_KEY = 'SYNTHETIC_CURSOR_CLOUD_KEY'
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith('https://api.cursor.com/')) return originalFetch(url, options)
      apiRequests++
      if (!String(url).endsWith('/conversation')) return Response.json({ id: agentId, status: 'FINISHED', source: { repository } })
      return Response.json({ id: agentId, messages: [
        { id: 'first-prompt', type: 'user_message', text: 'FIRST_PROMPT' },
        { id: 'turn-0:step:1:assistant', type: 'assistant_message', text: 'FIRST_RESPONSE' },
      ] })
    }
    await atomicWriteJson(cursorCloudConnectionPath(stateDir), { version: 1, agentId, repository, cwd }, { mode: 0o600, dirMode: 0o700 })
    await step('activate_cloud_mode', async () => {
      const manifests = await loadManifests([path.resolve(import.meta.dirname, '../../plugins-workspace/cursor')])
      const activated = await activatePlugins({ plugins: manifests.loaded.map(plugin => ({ ...plugin, config: { listen_port: 0 } })),
        stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
      })
      expect.that('Cursor Cloud adapter activates', activated.results, rows => rows.length === 1 && rows[0].ok)
      expect.that('No API request during activation', apiRequests, count => count === 0)
    })
    const activation = kernel.activationContexts.get('@hypaware/cursor')
    if (!activation) throw new Error('missing Cursor activation')
    const ctx = activation
    let endpoint
    async function boot() {
      await kernel.sources.start('cursor', ctx)
      started = true
      const status = await kernel.sources.started('cursor')?.status?.()
      endpoint = `http://127.0.0.1:${status?.details?.listen_port}`
      for (let i = 0; i < 4000; i++) {
        if (Number((await kernel.sources.started('cursor')?.status?.())?.details?.api_messages) === 2) return
        await delay(10)
      }
      throw new Error('Cloud API recovery timeout')
    }
    const post = async event => {
      const result = await originalFetch(endpoint + '/hook', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delivery_id: randomUUID(), observed_at: new Date().toISOString(), event: { conversation_id: agentId, workspace_roots: [cwd], ...event } }),
      })
      return { status: result.status, body: await result.json() }
    }
    await step('recover_and_attach', async () => {
      await boot()
      const result = await attachCursorHooks({ endpoint, version: '1.0.0', settingsPath: path.join(cwd, '.cursor/hooks.json'), cloud: true, events: CURSOR_CLOUD_EVENTS })
      expect.that('Repository hooks are installed', result.changed, value => value === true)
      const skipped = await post({ hook_event_name: 'beforeSubmitPrompt', prompt: 'FIRST_PROMPT' })
      expect.that('API is sole main text owner', skipped.status, value => value === 202)
    })
    await step('capture_tools_edit_and_failure', async () => {
      const tool = { hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'repeat' }, tool_output: { output: 'SHELL\n', exitCode: 0 } }
      for (const tool_use_id of ['one', 'one', 'two']) expect.that('Tool callback stored', (await post({ ...tool, tool_use_id })).status, value => value === 200)
      expect.that('Failure callback stored', (await post({ ...tool, hook_event_name: 'postToolUseFailure', tool_use_id: 'failed', error_message: 'Command failed with exit code 7' })).status, value => value === 200)
      const file = path.join(cwd, 'file.txt')
      await fs.writeFile(file, 'after')
      expect.that('Edit callback stored', (await post({ hook_event_name: 'afterFileEdit', file_path: file, edits: [{ old_string: 'before', new_string: 'after' }] })).status, value => value === 200)
      const privateDir = path.join(cwd, 'private')
      await fs.mkdir(privateDir)
      await fs.writeFile(path.join(privateDir, '.hypignore'), 'local-only\n')
      await fs.writeFile(path.join(privateDir, 'secret'), 'PRIVATE')
      const dropped = await post({ hook_event_name: 'afterFileEdit', file_path: path.join(privateDir, 'secret'), edits: [{ old_string: '', new_string: 'PRIVATE' }] })
      expect.that('Stricter file policy is enforced', dropped, value => value.status === 202 && value.body.reason === 'file_scope_or_policy')
    })
    await step('restart_and_query', async () => {
      await kernel.sources.stop('cursor')
      started = false
      await boot()
      const out = buffer()
      const err = buffer()
      const code = await dispatch(['query', 'sql', 'select role, part_type, content_text, tool_name, tool_result_for, hook_event, is_error, client_name, entrypoint from ai_gateway_messages', '--refresh', 'always', '--format', 'json'], { kernel, registry, env: process.env, stdout: out, stderr: err })
      expect.that('SQL query succeeds', code, value => value === 0)
      const rows = JSON.parse(out.text())
      expect.that('Nine rows survive replay without duplication', rows, value => value.length === 9)
      expect.that('First-turn text appears once in its correct roles', rows, value => value.filter(row => row.role === 'user' && row.content_text === 'FIRST_PROMPT').length === 1 && value.filter(row => row.role === 'assistant' && row.content_text === 'FIRST_RESPONSE').length === 1)
      expect.that('Repeated shell output retains distinct native IDs', rows.filter(row => row.part_type === 'tool_result' && row.content_text.includes('SHELL')), value => value.length === 2 && new Set(value.map(row => row.tool_result_for)).size === 2)
      expect.that('Failure remains explicit', rows, value => value.some(row => row.part_type === 'tool_result' && row.is_error === true))
      expect.that('Edit retains exact before and after', rows.filter(row => row.hook_event === 'afterFileEdit'), value => value.length === 1 && value[0].role === 'system' && JSON.parse(value[0].content_text).edits[0].old_string === 'before' && JSON.parse(value[0].content_text).edits[0].new_string === 'after')
      expect.that('All rows retain Cursor Cloud attribution', rows, value => value.every(row => row.client_name === 'cursor' && row.entrypoint === 'cloud'))
      expect.that('Private edits never enter storage', out.text(), value => !value.includes('PRIVATE') && !value.includes('SYNTHETIC_CURSOR_CLOUD_KEY'))
      await kernel.sources.stop('cursor')
      started = false
    })
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that('Recovery emits structured evidence', logs, rows => rows.some(row => row.body === 'cursor.cloud.recovered' && row.attributes?.operation === 'cloud.recover'))
    const traces = await expect.traces()
    expect.that('File privacy decision is traceable', traces, rows => rows.some(row => row.name === 'cursor.hook.receive' && row.attributes?.reason === 'file_scope_or_policy'))
  } finally {
    if (started) await kernel.sources.stop('cursor')
    await obs.shutdown()
    globalThis.fetch = originalFetch
    if (oldSocket === undefined) delete process.env.CURSOR_AGENT_SOCKET
    else process.env.CURSOR_AGENT_SOCKET = oldSocket
    if (oldKey === undefined) delete process.env.CURSOR_API_KEY
    else process.env.CURSOR_API_KEY = oldKey
    await new Promise(resolve => metadata.close(resolve))
    await fs.rm(socketRoot, { recursive: true, force: true })
  }
}

function buffer() {
  let value = ''
  return /** @type {any} */ ({ write(chunk) { value += String(chunk) }, text() { return value } })
}
