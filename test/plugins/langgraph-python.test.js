import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { attachLangGraph } from '../../hypaware-core/plugins-workspace/langgraph/src/attach.js'
import { journalPath, pendingSlots, readSlot } from '../../hypaware-core/plugins-workspace/langgraph/src/journal.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
const exec = promisify(execFile)
const python = process.env.HYP_LANGGRAPH_PYTHON ?? 'python3'

for (const mode of ['capture', 'privacy', 'concurrent', 'failure', 'timeout', 'bounds']) {
  test(`Python callback: ${mode}, bounded IPC and helper cleanup`, async t => {
    try { await exec(python, ['--version']) } catch (error) {
      if (error.code === 'ENOENT') { t.skip('Python is not installed'); return }
      throw error
    }
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-python-callback-'))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const env = { ...process.env, HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_CONFIG: path.join(home, 'config.json'),
      PYTHONDONTWRITEBYTECODE: '1' }
    await fs.writeFile(env.HYP_CONFIG, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/langgraph', recording: mode !== 'privacy' }] }))
    const installed = await attachLangGraph({ env })
    const output = await exec(python, [path.resolve('test/fixtures/langgraph/python_callbacks.py'), installed.settingsPath,
      process.execPath, home, mode], { env, timeout: 30000, maxBuffer: 8192 })
    assert.equal(output.stderr, '')
    const result = JSON.parse(output.stdout)
    assert.equal(result.closed, true)
    if (mode === 'capture') {
      assert.equal(result.status.dropped, 0)
      const directory = journalPath(path.join(env.HYP_HOME, 'hypaware'))
      const events = await Promise.all((await pendingSlots(directory)).map(s => readSlot(directory, s)))
      const rows = events.flatMap(p => aiGatewayRowsFromProjectedExchange(p))
      assert.equal(rows.length, 3)
      assert.equal(rows.filter(r => r.role === 'assistant').length, 1)
      const reply = rows.find(r => r.role === 'assistant')
      assert.equal(/** @type {any} */ (reply?.attributes)?.usage.input_tokens, 11)
      assert.ok(rows.every(r => r.parent_thread_id === 'python-test'))
      assert.ok(rows.some(r => r.tool_result_for === 'call' && /** @type {any} */ (r.tool_args)?.a === 19))
      assert.ok(!JSON.stringify(rows).includes('MUST_NOT_CAPTURE'))
    }
  })
}
