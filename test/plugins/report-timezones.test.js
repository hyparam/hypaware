// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkTimeZones, pageTimeZone } from '../../hypaware-core/skills/hypaware-report/scripts/check-timezones.mjs'

test('a UTC date crossing the Pacific calendar boundary needs a visible zone (#2981)', () => {
  const page = '# Agent activity\n\nPeriod: Nov 12, 2026\n\nAn agent worked at 01:30.\n'
  assert.equal(pageTimeZone(page), undefined)
  assert.equal(pageTimeZone(page.replace('Period:', 'Time zone: UTC\nPeriod:')), 'UTC')
  assert.equal(pageTimeZone('# Agent activity\nTime zone: America/Los_Angeles\nPeriod: Nov 11, 2026'), 'America/Los_Angeles')
  for (const label of ['PST', 'EST', 'local', 'Unknown/Zone']) assert.equal(pageTimeZone(`Time zone: ${label}`), undefined)
  assert.equal(pageTimeZone('# Example\n```\nTime zone: UTC\n```'), undefined, 'an example is not the page scope')
})

test('every standalone page needs its own time zone, even when the overview has one', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-report-timezones-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'report.md'), '# Review\nTime zone: UTC\n')
  await fs.writeFile(path.join(dir, 'recommendation-capture.md'), '# Improve capture\nPeriod: Nov 12, 2026\n')
  assert.match((await checkTimeZones(dir)).join('\n'), /^recommendation-capture.md:/)
  await fs.writeFile(path.join(dir, 'recommendation-capture.md'), '# Improve capture\n**Time zone:** UTC\n')
  assert.deepEqual(await checkTimeZones(dir), [])
})
