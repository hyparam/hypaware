import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runConfig } from '../../src/cli/config.js'
import { runJoin } from '../../src/cli/join.js'
import { RendezvousService } from '../../src/rendezvous/service.js'
import { ControlPlane } from '../../src/server/control_plane.js'
import { BootstrapStore } from '../../src/server/identity.js'

const SECRET = 'a'.repeat(32)
const REGISTRATION_TOKEN = 'admin-registration-token'

function memo() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
  }
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('rendezvous join e2e', () => {
  /** @type {string} */
  let tmpDir
  /** @type {ControlPlane | undefined} */
  let central
  /** @type {RendezvousService | undefined} */
  let rendezvous
  /** @type {string} */
  let centralUrl
  /** @type {string} */
  let rendezvousUrl
  /** @type {string} */
  let bootstrapStorePath

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-rendezvous-e2e-'))
    bootstrapStorePath = path.join(tmpDir, 'bootstrap.json')
    const store = new BootstrapStore({ path: bootstrapStorePath })

    central = new ControlPlane({
      control_plane_listen: '127.0.0.1:0',
      data_dir: path.join(tmpDir, 'server-data'),
      identity_issuer: { secret: SECRET, bootstrap_store_path: bootstrapStorePath },
    }, { bootstrapStore: store })
    await central.start()
    const centralAddr = central.server?.address()
    if (!centralAddr || typeof centralAddr === 'string') throw new Error('no central address')
    centralUrl = `http://127.0.0.1:${centralAddr.port}`

    rendezvous = new RendezvousService({
      listen: '127.0.0.1:0',
      dataDir: path.join(tmpDir, 'rendezvous'),
      registrationToken: REGISTRATION_TOKEN,
      cleanupIntervalMs: 0,
    })
    await rendezvous.start()
    const rendezvousAddr = rendezvous.server?.address()
    if (!rendezvousAddr || typeof rendezvousAddr === 'string') throw new Error('no rendezvous address')
    rendezvousUrl = `http://127.0.0.1:${rendezvousAddr.port}`
  })

  afterEach(async () => {
    if (rendezvous) await rendezvous.stop()
    if (central) await central.stop()
    rendezvous = undefined
    central = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('issues through rendezvous, then join resolves and bootstraps directly against Central', async () => {
    const issueStdout = memo()
    const issueStderr = memo()
    const serverConfig = {
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        data_dir: path.join(tmpDir, 'server-data'),
        public_url: centralUrl,
        identity_issuer: {
          secret: SECRET,
          bootstrap_store_path: bootstrapStorePath,
        },
      },
    }

    const issueCode = await runConfig(
      [
        'bootstrap-token', 'issue', 'gw-rv-e2e',
        '--server-config', path.join(tmpDir, 'server.json'),
        '--rendezvous', rendezvousUrl,
      ],
      {
        stdout: issueStdout,
        stderr: issueStderr,
        isTTY: false,
        env: { COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN: REGISTRATION_TOKEN },
        loadConfig() { return /** @type {import('../../src/types.js').CollectivusConfig} */ (serverConfig) },
      }
    )
    expect(issueCode).toBe(0)
    expect(issueStdout.value().trim()).toMatch(/^[A-Z2-9]{10}$/)
    expect(issueStderr.value()).toMatch(/npx collectivus join/)

    const joinStdout = memo()
    const joinStderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const joinPromise = runJoin(
      [issueStdout.value().trim(), '--rendezvous', rendezvousUrl],
      {},
      {
        stdout: joinStdout,
        stderr: joinStderr,
        identityPersistedPath: path.join(tmpDir, 'identity.json'),
        onShutdownRequested(handler) { trigger = handler },
      }
    )

    await waitFor(() => joinStdout.value().includes('Config poll loop active'))
    trigger('SIGTERM')
    expect(await joinPromise).toBe(0)
    expect(joinStdout.value()).toMatch(/Identity bootstrapped for gw-rv-e2e/)
    expect(joinStdout.value()).toMatch(/Config poll loop active/)

    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf8'))
    expect(persisted.gateway_id).toBe('gw-rv-e2e')
    expect(joinStderr.value()).not.toMatch(/failed to reach rendezvous/)
  })
})

function noop() {}
