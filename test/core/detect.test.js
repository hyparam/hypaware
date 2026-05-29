// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { detectClientSources } from '../../src/core/cli/detect.js'

/**
 * @returns {Promise<string>}
 */
async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-detect-'))
}

test('detects claude when ~/.claude exists', async () => {
  const home = await tmpHome()
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })

  const detected = await detectClientSources({ env: { HOME: home } })

  assert.equal(detected.has('claude'), true)
  assert.equal(detected.has('codex'), false)
})

test('detects codex when ~/.codex exists', async () => {
  const home = await tmpHome()
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })

  const detected = await detectClientSources({ env: { HOME: home } })

  assert.equal(detected.has('codex'), true)
  assert.equal(detected.has('claude'), false)
})

test('detects both when both config homes exist', async () => {
  const home = await tmpHome()
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })

  const detected = await detectClientSources({ env: { HOME: home } })

  assert.deepEqual([...detected].sort(), ['claude', 'codex'])
})

test('detects nothing in an empty home', async () => {
  const home = await tmpHome()

  const detected = await detectClientSources({ env: { HOME: home } })

  assert.equal(detected.size, 0)
})

test('honors $CODEX_HOME override for codex detection', async () => {
  // HOME has no ~/.codex; the override points elsewhere and exists.
  const home = await tmpHome()
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-codexhome-'))

  const detected = await detectClientSources({ env: { HOME: home, CODEX_HOME: codexHome } })

  assert.equal(detected.has('codex'), true)
  assert.equal(detected.has('claude'), false)
})

test('a plain file (not a directory) at the config-home path does not count', async () => {
  const home = await tmpHome()
  // Write `.claude` as a file rather than a directory.
  await fs.writeFile(path.join(home, '.claude'), 'not a dir\n', 'utf8')

  const detected = await detectClientSources({ env: { HOME: home } })

  assert.equal(detected.has('claude'), false)
})
