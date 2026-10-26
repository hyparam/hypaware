// @ts-check

/**
 * Whether the system trusts the local CA the gateway's proxy mode uses.
 *
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ProxyTrustReport } from '../../../../src/core/daemon/types.js'
 * @import { LocalCaInfo } from '../../../../src/core/tls/types.js'
 */

import { displayableCaHosts, readLocalCaInfo } from '../../tls/ca.js'
import { GATEWAY_PLUGIN_NAME } from './gateway.js'

/**
 * How long either trust probe may take before `hyp status` gives up on it.
 *
 * Both are table reads (`security verify-cert` against a local root with no
 * AIA to chase, `launchctl getenv`), so the bound is not a performance
 * budget: it is there because a locked login keychain can put `security`
 * behind a GUI prompt, and `hyp status` is a report, not a dialog - nobody
 * is watching it who could decide to stop waiting. Timing out reports
 * `unknown` for that half, which is the honest answer and is exactly what
 * the probe-failure path already renders.
 */
export const TRUST_PROBE_TIMEOUT_MS = 5_000

/**
 * Proxy mode's two invisible preconditions, read once so `hyp status` can
 * state them: does the login keychain still trust the CA on disk
 * (LLP 0237), and is `NODE_USE_SYSTEM_CA` live in the launchd user
 * environment (LLP 0239)? Neither is inferable from anything else the
 * report carries, and a CA re-mint strands the first silently, so an attach
 * that worked last month can stop working with every other line healthy.
 *
 * Null rather than a row of unknowns when the question does not apply: off
 * darwin neither mechanism exists (LLP 0237#darwin-only, LLP 0239's
 * "non-macOS platforms skip this entirely"), and with no CA on disk proxy
 * mode was never on, so there is nothing to be trusted or untrusted.
 *
 * The two probes shell out, so each is settled independently: a probe that
 * could not run reports `null` (unknown), never `false`, because "the
 * dialog was cancelled" and "`security` did not run" are different answers
 * and only the first is actionable. "Did not run" covers one case a try/catch
 * cannot reach on its own: a probe that never returns. Both probes therefore
 * spawn on a deadline (`TRUST_PROBE_TIMEOUT_MS`) and reject when it passes,
 * and they are started concurrently so the worst case is one deadline rather
 * than the sum of both. An offline or captive-portal host, where macOS trust
 * evaluation can sit on a revocation fetch indefinitely, then still gets a
 * rendered report with these lines unknown instead of a `hyp status` that
 * never prints. The fingerprint is computed locally from the DER and is
 * `[0-9A-F:]` by construction, and probe stderr is deliberately not surfaced,
 * so neither of those needs sanitizing.
 *
 * The permitted host set travels with the fingerprint because the grant is
 * wider than any one install uses: the CA is constrained to the whole static
 * provider set, so a user who trusts it while capturing only Claude still
 * carries a grant covering `api.openai.com` and `chatgpt.com`. The attach
 * dialog names them; so must this, or the standing grant is only ever stated
 * once, at the moment it is asked for. The strings come from the DER's own
 * permitted subtrees, so they are the grant itself rather than a
 * config-derived guess that could drift from it.
 *
 * That last property is also why the hosts are the one field here that does
 * need sanitizing (LLP 0225): they are bytes off disk rather than strings we
 * wrote, so a foreign or damaged certificate at the CA path can carry an
 * `ESC` run, a newline, or ten thousand subtrees into a line `hyp status`
 * prints. `displayableCaHosts` is that policy, shared with the attach dialog
 * that names the same grant, and applied here at collection like every other
 * label in this file so `--json` carries exactly what was printed.
 *
 * The effective config rides along because the CA alone cannot say whether
 * it is live or residue: `proxy_mode: true` makes the gateway re-mint and
 * present it on every start, and that is the difference between "this file
 * is safe to purge" and "purging this file breaks the running interception".
 *
 * @param {object} args
 * @param {NodeJS.Platform} args.platform
 * @param {string} args.stateRoot
 * @param {HypAwareV2Config | null} args.config
 * @param {(args: { certPath: string }) => Promise<boolean>} args.isCaTrustedFn
 * @param {() => Promise<boolean>} args.isLaunchdEnvSetFn
 * @returns {Promise<ProxyTrustReport | null>}
 * @ref LLP 0237#consequences [implements]: hyp status reports the trust state alongside the CA fingerprint, so a cancelled dialog is diagnosable without re-running attach
 * @ref LLP 0238#consequences [implements]: hyp status names all permitted hosts, so a grant wider than the configured providers stays informed
 * @ref LLP 0239#terminals-predating-attach [implements]: hyp status reports whether the variable is present in the launchd environment
 */
export async function collectProxyTrust({ platform, stateRoot, config, isCaTrustedFn, isLaunchdEnvSetFn }) {
  if (platform !== 'darwin') return null
  /** @type {LocalCaInfo | undefined} */
  let ca
  try {
    ca = await readLocalCaInfo({ stateRoot })
  } catch {
    return null
  }
  if (!ca) return null

  // Started together, not one after the other: the two probes read
  // unrelated system state (the login keychain, the launchd environment) and
  // neither reads the other's answer, so serializing them only adds their
  // deadlines. On the wedged host this bound exists for that is the
  // difference between the report stalling for one probe timeout and for
  // two. `allSettled` keeps the per-probe independence the catches gave: one
  // rejection reports its own line unknown and leaves the other's answer.
  const [trustedResult, launchdResult] = await Promise.allSettled([
    isCaTrustedFn({ certPath: ca.certPath }),
    isLaunchdEnvSetFn(),
  ])
  /** @type {boolean | null} */
  const trusted = trustedResult.status === 'fulfilled' ? trustedResult.value : null
  /** @type {boolean | null} */
  const launchdEnvSet = launchdResult.status === 'fulfilled' ? launchdResult.value : null

  // Tri-state for the same reason the two probes above are: a plain `false`
  // sends the caller's note to "this CA is residue, purge it", which is the
  // wrong advice for a machine whose gateway is still intercepting. `config`
  // is null when the local config would not parse and no central layer covers
  // for it, and a config we could not read is not a config with `proxy_mode`
  // off. A disabled gateway entry is skipped for the same reason
  // `activePlugins` skips it: it is not what runs.
  /** @type {boolean | null} */
  const proxyModeConfigured = config === null
    ? null
    : (config.plugins ?? []).some(
      (entry) =>
        entry.name === GATEWAY_PLUGIN_NAME &&
        entry.enabled !== false &&
        entry.config?.proxy_mode === true
    )

  return {
    caFingerprint: ca.fingerprint,
    hosts: displayableCaHosts(ca.hosts),
    trusted,
    launchdEnvSet,
    proxyModeConfigured,
  }
}
