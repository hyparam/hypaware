import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { RendezvousService } from '../rendezvous/service.js'

/**
 * @import { Server } from 'node:http'
 */

const DEFAULT_LISTEN = '0.0.0.0:8789'
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.hyp', 'collectivus', 'rendezvous')
const REGISTRATION_TOKEN_ENV = 'COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN'

const USAGE = `Usage:
  ctvs rendezvous [--listen <host:port>] [--data-dir <path>] --registration-token <token>

Options:
  --listen <host:port>          Address for the rendezvous HTTP server (default 0.0.0.0:8789)
  --data-dir <path>             Directory for rendezvous state (default ~/.hyp/collectivus/rendezvous)
  --registration-token <token>  Bearer token required for invite registration
                                (or ${REGISTRATION_TOKEN_ENV})
  --help, -h                    Show this help`

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ help: true, error?: undefined } | { help: false, listen: string, dataDir: string, registrationToken: string, error?: undefined } | { help: false, error: string }}
 */
export function parseRendezvousArgs(argv, env = process.env) {
  /** @type {string} */
  let listen = DEFAULT_LISTEN
  /** @type {string} */
  let dataDir = DEFAULT_DATA_DIR
  /** @type {string | undefined} */
  let registrationToken

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--listen' || arg.startsWith('--listen=')) {
      const value = arg === '--listen' ? argv[++i] : arg.slice('--listen='.length)
      if (!value) return parseError('--listen requires host:port')
      if (!isHostPort(value)) return parseError('--listen must be host:port')
      listen = value
      continue
    }
    if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      const value = arg === '--data-dir' ? argv[++i] : arg.slice('--data-dir='.length)
      if (!value) return parseError('--data-dir requires a path')
      dataDir = value
      continue
    }
    if (arg === '--registration-token' || arg.startsWith('--registration-token=')) {
      const value = arg === '--registration-token' ? argv[++i] : arg.slice('--registration-token='.length)
      if (!value) return parseError('--registration-token requires a token')
      registrationToken = value
      continue
    }
    return parseError(`unknown argument: ${arg}`)
  }

  registrationToken = registrationToken ?? env[REGISTRATION_TOKEN_ENV]
  if (!registrationToken) {
    return parseError(`--registration-token or ${REGISTRATION_TOKEN_ENV} is required`)
  }
  return { help: false, listen, dataDir, registrationToken }
}

/**
 * @param {string[]} argv
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   env?: NodeJS.ProcessEnv,
 *   onShutdownRequested?: (handler: (signal: string) => void) => void,
 *   serviceFactory?: (opts: { listen: string, dataDir: string, registrationToken: string }) => RendezvousService,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function runRendezvous(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const onShutdownRequested = hooks.onShutdownRequested ?? defaultSignalWiring
  const parsed = parseRendezvousArgs(argv, hooks.env ?? process.env)

  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  const opts = /** @type {{ help: false, listen: string, dataDir: string, registrationToken: string }} */ (parsed)

  const service = hooks.serviceFactory
    ? hooks.serviceFactory(opts)
    : new RendezvousService({
      listen: opts.listen,
      dataDir: opts.dataDir,
      registrationToken: opts.registrationToken,
    })

  try {
    await service.start()
  } catch (err) {
    stderr.write(`error: failed to start rendezvous listener: ${formatError(err)}\n`)
    return 1
  }

  const effective = effectiveBinding(service.server, service.host, service.port)
  stdout.write(`Rendezvous listener bound on ${effective}, storing invites in ${opts.dataDir}\n`)

  const signal = await new Promise((resolve) => {
    onShutdownRequested(resolve)
  })
  stdout.write(`Received ${signal}, shutting down...\n`)
  try {
    await service.stop()
  } catch (err) {
    stderr.write(`warning: error stopping rendezvous listener: ${formatError(err)}\n`)
  }
  stdout.write('Shutdown complete.\n')
  return 0
}

/**
 * @param {string} message
 * @returns {{ help: false, error: string }}
 */
function parseError(message) {
  return { help: false, error: message }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHostPort(value) {
  const idx = value.lastIndexOf(':')
  if (idx <= 0) return false
  const portStr = value.slice(idx + 1)
  const port = Number.parseInt(portStr, 10)
  return Number.isInteger(port) && port >= 0 && port <= 65535 && String(port) === portStr
}

/**
 * @param {(signal: string) => void} handler
 * @returns {void}
 */
function defaultSignalWiring(handler) {
  process.once('SIGINT', () => handler('SIGINT'))
  process.once('SIGTERM', () => handler('SIGTERM'))
}

/**
 * @param {Server | undefined} server
 * @param {string} fallbackHost
 * @param {number} fallbackPort
 * @returns {string}
 */
function effectiveBinding(server, fallbackHost, fallbackPort) {
  const addr = server?.address()
  if (addr && typeof addr !== 'string') {
    return `${addr.address}:${addr.port}`
  }
  return `${fallbackHost}:${fallbackPort}`
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
