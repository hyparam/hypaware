// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  HELPER_BASENAME,
  activate,
} from '../../hypaware-core/plugins-workspace/claude-desktop/src/index.js'

/**
 * Minimal activation context: capture registered commands and provide
 * the two required capabilities.
 *
 * @param {{ stateDir: string, mode: 'org_key' | 'subscription' }} opts
 */
function fakeCtx(opts) {
  /** @type {Map<string, any>} */
  const commands = new Map()
  return {
    ctx: {
      config: {},
      paths: { stateDir: opts.stateDir },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      configRegistry: { registerSection() {} },
      commands: { register(cmd) { commands.set(cmd.name, cmd) } },
      requireCapability(name) {
        if (name === 'hypaware.ai-gateway') return {}
        if (name === 'hypaware.anthropic-credential') {
          return { mode: opts.mode, helperCommandArgs: ['claude-account', 'credential'] }
        }
        throw new Error(`unexpected capability ${name}`)
      },
    },
    commands,
  }
}

/** @param {(argv: string[], cmdCtx: any) => Promise<number>} run */
async function invoke(run, argv, config) {
  let out = ''
  let err = ''
  const code = await run(argv, {
    stdout: { write: (s) => { out += s } },
    stderr: { write: (s) => { err += s } },
    env: {},
    config: config ?? { version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] },
  })
  return { code, out, err }
}

test('install-helper writes an executable no-arg wrapper under the state dir', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'subscription' })
  await activate(ctx)

  const install = commands.get('claude-desktop install-helper')
  const { code, out } = await invoke(install.run, [])
  assert.equal(code, 0)

  const helperPath = path.join(stateDir, HELPER_BASENAME)
  assert.ok(out.includes(helperPath))
  assert.ok(fs.existsSync(helperPath))
  const mode = fs.statSync(helperPath).mode & 0o777
  assert.equal(mode, 0o755)
  const body = fs.readFileSync(helperPath, 'utf8')
  assert.ok(body.startsWith('#!/bin/sh\n'))
  assert.ok(/exec .*claude-account credential/.test(body))
})

test('the generated wrapper runs its target with no arguments', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  // A fake "hyp" that echoes JSON only when called with exactly the two
  // credential args, proving the wrapper appends nothing.
  const fakeHyp = path.join(stateDir, 'fake-hyp.sh')
  fs.writeFileSync(fakeHyp,
    '#!/bin/sh\n'
    + 'if [ "$1" = "claude-account" ] && [ "$2" = "credential" ] && [ -z "$3" ]; then\n'
    + '  printf \'{"token":"t","headers":{},"ttlSec":60}\'\n'
    + 'else echo "bad args: $@" >&2; exit 2; fi\n',
    { mode: 0o755 })
  fs.chmodSync(fakeHyp, 0o755)

  const helperPath = path.join(stateDir, HELPER_BASENAME)
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'subscription' })
  await activate(ctx)
  const install = commands.get('claude-desktop install-helper')
  // install-helper embeds resolveHypBin()/process.execPath, so hand-write
  // an equivalent wrapper against the fake to exercise no-arg exec. The
  // fake already includes its own `#!/bin/sh`, so exec it directly.
  fs.writeFileSync(helperPath, `#!/bin/sh\nexec ${fakeHyp} claude-account credential\n`, { mode: 0o755 })
  fs.chmodSync(helperPath, 0o755)

  const stdout = execFileSync(helperPath, [], { encoding: 'utf8' })
  assert.equal(stdout, '{"token":"t","headers":{},"ttlSec":60}')
  assert.ok(install, 'install-helper command registered')
})

test('status reports the helper as not installed until install-helper runs', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'))
  const { ctx, commands } = fakeCtx({ stateDir, mode: 'org_key' })
  await activate(ctx)
  const status = commands.get('claude-desktop status')

  const before = await invoke(status.run, [])
  assert.equal(before.code, 1)
  assert.ok(/NOT installed/.test(before.out))
  assert.ok(/scheme x-api-key/.test(before.out))

  await invoke(commands.get('claude-desktop install-helper').run, [])
  const after = await invoke(status.run, [])
  assert.equal(after.code, 0)
  assert.ok(/installed/.test(after.out))
})
