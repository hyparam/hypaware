// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Attr, getLogger, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { detachClientFromDisk } from '../../../src/core/config/client_detach_disk.js'
import { buildPluginCatalog } from '../../../src/core/plugin_catalog.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { cursorNativeFixture } from '../lib/cursor_native_fixture.js'
import { cursorStorePaths } from '../../plugins-workspace/cursor/src/native.js'
import { cursorHooksPath } from '../../plugins-workspace/cursor/src/attach.js'

/**
 * Synthetic hooks and native storage, not evidence of real client compatibility.
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0399#capture: equal editor/CLI recovery through real storage wiring
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('smoke')
  const oldHome = process.env.HOME
  const oldConfig = process.env.CURSOR_CONFIG_DIR
  const stores = []
  const home = path.join(harness.tmpDir, 'home')
  const cwd = path.join(harness.tmpDir, 'workspace')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  let started = false
  const step = (name, fn) => runRoot(`smoke.step.${name}`, {
    [Attr.COMPONENT]: 'smoke', [Attr.OPERATION]: 'step', [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name, [Attr.DEV_RUN_ID]: harness.devRunId,
  }, async () => {
    log.info('cursor.smoke.step', { [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: name, [Attr.DEV_RUN_ID]: harness.devRunId })
    return fn()
  })
  try {
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(cwd, { recursive: true })
    await fs.writeFile(path.join(cwd, 'notes.txt'), 'Observed file contents')
    process.env.HOME = home
    process.env.CURSOR_CONFIG_DIR = path.join(home, '.cursor')
    const paths = cursorStorePaths()
    stores.push(await cursorNativeFixture(path.dirname(paths.editorDb), cwd, 'editor'))
    stores.push(await cursorNativeFixture(paths.cliRoot, cwd, 'cli'))
    const loaded = await step('activate', async () => {
      const manifests = await loadManifests([path.resolve(import.meta.dirname, '../../plugins-workspace/cursor')])
      const activated = await activatePlugins({
        plugins: manifests.loaded.map((p) => ({ ...p, config: { listen_port: 0 } })),
        stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel,
        tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
      })
      expect.that('Cursor activated', activated.results, (v) => v.length === 1 && v[0].ok)
      expect.that('No gateway composed', kernel.capabilities.has('hypaware.ai-gateway'), (v) => v === false)
      return manifests.loaded
    })
    const ctx = kernel.activationContexts.get('@hypaware/cursor')
    if (!ctx) throw new Error('missing Cursor activation')
    const endpoint = await step('attach', async () => {
      await kernel.sources.start('cursor', ctx)
      started = true
      const status = await kernel.sources.started('cursor')?.status?.()
      ctx.config.listen_port = Number(status?.details?.listen_port)
      const client = kernel.clients.getClient('cursor')
      if (!client) throw new Error('missing intrinsic Cursor client')
      const out = buffer()
      const attachCtx = { clientName: 'cursor', config: ctx.config, endpoint: '', json: true, stdout: out, stderr: buffer() }
      await client.attach(attachCtx)
      const first = await fs.readFile(cursorHooksPath({ env: process.env }), 'utf8')
      await client.attach(attachCtx)
      expect.that('Attach twice is stable', await fs.readFile(cursorHooksPath({ env: process.env }), 'utf8'), (v) => v === first)
      return `http://127.0.0.1:${ctx.config.listen_port}`
    })
    const post = async (body) => {
      const res = await fetch(`${endpoint}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    let callbacks = 0
    for (const [mode, version] of [['editor', '3.19.19'], ['cli', '2026.09.08-6caf4ff']]) {
      await step(`${mode}_fixture`, async () => {
        const base = { conversation_id: stores.find((s) => s.session.frontend === mode).session.id, generation_id: 'turn', cursor_version: version, workspace_roots: [cwd], transcript_path: null }
        const events = [
          { hook_event_name: 'beforeSubmitPrompt', prompt: 'Read notes' },
          { hook_event_name: 'beforeReadFile', file_path: path.join(cwd, 'notes.txt'), content: 'Observed file contents' },
          { hook_event_name: 'afterAgentResponse', text: 'Same text' },
          { hook_event_name: 'postToolUse', tool_use_id: 'call', tool_name: 'Read', tool_input: { path: 'notes' }, tool_output: 'fixture contents' },
          { hook_event_name: 'afterAgentResponse', text: 'Same text' },
        ]
        for (const event of events) {
          const body = { delivery_id: randomUUID(), observed_at: new Date().toISOString(), event: { ...base, ...event } }
          const result = await post(body)
          expect.that(`${mode} callback is observed or schedules recovery`, result, (v) => event.hook_event_name === 'beforeReadFile' ? v.status === 200 && v.body.rowsWritten === 1 : v.status === 202)
          const retry = await post(body)
          expect.that(`${mode} retry writes no duplicate`, retry, (v) => event.hook_event_name === 'beforeReadFile' ? v.status === 200 && v.body.rowsWritten === 0 : v.status === 202)
          callbacks += 2
        }
      })
    }
    await step('native_recovery', async () => {
      for (let i = 0; i < 100; i++) {
        if ((await kernel.sources.started('cursor')?.status?.())?.details?.native_reads === 2) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect.that('Both native stores recovered', (await kernel.sources.started('cursor')?.status?.())?.details?.native_reads, (v) => v === 2)
      const out = buffer()
      const err = buffer()
      const code = await dispatch(['backfill', 'cursor', '--since', '2000-01-01T00:00:00.000Z', '--json'], { kernel, registry, env: process.env, stdout: out, stderr: err })
      expect.that('Manual recovery runs through registered materializer', { code, error: err.text() }, (v) => v.code === 0)
      const report = JSON.parse(out.text()).providers.find((provider) => provider.provider === 'cursor')
      expect.that('Both native sessions replay with zero duplicate writes', report, (v) => v?.status === 'ok' && v.items_seen === 2 && v.rows_written === 0)
    })
    await step('privacy_and_query', async () => {
      const ignored = path.join(cwd, 'ignored')
      await fs.mkdir(ignored)
      await fs.writeFile(path.join(ignored, '.hypignore'), 'ignore\n')
      const result = await post({ delivery_id: randomUUID(), observed_at: new Date().toISOString(), event: {
        conversation_id: 'ignored', generation_id: 'turn', workspace_roots: [ignored], hook_event_name: 'afterAgentResponse', text: 'Must not land',
      } })
      callbacks++
      expect.that('Ignored directory dropped', result, (v) => v.status === 202 && v.body.reason === 'usage_policy')
      const out = buffer()
      const err = buffer()
      const code = await dispatch(['query', 'sql', 'select client_name, entrypoint, content_text, tool_name from ai_gateway_messages', '--refresh', 'always', '--format', 'json'], { kernel, registry, env: process.env, stdout: out, stderr: err })
      expect.that('Query succeeds', code, (v) => v === 0)
      const rows = JSON.parse(out.text())
      expect.that('Both modes retain repeated text, tools and file observations', rows, (v) => v.length === 18 && v.filter((r) => r.content_text === 'Same text').length === 4 && v.filter((r) => r.tool_name === 'Read').length === 2 && v.filter((r) => r.content_text === 'Observed file contents').length === 2)
      expect.that('Native store identifies editor and CLI', rows, (v) => v.every((r) => r.client_name === 'cursor') && v.filter((r) => r.entrypoint === 'editor').length === 8 && v.filter((r) => r.entrypoint === 'cli').length === 8)
    })
    await step('health_and_detach', async () => {
      const status = await kernel.sources.started('cursor')?.status?.()
      expect.that('Status names measured and unsupported coverage', status?.details, (v) => v.callbacks === callbacks && v.rows_written === 18 && v.policy_drops === 1 && v.history_recovery === 'native_store' && v.usage_supported === false)
      await kernel.sources.stop('cursor')
      started = false
      const descriptor = buildPluginCatalog(loaded).clientDescriptors.get('cursor')
      if (!descriptor) throw new Error('missing Cursor descriptor')
      await detachClientFromDisk({ descriptor, homeDir: home, env: process.env })
      const value = JSON.parse(await fs.readFile(cursorHooksPath({ env: process.env }), 'utf8'))
      expect.that('Disk detach removes owned hooks', value, (v) => v._hypaware === undefined && v.hooks === undefined)
    })
    await obs.shutdown()
    const traces = await expect.traces()
    expect.that('Every callback has receive telemetry', traces.filter((t) => t.name === 'cursor.hook.receive'), (v) => v.length === callbacks)
    expect.that('Privacy decision is visible in telemetry', traces, (v) => v.some((t) => t.attributes?.reason === 'usage_policy'))
    const logs = await expect.logs()
    expect.that('Native recovery emits evidence for both frontends', logs.filter((l) => l.body === 'cursor.recovery.recorded'), (v) => v.length === 2 && v.every((l) => Number(l.attributes?.rows_written) === 8))
    expect.that('Storage path emitted row evidence', logs, (v) => v.some((l) => l.body === 'cursor.hook.recorded' && Number(l.attributes?.rows_written) === 1))
  } finally {
    if (started) await kernel.sources.stop('cursor')
    await obs.shutdown()
    for (const store of stores) store.close()
    if (oldConfig === undefined) delete process.env.CURSOR_CONFIG_DIR
    else process.env.CURSOR_CONFIG_DIR = oldConfig
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
  }
}

function buffer() {
  const chunks = []
  return {
    write(value) {
      chunks.push(String(value))
      return true
    },
    text() { return chunks.join('') },
  }
}
