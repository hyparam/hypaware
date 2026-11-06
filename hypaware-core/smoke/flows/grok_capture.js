// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { buildPluginCatalog } from '../../../src/core/plugin_catalog.js'
import { detachClientFromDisk } from '../../../src/core/config/client_detach_disk.js'
import { grokSessionsRoot } from '../../plugins-workspace/grok/src/transcript.js'

/** @param {{ harness: any, expect: any }} args */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const prior = process.env.GROK_HOME
  process.env.GROK_HOME = path.join(harness.tmpDir, '.grok')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  const records = (await fs.readFile(new URL('../fixtures/grok-updates.jsonl', import.meta.url), 'utf8')).trimEnd().split('\n')
  const cwd = path.join(harness.tmpDir, 'project')
  const sessionId = harness.devRunId
  const dir = path.join(grokSessionsRoot(process.env), encodeURIComponent(cwd), sessionId)
  const file = path.join(dir, 'updates.jsonl')
  let command = ''
  let endpoint = ''
  /** @param {string} name @param {() => Promise<any>} fn */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, { [Attr.DEV_RUN_ID]: harness.devRunId, [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: name }, fn)
  /** @param {string[]} args @param {any} [runtime] */
  async function cli(args, runtime = kernel) {
    let output = ''
    let error = ''
    const code = await dispatch(args, { kernel: runtime, registry, env: process.env, stdout: { write(v) {
      output += v
      return true
    } }, stderr: { write(v) {
      error += v
      return true
    } } })
    expect.that(`CLI ${args[0]} succeeds`, { code, error }, v => v.code === 0 && !v.error)
    return JSON.parse(output)
  }
  async function notify() {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify({ sessionId, transcriptPath: file, hookEventName: 'stop', toolResult: 'not sent to daemon' }))
    })
    expect.that('installed hook exits without decisions or errors', result, r => r.code === 0 && !r.stdout && !r.stderr)
  }
  async function query() {
    return cli(['query', 'sql', `select * from ai_gateway_messages where session_id = '${sessionId}' order by message_index, part_index`, '--refresh', 'always', '--format', 'json', '--max-bytes', '0'])
  }
  try {
    const loaded = await step('activate', async () => {
      await fs.mkdir(cwd, { recursive: true })
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: sessionId, cwd }, current_model_id: 'grok-build' }))
      const loaded = await loadManifests([path.resolve(import.meta.dirname, '../../plugins-workspace/grok')])
      const activated = await activatePlugins({ plugins: loaded.loaded.map(p => ({ manifest: p.manifest, rootDir: p.rootDir, config: { listen_port: 0 } })), stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot: harness.tmpDir })
      expect.that('Grok activated', activated.results, r => r.length === 1 && r.every(p => p.ok))
      expect.that('No proxy required', kernel.capabilities.has('hypaware.ai-gateway'), v => !v)
      return loaded
    })
    const ctx = kernel.activationContexts.get('@hypaware/grok')
    if (!ctx) throw new Error('Grok context missing')
    await step('attach', async () => {
      await kernel.sources.start('grok', ctx)
      const status = await kernel.sources.started('grok')?.status?.()
      ctx.config.listen_port = Number(status?.details?.listen_port)
      endpoint = `http://127.0.0.1:${ctx.config.listen_port}`
      const client = kernel.clients.getClient('grok')
      if (!client) throw new Error('Grok client missing')
      await client.attach({ config: {}, json: true, stdout: { write() { return true } }, stderr: { write() { return true } } })
      const installed = JSON.parse(await fs.readFile(path.join(process.env.GROK_HOME ?? '', 'hooks', 'hypaware.json'), 'utf8'))
      command = installed.hooks.Stop.at(-1).hooks[0].command
    })
    await step('live', async () => {
      await fs.writeFile(file, records.slice(0, 6).join('\n') + '\n')
      await notify()
      expect.that('open items wait for the update that settles them', (await query()).length, n => n === 2)
      // As Grok does it: Stop fires, and turn_completed lands just afterward.
      await fs.appendFile(file, records.slice(6, -1).join('\n') + '\n')
      await notify()
      expect.that('the final reply is still open when Stop fires', (await query()).length, n => n === 4)
      await fs.appendFile(file, records.at(-1) + '\n')
      const deadline = Date.now() + 6000
      while ((await query()).length < 5 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      await notify()
      const rows = await query()
      expect.that('native hook captures every part once', rows.length, n => n === 5)
      expect.that('incremental capture preserves line positions', rows.map(r => r.message_index), values => JSON.stringify(values) === '[1,2,4,6,7]')
      expect.that('tool result link retained', rows, values => values.some(r => r.part_type === 'tool_result' && r.tool_call_id === 't1'))
    })
    await step('recover', async () => {
      const missed = { timestamp: 1793000010, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Persisted while daemon was unavailable' } }, _meta: { promptId: 'p2' } } }
      const done = { timestamp: 1793000011, method: '_x.ai/session/update', params: { sessionId, update: { sessionUpdate: 'turn_completed', prompt_id: 'p2' } } }
      await fs.appendFile(file, JSON.stringify(missed) + '\n' + JSON.stringify(done) + '\n')
      for (let i = 0; i < 2; i++) await cli(['backfill', 'grok', '--since', '2000-01-01T00:00:00Z', '--json'])
      const rows = await query()
      expect.that('recovery repairs missed hook and deduplicates', rows.length, n => n === 6)
    })
    await step('privacy', async () => {
      await fs.writeFile(path.join(cwd, '.hypignore'), 'ignore\n')
      const response = await fetch(`${endpoint}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, transcript_path: file }) })
      expect.that('ignored directory dropped', response.status, n => n === 202)
    })
    await step('detach', async () => {
      const descriptor = buildPluginCatalog(loaded.loaded).clientDescriptors.get('grok')
      if (!descriptor) throw new Error('Grok descriptor missing')
      expect.that('managed hooks removed', (await detachClientFromDisk({ descriptor, homeDir: harness.tmpDir, env: process.env })).changed, v => v === true)
      await kernel.sources.stop('grok')
    })
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that('capture signal emitted', logs, values => values.filter(e => e.body === 'grok.hook.recorded' || e.body === 'grok.hook.trailing_read').reduce((sum, e) => sum + Number(e.attributes?.rows_written ?? 0), 0) === 5)
    expect.that('recovery signal emitted', logs, values => values.some(e => e.body === 'grok.backfill.scan'))
    const traces = await expect.traces()
    expect.that('run-specific steps traced', traces.filter(t => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId).length, n => n === 6)
  } finally {
    await kernel.sources.stop('grok').catch(() => {})
    await obs.shutdown().catch(() => {})
    if (prior === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prior
  }
}
