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
 * `timeoutMs` bounds the spawn for callers that cannot afford to block on it.
 * Silent is the expectation, not a guarantee: a locked login keychain can put
 * `security` in front of a GUI prompt, and macOS trust evaluation can reach
 * the network for revocation, so on an offline or captive-portal host this is
 * not a slow command but one that may never return. A caller nobody is
 * watching (`hyp status`) would then wait on an answer forever, and reads the
 * rejection as unknown instead. Left unset the wait is unbounded, which is
 * what an interactive attach wants.
 * @ref LLP 0237#consequences [constrained-by]: hyp status has to be able to state the trust line, so the probe behind it must be able to give up
 *
 * @param {object} args
 * @param {string} args.certPath
 * @param {TrustCommandRunner} [args.run]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isCaTrusted({ certPath, run, timeoutMs }) {
  const runner = run ?? ((cmd, cmdArgs) => runServiceCommand(cmd, cmdArgs, { timeoutMs }))
  const result = await runner('security', ['verify-cert', '-c', certPath, '-p', 'ssl'])
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
 * How many `delete-certificate` passes a single removal will make. High
 * enough to clear any plausible re-mint history, low enough that a
 * `security` build which somehow kept reporting success could never spin
 * here. Exhausting it is reported, never silently accepted.
 */
const MAX_TRUST_REMOVAL_PASSES = 8

/**
 * Remove the CA and its trust settings from the login keychain. `-t` deletes
 * the user-domain trust settings along with the certificate, mirroring the
 * install; without it a removed certificate leaves orphaned trust behind.
 *
 * `delete-certificate -c` addresses a certificate by common name, and every
 * CA this product mints carries the same one, so a machine whose CA has been
 * re-minted holds several indistinguishable trusted roots. One invocation
 * clears one of them; the rest would outlive the uninstall that was supposed
 * to end the grant, each still vouching for the provider set, and none of
 * them holding a key the user still has. So this deletes in a bounded loop
 * until the keychain reports no match left, which is also why "could not be
 * found" has to read as the end state rather than as a failure.
 * @ref LLP 0238#ca-survives-detach [implements]: uninstall and purge are the two paths that end the grant, so they must end all of it
 *
 * Idempotent at every entry point: a keychain with no matching certificate
 * makes the first pass the last one and reports `removed: false` with no
 * detail, which is the desired end state and not an error.
 *
 * @param {object} args
 * @param {string} [args.homeDir]
 * @param {TrustCommandRunner} [args.run]
 * @returns {Promise<{ removed: boolean, detail?: string }>}
 */
export async function removeCaTrust({ homeDir, run = defaultRunner }) {
  const args = [
    'delete-certificate',
    '-c', CA_COMMON_NAME,
    '-t',
    loginKeychainPath(homeDir),
  ]
  let removed = false
  for (let pass = 0; pass < MAX_TRUST_REMOVAL_PASSES; pass += 1) {
    const result = await run('security', args)
    if (result.exitCode === 0) {
      removed = true
      continue
    }
    const detail = (result.stderr || result.stdout).trim()
    // Nothing left under this common name: the loop's exit condition, and on
    // the first pass the already-clean case.
    if (/could not be found|SecKeychainSearchCopyNext/i.test(detail)) return { removed }
    return { removed, detail: detail || `exit ${result.exitCode}` }
  }
  return {
    removed,
    detail:
      `stopped after ${MAX_TRUST_REMOVAL_PASSES} passes; more certificates named ` +
      `'${CA_COMMON_NAME}' may remain - remove them in Keychain Access`,
  }
}
