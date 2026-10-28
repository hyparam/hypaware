// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { withNodeBinOnPath } from '../../../../src/core/update/self_update.js'

/** Errors intentionally contain no child-process, server or credential text. */
export class CloudError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`codex-cloud: ${code}`)
    this.code = code
  }
}

/** @param {string} codexHome */
export async function readCloudAuth(codexHome) {
  try {
    const file = await fs.open(path.join(codexHome, 'auth.json'), 'r')
    let raw
    try {
      if ((await file.stat()).size > 128 * 1024) throw new CloudError('auth_file_too_large')
      raw = JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
    if (raw.auth_mode !== 'chatgpt') throw new CloudError('chatgpt_login_required')
    const token = raw.tokens?.access_token
    if (typeof token !== 'string' || token.length > 100000 || token.startsWith('sk-')) throw new CloudError('chatgpt_login_required')
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    const account = claims['https://api.openai.com/auth']?.chatgpt_account_id
    if (typeof account !== 'string' || !account || typeof claims.sub !== 'string' || !claims.sub
      || raw.tokens.account_id !== account || !Number.isFinite(claims.exp)) throw new CloudError('invalid_account_identity')
    return { token, expiresAt: claims.exp * 1000,
      accountHash: createHash('sha256').update(JSON.stringify([claims.sub, account])).digest('hex') }
  } catch (error) {
    if (error instanceof CloudError) throw error
    throw new CloudError('file_backed_login_required')
  }
}

/**
 * A short-lived official Codex auth helper. No model turn or login ceremony.
 * @param {string} codexHome
 * @param {NodeJS.ProcessEnv} env
 * @param {AbortSignal} signal
 */
export function openAuthHelper(codexHome, env, signal) {
  const child = spawn('codex', ['app-server', '--stdio'], {
    // Service managers omit npm's bin directory and the node needed by its shims.
    cwd: tmpdir(), env: { ...withNodeBinOnPath(env), CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let sequence = 0
  let buffered = ''
  let bytes = 0
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
  const pending = new Map()
  /** @type {CloudError | undefined} */
  let failed
  /** @param {string} code */
  const fail = code => {
    failed = new CloudError(code)
    for (const p of pending.values()) p.reject(failed)
    pending.clear()
  }
  const abort = () => {
    fail('auth_cancelled')
    child.kill('SIGTERM')
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  child.stderr.resume()
  child.on('error', () => fail('codex_unavailable'))
  child.on('exit', () => fail('auth_helper_exited'))
  child.stdin.on('error', () => fail('auth_helper_exited'))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 1024 * 1024) {
      fail('auth_response_limit')
      child.kill()
      return
    }
    buffered += chunk
    let end
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      try {
        const message = JSON.parse(line)
        const p = pending.get(message.id)
        if (!p) continue
        pending.delete(message.id)
        if (message.error) p.reject(new CloudError('codex_auth_failed'))
        else p.resolve(message.result)
      } catch { fail('invalid_auth_response') }
    }
  })
  return {
    /** @param {string} method @param {object} params */
    call(method, params) {
      if (failed) return Promise.reject(failed)
      const id = ++sequence
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    },
    initialized() { child.stdin.write('{"method":"initialized","params":{}}\n') },
    close() {
      signal.removeEventListener('abort', abort)
      fail('auth_helper_closed')
      child.stdin.end()
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      timer.unref()
      child.once('exit', () => clearTimeout(timer))
    },
  }
}

// @ref LLP 0511#authentication: Codex owns rotation and persistence; never copy refresh tokens.
/**
 * @param {{codexHome: string, env: NodeJS.ProcessEnv, accountHash?: string, signal?: AbortSignal, allowRefresh?: boolean}} opts
 * @param {{open?: typeof openAuthHelper, read?: typeof readCloudAuth, now?: () => number}} [deps]
 */
export async function acquireCloudAuth(opts, deps = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(45000), ...(opts.signal ? [opts.signal] : [])])
  signal.throwIfAborted()
  const read = deps.read ?? readCloudAuth
  const helper = (deps.open ?? openAuthHelper)(opts.codexHome, opts.env, signal)
  try {
    await helper.call('initialize', { clientInfo: { name: 'hypaware_cloud', title: 'HypAware cloud collector', version: '1' } })
    helper.initialized()
    const config = await helper.call('config/read', { includeLayers: false })
    if (!config?.config || typeof config.config !== 'object') throw new CloudError('invalid_auth_config')
    const store = config?.config?.cli_auth_credentials_store
    if (store !== undefined && store !== 'file') throw new CloudError('file_credential_store_required')
    const state = await helper.call('account/read', { refreshToken: false })
    if (state?.account?.type !== 'chatgpt') throw new CloudError('chatgpt_login_required')
    let auth = await read(opts.codexHome)
    const expected = opts.accountHash ?? auth.accountHash
    if (auth.accountHash !== expected) throw new CloudError('account_changed_reconnect_required')
    if (auth.expiresAt <= (deps.now ?? Date.now)() + 300000) {
      if (opts.allowRefresh === false) throw new CloudError('login_refresh_required')
      await helper.call('account/read', { refreshToken: true })
      auth = await read(opts.codexHome)
    }
    if (auth.accountHash !== expected) throw new CloudError('account_changed_reconnect_required')
    if (auth.expiresAt <= (deps.now ?? Date.now)()) throw new CloudError('codex_sign_in_required')
    signal.throwIfAborted()
    return auth
  } catch (error) {
    if (error instanceof CloudError) throw error
    throw new CloudError(signal.aborted ? 'auth_cancelled' : 'codex_auth_failed')
  } finally { helper.close() }
}
