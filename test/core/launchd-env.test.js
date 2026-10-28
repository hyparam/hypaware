// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ENV_VAR_NAME,
  envAgentPlistPath,
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

test('remove unsets the variable and deletes the plist, idempotently', async (t) => {
  const homeDir = await tempHome()
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }))
  const plistPath = envAgentPlistPath(homeDir)
  await fsp.mkdir(path.dirname(plistPath), { recursive: true })
  await fsp.writeFile(plistPath, 'legacy launch agent')

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
