// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Issue #2477. The hermetic smokes redirected HOME and HYP_HOME but not the
// temp env, so every plugin boot dir landed in the real OS temp root and
// stayed there, one set per flow per run, even on a pass.

const harnessPath = fileURLToPath(new URL('../../hypaware-core/smoke/lib/harness.js', import.meta.url))

/**
 * @param {string} outer the TMPDIR the smoke inherits
 * @param {string} script
 */
function runScript(outer, script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: outer, TMPDIR: outer, TMP: outer, TEMP: outer },
  })
}

test('a passing smoke leaves nothing in the inherited temp root and keeps what was there', async t => {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-smoke-temp-'))
  t.after(() => fs.rm(outer, { recursive: true, force: true }))
  await fs.writeFile(path.join(outer, 'user-file'), 'keep')

  const result = runScript(outer, `
    import os from 'node:os'
    import fs from 'node:fs'
    import path from 'node:path'
    import { runFlow } from ${JSON.stringify(harnessPath)}
    const harness = await runFlow('core_boot_noop')
    console.log(JSON.stringify({ tmpDir: harness.tmpDir, temp: os.tmpdir() }))
  `)
  assert.equal(result.status, 0, result.stderr)
  const state = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
  assert.equal(state.temp, path.join(state.tmpDir, 'tmp'), 'the flow saw the harness-owned temp root')
  assert.deepEqual(await fs.readdir(outer), ['user-file'])
})

test('a smoke that crashes mid-run reclaims its temp root and keeps the rest for diagnosis', async t => {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-smoke-temp-'))
  t.after(() => fs.rm(outer, { recursive: true, force: true }))
  await fs.writeFile(path.join(outer, 'user-file'), 'keep')

  // Crash with an uncaught exception once the harness has redirected the
  // temp env and a plugin-style boot dir exists under it, so the flow never
  // unwinds back into the harness.
  const result = runScript(outer, `
    import os from 'node:os'
    import fs from 'node:fs'
    import path from 'node:path'
    import { runFlow } from ${JSON.stringify(harnessPath)}
    const inherited = os.tmpdir()
    const timer = setInterval(() => {
      if (os.tmpdir() === inherited) return
      clearInterval(timer)
      fs.mkdirSync(path.join(os.tmpdir(), '@hypaware__otel-smoke-crash'))
      console.log(JSON.stringify({ temp: os.tmpdir() }))
      throw new Error('crash mid-run')
    }, 0)
    await runFlow('core_boot_noop')
    await new Promise(() => {})
  `)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /crash mid-run/)
  const state = JSON.parse(result.stdout.trim().split('\n').find((l) => l.startsWith('{"temp"')) ?? '{}')
  assert.ok(state.temp, result.stdout)
  await assert.rejects(fs.stat(state.temp), { code: 'ENOENT' })

  const left = (await fs.readdir(outer)).sort()
  assert.equal(left.length, 2, `only the user file and the harness root remain: ${left}`)
  assert.equal(left[1], 'user-file')
  assert.equal(path.join(outer, left[0]), path.dirname(state.temp))
})
