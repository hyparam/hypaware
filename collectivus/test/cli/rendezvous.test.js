import { describe, expect, it } from 'vitest'
import { parseRendezvousArgs, runRendezvous } from '../../src/cli/rendezvous.js'

function memo() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
  }
}

describe('rendezvous CLI', () => {
  it('prints help', async () => {
    const stdout = memo()
    const code = await runRendezvous(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:\s+ctvs rendezvous/)
  })

  it('requires a registration token from flag or env', () => {
    const r = parseRendezvousArgs([], {})
    expect(r.help).toBe(false)
    if (!r.help) expect(r.error).toMatch(/registration-token/)
  })

  it('uses COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN as fallback', () => {
    const r = parseRendezvousArgs(['--listen', '127.0.0.1:8789', '--data-dir', '/tmp/rv'], {
      COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN: 'env-token',
    })
    expect(r).toEqual({
      help: false,
      listen: '127.0.0.1:8789',
      dataDir: '/tmp/rv',
      registrationToken: 'env-token',
    })
  })

  it('rejects invalid listen addresses', () => {
    const r = parseRendezvousArgs(['--listen', 'not-a-listen', '--registration-token', 't'], {})
    expect(r.help).toBe(false)
    if (!r.help) expect(r.error).toMatch(/host:port/)
  })

  it('starts and stops a service from parsed options', async () => {
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    let started = false
    let stopped = false
    const codePromise = runRendezvous(
      ['--listen', '127.0.0.1:0', '--data-dir', '/tmp/rv', '--registration-token', 't'],
      {
        stdout,
        stderr,
        onShutdownRequested(handler) { trigger = handler },
        serviceFactory(opts) {
          expect(opts.registrationToken).toBe('t')
          return /** @type {import('../../src/rendezvous/service.js').RendezvousService} */ ({
            host: '127.0.0.1',
            port: 0,
            dataDir: opts.dataDir,
            server: undefined,
            start() { started = true; return Promise.resolve() },
            stop() { stopped = true; return Promise.resolve() },
          })
        },
      }
    )
    await waitFor(() => started)
    trigger('SIGTERM')
    expect(await codePromise).toBe(0)
    expect(stopped).toBe(true)
    expect(stdout.value()).toMatch(/Rendezvous listener bound/)
  })
})

/**
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitFor(predicate) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function noop() {}
