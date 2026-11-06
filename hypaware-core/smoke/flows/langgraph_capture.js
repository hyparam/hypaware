import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Attr, getLogger, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { buildPluginCatalog } from '../../../src/core/plugin_catalog.js'
import { detachClientFromDisk } from '../../../src/core/config/client_detach_disk.js'
import { runPickerFinale } from '../../../src/core/cli/walkthrough.js'
import { journalPath, pendingSlots, readSlot, publish } from '../../plugins-workspace/langgraph/src/journal.js'
import { SessionIgnoreSet } from '../../../src/core/control/session_ignore_store.js'

/** @param {{ harness: any, expect: any }} args */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('smoke')
  const previousHome = process.env.HOME
  const previousConfig = process.env.HYP_CONFIG
  const home = path.join(harness.tmpDir, 'home')
  const cwd = path.join(home, 'app')
  const configPath = path.join(home, 'config.json')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  const step = (name, fn) => runRoot(`smoke.step.${name}`, {
    [Attr.DEV_RUN_ID]: harness.devRunId, [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name, component: 'smoke', operation: 'step',
  }, async () => { log.info('langgraph.smoke.step', { smoke_step: name }); return fn() })
  const directory = journalPath(harness.stateDir)
  let started = false
  try {
    await fs.mkdir(cwd, { recursive: true })
    process.env.HOME = home
    process.env.HYP_CONFIG = configPath
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/langgraph' }] }))
    const loaded = await loadManifests([path.resolve(import.meta.dirname, '../../plugins-workspace/langgraph')])
    const activation = await activatePlugins({ plugins: [{ ...loaded.loaded[0], config: { listen_port: 0 } }],
      stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot: path.join(home, 'tmp') })
    expect.that('plugin activated', activation.results, v => v.every(r => r.ok))
    expect.that('gateway not required', kernel.capabilities.has('hypaware.ai-gateway'), v => !v)
    const ctx = kernel.activationContexts.get('@hypaware/langgraph')
    if (!ctx) throw new Error('missing context')
    const client = kernel.clients.getClient('langgraph')
    if (!client) throw new Error('missing client')
    const out = buffer()
    await step('attach', async () => {
      await client.attach({ config: {}, stdout: out, stderr: buffer(), json: true })
      const instructions = buffer()
      await runPickerFinale({ finale: { skipDaemon: true }, clientsPicked: ['langgraph'],
        capabilities: kernel.capabilities, clients: kernel.clients,
        config: { version: 2, plugins: [{ name: '@hypaware/langgraph' }] },
        configPath, env: process.env, stdout: instructions, stderr: buffer(),
        retentionDays: 30, interactive: false })
      expect.that('Customize shows the actual application callback instructions', instructions.text(), v => v.includes('callbacks: [capture]'))
      expect.that('Customize includes Python setup', instructions.text(), v => v.includes('with create_hypaware_callback('))
    })
    const installed = JSON.parse(out.text())
    expect.that('CLI JSON includes Python setup', installed.python_example, v => v.includes('from hypaware_langgraph import create_hypaware_callback'))
    const { createHypAwareCallback } = await import(pathToFileURL(installed.settings_path).href)
    const capture = createHypAwareCallback({ sessionId: harness.devRunId, cwd })
    await step('record_while_collector_down', async () => {
      await capture.handleChatModelStart({}, [[{ type: 'human', id: 'h', content: '19 + 23' }]], 'model1', 'child',
        { invocation_params: { tools: [{ type: 'function', function: { name: 'add', parameters: { type: 'object' } } }] } }, [],
        { ls_provider: 'openai', ls_model_name: 'fixture-modern', langgraph_checkpoint_ns: 'researcher:one|model:two' })
      await capture.handleLLMEnd({ generations: [[{ message: { type: 'ai', content: '',
        tool_calls: [{ id: 'call1', name: 'add', args: { a: 19, b: 23 } }],
        usage_metadata: { input_tokens: 10, output_tokens: 5 } } }]] }, 'model1')
      await capture.handleToolStart({ id: ['add'] }, '{"a":19,"b":23}', 'tool1', 'child', [],
        { langgraph_checkpoint_ns: 'researcher:one|tools:three' }, 'add', 'call1')
      await capture.handleToolEnd('42', 'tool1')
      expect.that('completed callbacks are on disk without a collector', (await pendingSlots(directory)).length, v => v === 2)
      expect.that('callback errors absent', capture.status().dropped, v => v === 0)
    })
    const replay = await Promise.all((await pendingSlots(directory)).map(s => readSlot(directory, s)))
    await step('recover', async () => {
      const append = ctx.storage.appendRows
      ctx.storage.appendRows = async () => { throw new Error('synthetic storage outage') }
      try {
        await kernel.sources.start('langgraph', ctx)
        started = true
        await until(async () => Boolean((await kernel.sources.started('langgraph')?.status?.())?.lastError))
        expect.that('failed persistence retains the durable queue', (await pendingSlots(directory)).length, v => v === 2)
      } finally { ctx.storage.appendRows = append }
      await until(async () => (await pendingSlots(directory)).length === 0)
      const rows = await query('select * from ai_gateway_messages', kernel, registry)
      expect.that('normal session rows recovered', rows.length, v => v === 3)
      expect.that('nested parent and tool schemas preserved', rows, v => v.every(r => r.parent_thread_id === harness.devRunId && r.tools?.length === 1))
      expect.that('tool result captured', rows, v => v.some(r => r.tool_result_for === 'call1' && r.content_text === '42'))
    })
    await step('restart_and_replay', async () => {
      await kernel.sources.stop('langgraph')
      started = false
      for (const projection of replay) await publish(directory, { version: 1, projection })
      await kernel.sources.start('langgraph', ctx)
      started = true
      await until(async () => (await pendingSlots(directory)).length === 0)
      const rows = await query('select * from ai_gateway_messages', kernel, registry)
      expect.that('replayed committed records do not duplicate rows or usage', rows.length, v => v === 3)
      const status = await kernel.sources.started('langgraph')?.status?.()
      expect.that('dedupe visible in status', status?.details?.rows_skipped, v => Number(v) === 3)
    })
    await step('privacy_on_replay', async () => {
      await kernel.sources.stop('langgraph')
      started = false
      for (const projection of replay) await publish(directory, { version: 1, projection: { ...projection, session_id: 'ignored-session' } })
      new SessionIgnoreSet(harness.stateDir).add('ignored-session')
      await kernel.sources.start('langgraph', ctx)
      started = true
      await until(async () => (await pendingSlots(directory)).length === 0)
      const status = await kernel.sources.started('langgraph')?.status?.()
      expect.that('pending ignored session discarded before persistence', status?.details?.policy_drops, v => Number(v) === 2)
      expect.that('ignored session has no rows', (await query("select * from ai_gateway_messages where session_id = 'ignored-session'", kernel, registry)).length, v => v === 0)
    })
    await step('detach', async () => {
      const descriptor = buildPluginCatalog(loaded.loaded).clientDescriptors.get('langgraph')
      if (!descriptor) throw new Error('missing descriptor')
      expect.that('managed module removed', (await detachClientFromDisk({ descriptor, homeDir: home, env: process.env })).changed, v => v)
      await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/langgraph', recording: false }] }))
      await capture.handleToolStart({ id: ['add'] }, '{}', 'after-detach', undefined, [], {}, 'add', 'detached')
      await capture.handleToolEnd('42', 'after-detach')
      expect.that('already loaded callback honors recording off', (await pendingSlots(directory)).length, v => v === 0)
    })
    await kernel.sources.stop('langgraph')
    started = false
    await obs.shutdown()
    expect.that('storage failure is observable', await expect.logs(), logs => logs.some(l => l.body === 'langgraph.journal.failed'))
    expect.that('delivery telemetry proves the production path ran', await expect.logs(), logs => logs.some(l => l.body === 'langgraph.journal.drain' && Number(l.attributes?.rows_written) === 3))
    expect.that('smoke steps carry run identity', await expect.traces(), traces => traces.filter(t => t.name?.startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId).length === 6)
  } finally {
    if (started) await kernel.sources.stop('langgraph')
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousConfig === undefined) delete process.env.HYP_CONFIG
    else process.env.HYP_CONFIG = previousConfig
    await obs.shutdown()
  }
}

function buffer() {
  const chunks = []
  return { write(value) { chunks.push(String(value)); return true }, text() { return chunks.join('') } }
}
async function query(sql, kernel, registry) {
  const out = buffer(), err = buffer()
  const code = await dispatch(['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: out, stderr: err, kernel, registry, env: process.env })
  if (code) throw new Error(err.text())
  return JSON.parse(out.text())
}
async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('journal drain timeout')
}
