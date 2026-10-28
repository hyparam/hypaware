// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// @ref LLP 0495#ownership [tests]: report rendering assets belong to the server
test('the client ships no report renderer or rendering dependency', () => {
  assert.equal(fs.existsSync(new URL('../../src/core/reports', import.meta.url)), false)
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies.marked, undefined)
  assert.equal(pkg.exports['./core/reports'], undefined)
  assert.equal(fs.existsSync(new URL('../../hypaware-core/skills/hypaware-report/assets', import.meta.url)), false)
})
