// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { diagnosePlugin } from '../../src/core/plugin_doctor/diagnose.js'
import { SCAFFOLD_KINDS, scaffoldPlugin, slugFromName } from '../../src/core/plugin_doctor/scaffold.js'

test('slugFromName strips scope and sanitizes', () => {
  assert.equal(slugFromName('@acme/widget'), 'widget')
  assert.equal(slugFromName('@acme/My Widget!'), 'my-widget')
  assert.equal(slugFromName('plain'), 'plain')
  assert.throws(() => slugFromName('@acme/!!!'), /cannot derive a slug/)
})

for (const kind of SCAFFOLD_KINDS) {
  test(`scaffold (${kind}) writes files and passes doctor with zero errors`, async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-'))
    const result = await scaffoldPlugin({ name: `@acme/thing-${kind}`, kind, targetDir: target })

    // Expected files exist.
    for (const rel of ['hypaware.plugin.json', 'src/index.js', 'src/types.d.ts', 'README.md']) {
      const abs = path.join(result.pluginDir, rel)
      const stat = await fs.stat(abs)
      assert.ok(stat.isFile(), `${rel} should exist`)
    }

    // Manifest is valid JSON with the expected name.
    const manifest = JSON.parse(await fs.readFile(path.join(result.pluginDir, 'hypaware.plugin.json'), 'utf8'))
    assert.equal(manifest.name, `@acme/thing-${kind}`)
    assert.equal(manifest.schema_version, 1)

    // Scaffold-then-doctor round trip: the generated plugin is clean.
    const report = await diagnosePlugin(result.pluginDir)
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2))
    assert.equal(report.errorCount, 0)
  })
}

test('scaffold refuses to clobber an existing directory', async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-'))
  await scaffoldPlugin({ name: '@acme/dupe', kind: 'source', targetDir: target })
  await assert.rejects(
    () => scaffoldPlugin({ name: '@acme/dupe', kind: 'source', targetDir: target }),
    /already exists/
  )
})

test('scaffold rejects an unknown kind', async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-'))
  await assert.rejects(
    // @ts-expect-error intentionally invalid kind
    () => scaffoldPlugin({ name: '@acme/x', kind: 'frobnicator', targetDir: target }),
    /unknown kind/
  )
})
