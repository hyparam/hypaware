// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ensureDurableBinForNpx,
  globalHypawareBin,
  isNpxBinPath,
} from '../../src/core/cli/global_install.js'

test('isNpxBinPath detects npm _npx cache entries', () => {
  assert.equal(
    isNpxBinPath('/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js', {
      npm_config_cache: '/Users/hyp/.npm',
    }),
    true
  )
  assert.equal(
    isNpxBinPath('/Users/hyp/.npm-global/lib/node_modules/hypaware/bin/hypaware.js', {
      npm_config_cache: '/Users/hyp/.npm',
    }),
    false
  )
})

test('ensureDurableBinForNpx installs the current package globally and returns the global bin', async () => {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  const stdout = makeBuf()
  const env = { npm_config_cache: '/Users/hyp/.npm' }
  const packageSpec = await currentPackageSpec()

  const result = await ensureDurableBinForNpx({
    binPath: '/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js',
    env,
    stdout,
    stderr: makeBuf(),
    async runner(cmd, args) {
      calls.push({ cmd, args })
      if (args.join(' ') === 'config get prefix') {
        return { exitCode: 0, stdout: '/Users/hyp/.npm-global\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  assert.equal(result.installed, true)
  assert.equal(result.skipped, false)
  assert.equal(result.packageSpec, packageSpec)
  assert.equal(result.binPath, globalHypawareBin('/Users/hyp/.npm-global'))
  assert.deepEqual(calls[0], {
    cmd: 'npm',
    args: ['install', '-g', packageSpec],
  })
  assert.deepEqual(calls[1], {
    cmd: 'npm',
    args: ['config', 'get', 'prefix'],
  })
  assert.match(stdout.text(), /npx detected: installing durable CLI/)
})

test('ensureDurableBinForNpx leaves stable bin paths untouched', async () => {
  const binPath = path.resolve('/opt/hypaware/bin/hypaware.js')
  let called = false
  const result = await ensureDurableBinForNpx({
    binPath,
    env: { npm_config_cache: '/Users/hyp/.npm' },
    stdout: makeBuf(),
    stderr: makeBuf(),
    async runner() {
      called = true
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  assert.equal(result.binPath, binPath)
  assert.equal(result.skipped, true)
  assert.equal(result.installed, false)
  assert.equal(called, false)
})

test('ensureDurableBinForNpx reports npm install failures with a repair command', async () => {
  const packageSpec = await currentPackageSpec()

  await assert.rejects(
    ensureDurableBinForNpx({
      binPath: '/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js',
      env: { npm_config_cache: '/Users/hyp/.npm' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      async runner() {
        return { exitCode: 1, stdout: '', stderr: 'EACCES permission denied' }
      },
    }),
    new RegExp(`npm install -g ${escapeRegExp(packageSpec)} failed: EACCES permission denied`)
  )
})

async function currentPackageSpec() {
  const raw = await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')
  const pkg = JSON.parse(raw)
  return `${pkg.name}@${pkg.version}`
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
    },
    text() {
      return value
    },
  }
}
