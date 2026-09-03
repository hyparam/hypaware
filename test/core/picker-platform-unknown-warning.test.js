// @ts-check

// A `platforms` gate is compared against `process.platform` by string
// equality, so a typo ("macos", "Darwin", "win") matches nothing and withholds
// the row on every platform. Manifest validation accepts the shape (LLP 0369:
// a closed enum would kill the whole plugin over one display gate), so the
// load-time warning is all that stands between the author and a row that
// silently never appears.
//
// The line is read off the real `process.stderr` rather than off a logger
// provider, because a default install has no provider at all (LLP
// 0329#dark-substrate) and this diagnostic has to reach an author who
// configured nothing.
//
// @ref LLP 0369#warn-not-reject [tests]: an unrecognized platform warns and still loads.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadManifest } from '../../src/core/manifest.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { stderrTextFrom } from '../helpers/stderr_lines.js'

const WARNING = 'picker_platform_unrecognized'

/**
 * Write a one-row plugin manifest carrying `platforms` into a fresh
 * directory and return that directory.
 *
 * @param {unknown} platforms
 * @returns {Promise<string>}
 */
async function pluginDirWithPickerPlatforms(platforms) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-picker-platforms-'))
  const manifest = {
    schema_version: 1,
    name: '@acme/gated',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    contributes: {
      picker: [{ name: 'gated', label: 'Gated', ...(platforms === undefined ? {} : { platforms }) }],
    },
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest), 'utf8')
  return dir
}

/**
 * Load the plugin in `dir`, returning the result and what it wrote to stderr.
 *
 * @param {string} dir
 * @returns {Promise<{ ok: boolean, stderr: string }>}
 */
async function loadCapturingStderr(dir) {
  let ok = false
  const stderr = await stderrTextFrom(async () => {
    ok = (await loadManifest(dir)).ok
  })
  return { ok, stderr }
}

test('a picker platforms value outside the known set warns on stderr and still loads the plugin', async (t) => {
  const dir = await pluginDirWithPickerPlatforms(['macos'])
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const { ok, stderr } = await loadCapturingStderr(dir)

  // The gate is one row's display filter, not a reason to lose the plugin.
  assert.equal(ok, true)

  const warned = stderr.split('\n').filter((line) => line.includes(WARNING))
  assert.equal(warned.length, 1, `expected one warning, got ${JSON.stringify(warned)}`)
  // The author has to be able to find the typo from the line alone.
  assert.match(warned[0], /WARN/)
  assert.equal(warned[0].includes(path.join(dir, 'hypaware.plugin.json')), true)
  assert.equal(warned[0].includes('gated'), true)
  assert.equal(warned[0].includes('macos'), true)
})

test('a picker platforms gate naming real platforms warns about nothing', async (t) => {
  // `netbsd` is in the set for the same reason the others are: it is a value
  // `process.platform` reports, so gating on it is correct and must stay quiet.
  for (const platforms of [['darwin', 'linux'], ['win32'], ['netbsd'], undefined]) {
    const dir = await pluginDirWithPickerPlatforms(platforms)
    t.after(() => fs.rm(dir, { recursive: true, force: true }))

    const { ok, stderr } = await loadCapturingStderr(dir)
    assert.equal(ok, true)
    assert.equal(stderr.includes(WARNING), false, `warned for ${JSON.stringify(platforms)}`)
  }
})

test('every bundled picker row names only known platforms', async () => {
  const stderr = await stderrTextFrom(() => discoverBundledPlugins())
  assert.equal(stderr.includes(WARNING), false, stderr)
})
