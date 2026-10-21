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
import { droidSessionsRoot } from '../../plugins-workspace/droid/src/transcript.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'

/** @param {{ harness: any, expect: any }} args */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const prior = process.env.FACTORY_HOME_OVERRIDE
  process.env.FACTORY_HOME_OVERRIDE = harness.tmpDir
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot: path.join(harness.stateDir, 'cache') })
  const records = (await fs.readFile(new URL('../fixtures/droid-session.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  records[0].cwd = path.join(harness.tmpDir, 'project')
  records[0].id = harness.devRunId
  const file = path.join(droidSessionsRoot(process.env), 'project', 'session.jsonl')
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
      child.stdin.end(JSON.stringify({ session_id: records[0].id, transcript_path: file, hook_event_name: 'Stop', tool_response: 'not sent to daemon' }))
    })
    expect.that('installed hook exits without decisions or errors', result, r => r.code === 0 && !r.stdout && !r.stderr)
  }
  async function query() {
    return cli(['query', 'sql', `select * from ai_gateway_messages where session_id = '${harness.devRunId}' order by message_index, part_index`, '--refresh', 'always', '--format', 'json', '--max-bytes', '0'])
  }
  try {
    const loaded = await step('activate', async () => {
      await fs.mkdir(records[0].cwd, { recursive: true })
      await fs.mkdir(path.dirname(file), { recursive: true })
      const loaded = await loadManifests([path.resolve(import.meta.dirname, '../../plugins-workspace/droid')])
      const activated = await activatePlugins({ plugins: loaded.loaded.map(p => ({ manifest: p.manifest, rootDir: p.rootDir, config: { listen_port: 0 } })), stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot: harness.tmpDir })
      expect.that('Droid activated', activated.results, r => r.length === 1 && r.every(p => p.ok))
      expect.that('No proxy required', kernel.capabilities.has('hypaware.ai-gateway'), v => !v)
      return loaded
    })
    const ctx = kernel.activationContexts.get('@hypaware/droid')
    if (!ctx) throw new Error('Droid context missing')
    await step('attach', async () => {
      await kernel.sources.start('droid', ctx)
      const status = await kernel.sources.started('droid')?.status?.()
      ctx.config.listen_port = Number(status?.details?.listen_port)
      endpoint = `http://127.0.0.1:${ctx.config.listen_port}`
      const client = kernel.clients.getClient('droid')
      if (!client) throw new Error('Droid client missing')
      await client.attach({ config: {}, json: true, stdout: { write() { return true } }, stderr: { write() { return true } } })
      const hooks = JSON.parse(await fs.readFile(path.join(harness.tmpDir, '.factory', 'hooks.json'), 'utf8'))
      command = hooks.Stop.at(-1).hooks[0].command
    })
    await step('live', async () => {
      await fs.writeFile(file, records.slice(0, 3).map(e => JSON.stringify(e)).join('\n') + '\n')
      await notify()
      await fs.appendFile(file, records.slice(3).map(e => JSON.stringify(e)).join('\n') + '\n')
      await notify()
      await notify()
      const rows = await query()
      expect.that('native hook captures every part once', rows.length, n => n === 5)
      expect.that('incremental capture preserves positions', rows.map(r => r.message_index), values => JSON.stringify(values) === '[0,1,1,2,3]')
      expect.that('native tool result link retained', rows, values => values.some(r => r.part_type === 'tool_result' && r.tool_call_id === 'call-1'))
    })
    await step('recover', async () => {
      const missed = { type: 'message', id: 'missed-hook', seq: 4, timestamp: '2026-10-20T12:00:04Z', message: { role: 'user', content: 'Persisted while daemon was unavailable' } }
      await fs.appendFile(file, JSON.stringify(missed) + '\n')
      for (let i = 0; i < 2; i++) await cli(['backfill', 'droid', '--since', '2000-01-01T00:00:00Z', '--json'])
      const rows = await query()
      expect.that('recovery repairs missed hook and deduplicates', rows.length, n => n === 6)
      expect.that('no cumulative spend invented', rows, values => values.every(r => !(typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes)?.usage))
    })
    await step('privacy', async () => {
      await fs.writeFile(path.join(records[0].cwd, '.hypignore'), 'ignore\n')
      const response = await fetch(`${endpoint}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: records[0].id, transcript_path: file }) })
      expect.that('ignored directory dropped', response.status, n => n === 202)
    })
    await step('detach', async () => {
      const descriptor = buildPluginCatalog(loaded.loaded).clientDescriptors.get('droid')
      if (!descriptor) throw new Error('Droid descriptor missing')
      expect.that('managed hooks removed', (await detachClientFromDisk({ descriptor, homeDir: harness.tmpDir, env: process.env })).changed, v => v === true)
      await kernel.sources.stop('droid')
    })
    // @ref LLP 0359#sweep-context [tests]: the real daemon tick passes the
    // provider's narrower window, even when the cache retains older rows.
    await step('scheduled_recovery', async () => {
      const home = path.join(harness.tmpDir, 'scheduled')
      const configPath = path.join(home, 'hypaware-config.json')
      await fs.mkdir(home, { recursive: true })
      const sessionId = `${harness.devRunId}-scheduled`
      const now = Date.now()
      await fs.writeFile(path.join(path.dirname(file), 'scheduled.jsonl'), [
        { ...records[0], id: sessionId, cwd: home },
        { type: 'message', id: 'old', seq: 0, timestamp: new Date(now - 2 * 86400000).toISOString(), message: { role: 'user', content: 'Outside the provider window' } },
        { type: 'message', id: 'recent', seq: 1, timestamp: new Date(now).toISOString(), message: { role: 'user', content: 'Missed hook recovered by the daemon tick' } },
      ].map(record => JSON.stringify(record)).join('\n') + '\n')
      await fs.writeFile(configPath, JSON.stringify({
        version: 2, auto_update: false,
        plugins: [{ name: '@hypaware/droid', config: {
          listen_port: ctx.config.listen_port, backfill: { window_days: 1, sweep_cron: '* * * * *' },
        } }],
        query: { cache: { retention: { default_days: 30 } } },
      }))
      const daemon = await runDaemon({ hypHome: home, configPath,
        env: { ...process.env, HYP_HOME: home, HYP_CONFIG: configPath },
        runId: harness.devRunId, tickIntervalMs: 200, installSignalHandlers: false,
      })
      try {
        let finished
        const deadline = Date.now() + 20000
        while (Date.now() < deadline) {
          finished = (await expect.logs()).find(e => e.body === 'backfill.sweep_finished' && e.attributes?.provider === 'droid')
          if (finished) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        expect.that('scheduled Droid recovery finishes successfully', finished?.attributes?.status, value => value === 'ok')
        const rows = await cli(['query', 'sql', `select message_index, content_text from ai_gateway_messages where session_id = '${sessionId}'`, '--refresh', 'always', '--format', 'json', '--max-bytes', '0'], daemon.runtime)
        expect.that('scheduled recovery honors the provider window and native position', rows,
          values => values.length === 1 && values[0].message_index === 1 && values[0].content_text === 'Missed hook recovered by the daemon tick')
      } finally {
        await daemon.stop()
        await daemon.done
      }
    })
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that('capture signal emitted', logs, values => values.filter(e => e.body === 'droid.hook.recorded').reduce((sum, e) => sum + Number(e.attributes?.rows_written ?? 0), 0) === 5)
    expect.that('recovery signal emitted', logs, values => values.some(e => e.body === 'droid.backfill.scan'))
    const traces = await expect.traces()
    expect.that('run-specific steps traced', traces.filter(t => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId).length, n => n === 7)
  } finally {
    await kernel.sources.stop('droid').catch(() => {})
    await obs.shutdown().catch(() => {})
    if (prior === undefined) delete process.env.FACTORY_HOME_OVERRIDE
    else process.env.FACTORY_HOME_OVERRIDE = prior
  }
}
