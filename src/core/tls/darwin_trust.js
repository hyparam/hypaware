// @ts-check

import os from 'node:os'
import path from 'node:path'

import { runServiceCommand } from '../daemon/service_ops.js'

/**
 * macOS keychain trust for the interception CA.
 *
 * File-scoped trust (`NODE_EXTRA_CA_CERTS`) does not reach Claude Code's SSE
 * transport, so proxy-mode attach installs the CA as a user-domain trusted
 * root in the login keychain. No `sudo`, no admin rights: `security
 * add-trusted-cert` against the login keychain makes macOS raise its own
 * native password dialog, and that dialog is the consent step.
 * @ref LLP 0236#user-domain-suffices [constrained-by]: only the keychain reaches both of Claude Code's trust stores
 * @ref LLP 0237#user-domain-trust [implements]
 *
 * This lives in core beside the CA lifecycle for the same reason the CA does
 * (LLP 0045 Part 3): uninstall and `hyp detach --purge` must be able to
 * remove the trust with no plugin loaded.
 *
 * Every function takes an injectable runner so tests never touch the real
 * keychain; the default is the same spawn wrapper the launchd installer uses.
 *
 * @import { TrustCommandRunner } from '../../../src/core/tls/types.js'
 */

/**
 * The certificate common name trust operations key on. Must match the CN in
 * `CA_SUBJECT` (`ca.js`); the round-trip test asserts the two never drift.
 */
export const CA_COMMON_NAME = 'HypAware Local CA'

/** @type {TrustCommandRunner} */
const defaultRunner = (cmd, args) => runServiceCommand(cmd, args)

/**
 * The user's login keychain, where user-domain trust lives.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function loginKeychainPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'Keychains', 'login.keychain-db')
}

/**
 * Whether the CA at `certPath` already verifies against the keychain's trust
 * settings. Read-only and silent, so attach can probe before deciding whether
 * to show the user a password dialog at all.
 * @ref LLP 0237#trust-preflight-is-idempotent [implements]
 *
 * @param {object} args
 * @param {string} args.certPath
 * @param {TrustCommandRunner} [args.run]
 * @returns {Promise<boolean>}
 */
export async function isCaTrusted({ certPath, run = defaultRunner }) {
  const result = await run('security', ['verify-cert', '-c', certPath, '-p', 'ssl'])
  return result.exitCode === 0
}

/**
 * Install the CA as a user-domain trusted root in the login keychain. macOS
 * raises its native password dialog; a user who cancels it makes the command
 * exit non-zero, which is a refusal, not an error - the caller degrades and
 * says what will not work.
 * @ref LLP 0237#attach-anyway-on-refusal [constrained-by]: refusal must surface as a warning, never abort the attach
 *
 * @param {object} args
 * @param {string} args.certPath
 * @param {string} [args.homeDir]
 * @param {TrustCommandRunner} [args.run]
 * @returns {Promise<{ installed: boolean, detail?: string }>}
 */
export async function installCaTrust({ certPath, homeDir, run = defaultRunner }) {
  const result = await run('security', [
    'add-trusted-cert',
    '-r', 'trustRoot',
    '-k', loginKeychainPath(homeDir),
    certPath,
  ])
  if (result.exitCode === 0) return { installed: true }
  return { installed: false, detail: (result.stderr || result.stdout).trim() || `exit ${result.exitCode}` }
}

/**
 * Remove the CA and its trust settings from the login keychain. `-t` deletes
 * the user-domain trust settings along with the certificate, mirroring the
 * install; without it a removed certificate leaves orphaned trust behind.
 *
 * Idempotent: a certificate that is not there is the desired end state, and
 * `security` reporting "could not be found" is success.
 *
 * @param {object} args
 * @param {string} [args.homeDir]
 * @param {TrustCommandRunner} [args.run]
 * @returns {Promise<{ removed: boolean, detail?: string }>}
 */
export async function removeCaTrust({ homeDir, run = defaultRunner }) {
  const result = await run('security', [
    'delete-certificate',
    '-c', CA_COMMON_NAME,
    '-t',
    loginKeychainPath(homeDir),
  ])
  if (result.exitCode === 0) return { removed: true }
  const detail = (result.stderr || result.stdout).trim()
  if (/could not be found|SecKeychainSearchCopyNext/i.test(detail)) return { removed: false }
  return { removed: false, detail: detail || `exit ${result.exitCode}` }
}
