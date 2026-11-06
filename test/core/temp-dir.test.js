// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

for (const fails of [false, true]) {
  test(`direct test fixtures are removed after ${fails ? 'failure' : 'success'}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-fixture-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const helper = new URL('../helpers/temp_dir.js', import.meta.url).href
    const fixture = path.join(root, 'fixture.test.mjs')
    fs.writeFileSync(fixture, `
      import test from 'node:test'
      import fs from 'node:fs'
      import { temporaryDirectory } from ${JSON.stringify(helper)}
      test('fixture', () => {
        const dir = temporaryDirectory('owned-fixture-')
        fs.writeFileSync('observed-root', dir)
        fs.writeFileSync(dir + '/data', 'fixture')
        if (${fails}) throw new Error('intentional failure')
      })
    `)
    const result = spawnSync(process.execPath, ['--test', fixture], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, TMPDIR: root, TMP: root, TEMP: root },
    })
    assert.equal(result.status, fails ? 1 : 0, result.stderr)
    assert.equal(fs.existsSync(fs.readFileSync(path.join(root, 'observed-root'), 'utf8')), false)
    assert.equal(fs.existsSync(fixture), true)
  })
}
