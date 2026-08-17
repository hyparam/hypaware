// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ENV_AGENT_LABEL,
  ENV_VAR_NAME,
  buildEnvAgentPlist,
  envAgentPlistPath,
  installLaunchdEnv,
  isLaunchdEnvSet,
  removeLaunchdEnv,
} from '../../src/core/daemon/launchd_env.js'

/**
 * @import { TrustCommandRunner } from '../../src/core/tls/types.js'
 */

/**
 * @param {{ exitCode: number, stdout?: string, stderr?: string }} result
 */
function recordingRunner(result) {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  /** @type {TrustCommandRunner} */
  const run = async (cmd, args) => {
    calls.push({ cmd, args })
    return { stdout: '', stderr: '', ...result }
  }
  return { calls, run }
}

async function tempHome() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-launchd-env-'))
}

test('install sets the variable now and persists the login-time agent', async (t) => {
  const homeDir = await tempHome()
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }))
  const { calls, run } = recordingRunner({ exitCode: 0 })

  const result = await installLaunchdEnv({ homeDir, run })

  assert.equal(result.set, true)
  assert.deepEqual(calls, [
    { cmd: 'launchctl', args: ['setenv', ENV_VAR_NAME, '1'] },
  ])
  const plist = await fsp.readFile(result.plistPath, 'utf8')
  assert.match(plist, new RegExp(ENV_AGENT_LABEL))
  assert.match(plist, /RunAtLoad/)
  assert.match(plist, new RegExp(`<string>${ENV_VAR_NAME}</string>`))
  // No KeepAlive: the agent runs once per login and exits.
  assert.doesNotMatch(plist, /KeepAlive/)
})

// A setenv that failed must not leave a plist promising the variable at the
// next login: the on-disk agent would then claim a state the session never had.
test('a failed setenv writes no plist', async (t) => {
  const homeDir = await tempHome()
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }))
  const { run } = recordingRunner({ exitCode: 1, stderr: 'nope' })

  const result = await installLaunchdEnv({ homeDir, run })

  assert.equal(result.set, false)
  assert.match(result.detail ?? '', /nope/)
  await assert.rejects(fsp.stat(envAgentPlistPath(homeDir)), /ENOENT/)
})

test('remove unsets the variable and deletes the plist, idempotently', async (t) => {
  const homeDir = await tempHome()
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }))
  const install = recordingRunner({ exitCode: 0 })
  await installLaunchdEnv({ homeDir, run: install.run })

  const { calls, run } = recordingRunner({ exitCode: 0 })
  const removal = await removeLaunchdEnv({ homeDir, run })

  assert.equal(removal.unset, true)
  assert.equal(removal.removedPlist, true)
  assert.deepEqual(calls, [
    { cmd: 'launchctl', args: ['unsetenv', ENV_VAR_NAME] },
  ])

  // Second removal: nothing to unlink, still clean.
  const again = await removeLaunchdEnv({ homeDir, run })
  assert.equal(again.removedPlist, false)
})

test('isLaunchdEnvSet requires the exact value', async () => {
  const set = recordingRunner({ exitCode: 0, stdout: '1\n' })
  assert.equal(await isLaunchdEnvSet({ run: set.run }), true)

  const unset = recordingRunner({ exitCode: 0, stdout: '\n' })
  assert.equal(await isLaunchdEnvSet({ run: unset.run }), false)
})

test('the plist XML parses as a well-formed property list shape', () => {
  const xml = buildEnvAgentPlist()
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(xml, /<plist version="1\.0">/)
  assert.match(xml, /<\/plist>\n$/)
  assert.match(xml, /\/bin\/launchctl/)
})
