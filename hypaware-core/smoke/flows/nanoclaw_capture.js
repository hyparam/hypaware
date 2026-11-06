// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'

/** @param {{ harness: any, expect: any }} args */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const root = path.join(harness.tmpDir, 'nanoclaw')
  const cwd = path.join(root, 'groups', 'test')
  const file = path.join(root, 'data', 'v2-sessions', 'group-1', '.claude-shared', 'projects', '-workspace-agent', 'session.jsonl')
  const configPath = path.join(harness.hypHome, 'hypaware-config.json')
  let daemon
  /** @param {string} name @param {() => Promise<any>} fn */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, { [Attr.DEV_RUN_ID]: harness.devRunId, [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: name }, fn)
  /** @param {string[]} args */
  async function cli(args) {
    let output = ''
    let error = ''
    const code = await dispatch(args, { kernel: daemon?.runtime, registry, env: process.env,
      stdout: { write(v) { output += v; return true } }, stderr: { write(v) { error += v; return true } } })
    expect.that(`CLI ${args[0]} succeeds`, { code, error }, value => value.code === 0 && !value.error)
    return JSON.parse(output)
  }
  const query = () => cli(['query', 'sql', `select * from ai_gateway_messages where session_id = '${harness.devRunId}' order by message_index`, '--refresh', 'always', '--format', 'json', '--max-bytes', '0'])
  try {
    await step('setup', async () => {
      await fs.mkdir(cwd, { recursive: true })
      await fs.mkdir(path.dirname(file), { recursive: true })
      const db = new DatabaseSync(path.join(root, 'data', 'v2.db'))
      db.exec("CREATE TABLE agent_groups (id TEXT, folder TEXT); INSERT INTO agent_groups VALUES ('group-1', 'test')")
      db.close()
      const now = Date.now()
      const records = (await fs.readFile(new URL('../fixtures/nanoclaw-session.jsonl', import.meta.url), 'utf8')).trim().split('\n').map((line, i) => ({ ...JSON.parse(line), sessionId: harness.devRunId, timestamp: new Date(now - 10000 + i).toISOString() }))
      const old = { ...records[0], uuid: 'too-old', timestamp: new Date(now - 2 * 86400000).toISOString() }
      await fs.writeFile(file, [old, ...records].map(record => JSON.stringify(record)).join('\n') + '\n')
      const discovered = await cli(['client', 'discover', 'nanoclaw', root, '--json'])
      const canonicalRoot = await fs.realpath(root)
      expect.that('discovery reports the supported root before configuration', discovered.roots, values => values.length === 1 && values[0] === canonicalRoot)
      expect.that('discovery does not enable capture', discovered.changed, value => value === false)
      expect.that('discovery writes no configuration', await fs.stat(configPath).then(() => true, () => false), value => value === false)
      await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false,
        plugins: [{ name: '@hypaware/nanoclaw', config: { root, backfill: { window_days: 1, sweep_cron: '* * * * *' } } }],
        query: { cache: { retention: { default_days: 30 } } },
      }))
    })
    await step('scheduled_capture', async () => {
      daemon = await runDaemon({ hypHome: harness.hypHome, configPath,
        env: { ...process.env, HYP_CONFIG: configPath }, runId: harness.devRunId,
        tickIntervalMs: 200, installSignalHandlers: false,
      })
      let finished
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        finished = (await expect.logs()).find(e => e.body === 'backfill.sweep_finished' && e.attributes?.provider === 'nanoclaw')
        if (finished) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect.that('scheduled recovery succeeds', finished?.attributes?.status, value => value === 'ok')
      expect.that('no inference proxy', daemon.runtime.capabilities.has('hypaware.ai-gateway'), value => !value)
      const rows = await query()
      expect.that('window excludes old message and preserves positions', rows.map(row => row.message_index), value => JSON.stringify(value) === '[1,2,3,4,5]')
      const realCwd = await fs.realpath(cwd)
      expect.that('NanoClaw attribution and host workspace retained', rows, values => values.every(row => row.client_name === 'nanoclaw' && row.cwd === realCwd))
      expect.that('native Read result retained', rows, values => values.some(row => row.part_type === 'tool_result' && row.tool_call_id === 'nc-tool'))
      expect.that('token usage counted once', rows.reduce((sum, row) => sum + Number((typeof row.attributes === 'string' ? JSON.parse(row.attributes) : row.attributes)?.usage?.input_tokens ?? 0), 0), value => value === 6)
    })
    await step('rotation_and_replay', async () => {
      await fs.rename(file, `${file}.rotated-123`)
      const since = new Date(Date.now() - 86400000).toISOString()
      for (let i = 0; i < 2; i++) await cli(['backfill', 'nanoclaw', '--since', since, '--json'])
      expect.that('rotated replay has no duplicates', (await query()).length, value => value === 5)
    })
    await step('local_only_export', async () => {
      const rows = await query()
      await fs.writeFile(path.join(cwd, '.hypignore'), 'local-only\n')
      const storage = daemon.runtime.storage
      expect.that('shared export gate withholds NanoClaw workspace rows', storage.exportWithheld(storage.cacheTablePath('ai_gateway_messages'), rows), value => value === 5)
      await fs.unlink(path.join(cwd, '.hypignore'))
    })
    await step('privacy', async () => {
      await fs.writeFile(path.join(cwd, '.hypignore'), 'ignore\n')
      await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: 'private', sessionId: harness.devRunId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Must not be captured' } }) + '\n')
      await cli(['backfill', 'nanoclaw', '--since', new Date(Date.now() - 86400000).toISOString(), '--json'])
      // The query privacy gate also withholds previously captured rows while
      // the directory is ignored. Remove the policy to inspect local storage.
      await fs.unlink(path.join(cwd, '.hypignore'))
      expect.that('host workspace ignore stops capture', (await query()).length, value => value === 5)
    })
    await step('subagent_boundaries_and_restart', async () => {
      const sub = path.join(path.dirname(file), 'session', 'subagents', 'agent-native.jsonl')
      await fs.mkdir(path.dirname(sub), { recursive: true })
      const records = (await fs.readFile(new URL('../fixtures/nanoclaw-subagent.jsonl', import.meta.url), 'utf8')).trim().split('\n').map((line, i) => ({ ...JSON.parse(line), timestamp: new Date(Date.now() - 1000 + i).toISOString() }))
      const since = new Date(Date.now() - 86400000).toISOString()
      // First capture occurs between persisted blocks of one API response.
      await fs.writeFile(sub, records.slice(0, 2).map(row => JSON.stringify(row)).join('\n') + '\n')
      await cli(['backfill', 'nanoclaw', '--since', since, '--json'])
      await daemon.stop()
      await daemon.done
      await fs.appendFile(sub, records.slice(2).map(row => JSON.stringify(row)).join('\n') + '\n')
      daemon = await runDaemon({ hypHome: harness.hypHome, configPath, env: { ...process.env, HYP_CONFIG: configPath }, runId: harness.devRunId, tickIntervalMs: 200, installSignalHandlers: false })
      for (let i = 0; i < 2; i++) await cli(['backfill', 'nanoclaw', '--since', since, '--json'])
      const rows = await cli(['query', 'sql', "select * from ai_gateway_messages where agent_id = 'aa1c14af41b6d836d'", '--refresh', 'always', '--format', 'json', '--max-bytes', '0'])
      expect.that('native subagent final response captured exactly once after restart', rows.length, value => value === 5)
      expect.that('response usage carrier stays stable across incremental capture and restart', rows.reduce((sum, row) => sum + Number((typeof row.attributes === 'string' ? JSON.parse(row.attributes) : row.attributes)?.usage?.input_tokens ?? 0), 0), value => value === 22)
    })
    await daemon.stop()
    await daemon.done
    await obs.shutdown()
    const logs = await expect.logs()
    expect.that('discovery emits bounded metadata counts without paths', logs, values => values.some(e => e.body === 'client.discover' && e.attributes?.root_count === 1 && e.attributes?.candidate_count === 1 && !e.attributes?.root))
    expect.that('native scan emits content-free counts', logs, values => values.some(e => e.body === 'nanoclaw.backfill.scan' && e.attributes?.files_read === 1))
    expect.that('privacy signal emitted', logs, values => values.some(e => e.body === 'nanoclaw.backfill.scan' && e.attributes?.policy_drops > 0))
    expect.that('run-specific steps traced', (await expect.traces()).filter(t => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId).length, value => value === 6)
  } finally {
    await daemon?.stop().catch(() => {})
    await daemon?.done.catch(() => {})
    await obs.shutdown().catch(() => {})
  }
}
