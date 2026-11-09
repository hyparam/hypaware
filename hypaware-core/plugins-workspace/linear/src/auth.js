// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync, withFileLock } from 'hypaware/core/util'
import { browserLogin, refreshLinearToken, uuid } from './oauth.js'
import { linearError } from './http.js'

/** @import { LinearAuth, LinearConfig, LoginOptions, RequestOptions } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @param {string} stateDir */
export function linearCredentialsPath(stateDir) { return path.join(stateDir, 'auth', 'credentials.json') }

/** @param {string} stateDir */
function privateDirectory(stateDir) {
  const dir = path.dirname(linearCredentialsPath(stateDir))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(dir).isDirectory()) throw linearError('auth_store', 'credential directory is not a directory')
  fs.chmodSync(dir, 0o700)
}

/** @param {string} stateDir @returns {LinearAuth | null} */
export function readLinearAuth(stateDir) {
  try {
    const file = linearCredentialsPath(stateDir)
    const dir = fs.lstatSync(path.dirname(file))
    const stat = fs.lstatSync(file)
    if (!dir.isDirectory() || !stat.isFile() || stat.size > 64 * 1024 ||
        (process.platform !== 'win32' && ((dir.mode | stat.mode) & 0o077) !== 0)) throw new Error()
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!uuid(data.generation) || !['pending', 'active', 'logged_out'].includes(data.status)) throw new Error()
    if (data.status === 'active' && (!validToken(data.access_token) || !validToken(data.refresh_token) ||
        !Number.isFinite(data.expires_at) || typeof data.client_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.client_id) ||
        !uuid(data.account?.workspace_id) || !uuid(data.account?.user_id) || typeof data.account?.workspace !== 'string')) throw new Error()
    return data
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err)?.code
    if (code === 'ENOENT') return null
    if (code) throw linearError('auth_store', 'cannot read credential file; check local permissions and retry')
    throw linearError('auth_store', 'credential file is invalid or not private; run `hyp linear login` again')
  }
}

/** @param {unknown} value */
function validToken(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\s/.test(value) }

/** @param {string} stateDir @param {LinearAuth} record */
function write(stateDir, record) {
  privateDirectory(stateDir)
  atomicWriteJsonSync(linearCredentialsPath(stateDir), record, { mode: 0o600 })
  fs.chmodSync(linearCredentialsPath(stateDir), 0o600)
}

/** @template T @param {string} stateDir @param {() => Promise<T>} fn */
function locked(stateDir, fn) {
  privateDirectory(stateDir)
  return withFileLock(`${linearCredentialsPath(stateDir)}.lock`, fn)
}

/** @param {string} stateDir @param {LoginOptions} opts */
// @ref LLP 0592#authentication [implements]: a newer login/logout supersedes any unfinished browser authorization
export async function loginLinear(stateDir, opts) {
  if (!opts.clientId) throw linearError('client_id', 'set linear.client_id or LINEAR_CLIENT_ID to your registered public OAuth client ID')
  const generation = randomUUID()
  await locked(stateDir, async () => write(stateDir, { generation, status: 'pending' }))
  const { account, ...tokens } = await browserLogin(opts)
  await locked(stateDir, async () => {
    if (opts.signal?.aborted) throw linearError('cancelled', 'login cancelled')
    if (readLinearAuth(stateDir)?.generation !== generation) throw linearError('auth_changed', 'another login or logout superseded this login')
    write(stateDir, { ...tokens, client_id: opts.clientId, account, generation, status: 'active' })
  })
  return account
}

/** @param {string} stateDir */
export function logoutLinear(stateDir) {
  return locked(stateDir, async () => write(stateDir, { generation: randomUUID(), status: 'logged_out' }))
}

/** @param {LinearAuth | null} record @returns {asserts record is LinearAuth & { access_token: string, refresh_token: string, client_id: string, expires_at: number }} */
function requireActive(record) {
  if (!record || record.status !== 'active') throw linearError('auth_required', 'OAuth is logged out or incomplete; run `hyp linear login`')
}

/** @param {string} stateDir @param {RequestOptions} [opts] */
// @ref LLP 0592#authentication [implements]: refresh re-reads under the shared mutex and rotates only the still-selected grant
export async function resolveLinearOAuth(stateDir, opts = {}) {
  const record = readLinearAuth(stateDir)
  requireActive(record)
  const now = opts.now ?? Date.now
  if (record.expires_at > now() + 60000) return record.access_token
  return locked(stateDir, async () => {
    const current = readLinearAuth(stateDir)
    requireActive(current)
    if (current.expires_at > now() + 60000) return current.access_token
    const tokens = await refreshLinearToken(current.refresh_token, current.client_id, opts)
    const latest = readLinearAuth(stateDir)
    if (latest?.generation !== current.generation || latest.refresh_token !== current.refresh_token) throw linearError('auth_changed', 'credentials changed during refresh; retry')
    write(stateDir, { ...current, ...tokens })
    return tokens.access_token
  })
}

/** @param {string} stateDir @param {LinearConfig} config @param {NodeJS.ProcessEnv} env @param {RequestOptions} [opts] */
export async function linearAuthorization(stateDir, config, env, opts = {}) {
  const override = env[config.token_env]?.trim()
  if (override) return override
  return `Bearer ${await resolveLinearOAuth(stateDir, opts)}`
}
