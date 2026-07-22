// @ts-check

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { LayeredProvenance, LoginLaneResult, RunWizardJoinOptions, WizardJoinResult } from '../../../../src/core/cli/wizard/types.js'
 */

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { resolveConfigPath, resolveLayeredConfigFromDisk } from '../../runtime/boot.js'
import {
  LOGIN_NO_MEMBERSHIP_MESSAGE,
  LOGIN_ORG_NOT_PERMITTED_MESSAGE,
  runRemoteLogin,
  waitForCentralConverge,
} from '../remote_commands.js'
import { classifyClientProvenance } from './provenance.js'

/**
 * The join phase's org-config convergence budget (LLP 0129: "seconds to a
 * minute"). Reuses the login lane's own reconcile-wait via
 * `waitForCentralConverge`; this is the ceiling the wizard is willing to
 * block for a locked picker before falling through to an unlocked one.
 */
export const ORG_CONFIG_WAIT_MS = 60000

/**
 * The wizard's join phase (LLP 0135 #join). A thin narration wrapper around
 * the existing `hyp remote login` machinery, never a second enrollment
 * mechanism (`@ref LLP 0134#login-lane`): it runs `runRemoteLogin`, waits
 * (bounded) for the daemon to converge on the org config, and computes the
 * set of picker source ids the central layer owns so the pick phase can
 * lock them (`@ref LLP 0129#join-before-picker`).
 *
 * Three outcomes:
 * - **login failed** (non-zero exit): classify the login lane's own D7
 *   taxonomy into `'failed' | 'abandoned'` and return it; `runInitWizard`
 *   prints it and re-presents the fork (`@ref LLP 0129#failed-join-returns-to-fork`).
 * - **converged**: resolve the two-layer config from disk and lock every
 *   picker row whose owning plugin is in the central layer.
 * - **timed out / no-org-config 404**: narrate and return `'ok'` with an
 *   empty lock set rather than blocking - nothing is pinned, so the picker
 *   composes freely (LLP 0129).
 *
 * @ref LLP 0134#login-lane [implements]: "Join a team" wraps `runRemoteLogin`; the wizard adds narration and the locked-row computation, not a second enrollment path.
 *
 * @param {RunWizardJoinOptions} opts
 * @returns {Promise<WizardJoinResult>}
 */
export async function runWizardJoin(opts) {
  const log = getLogger('wizard')
  return withSpan(
    'wizard.join',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.join',
      status: 'ok',
    },
    async (span) => {
      const result = await runJoinFlow(opts, span)
      setSpanAttr(span, 'join_status', result.status)
      log.info('wizard.join', {
        [Attr.COMPONENT]: 'wizard',
        join_status: result.status,
        locked_count: result.lockedSources?.length ?? 0,
      })
      return result
    },
    { component: 'wizard' }
  )
}

/**
 * The join flow proper, inside the span so its branches can annotate it.
 *
 * @param {RunWizardJoinOptions} opts
 * @param {{ setAttribute?: (key: string, value: unknown) => void }} [span]
 * @returns {Promise<WizardJoinResult>}
 */
async function runJoinFlow(opts, span) {
  opts.stdout.write('Joining your team...\n')

  const runLogin = opts.runLogin ?? (() => defaultRunLogin(opts))
  const login = await runLogin()
  if (login.exitCode !== 0) {
    const status = classifyLoginFailure(login)
    setSpanAttr(span, 'status', 'error')
    setSpanAttr(span, Attr.ERROR_KIND, status === 'failed' ? 'login_rejected' : 'login_abandoned')
    return { status, detail: login.stderr }
  }

  opts.stdout.write("Applying your org's configuration...\n")
  const waitForConverge = opts.waitForConverge ?? waitForCentralConverge
  const started = Date.now()
  const converge = await waitForConverge({ env: opts.env }, { timeoutMs: ORG_CONFIG_WAIT_MS })
  setSpanAttr(span, 'wait_ms', Date.now() - started)
  setSpanAttr(span, 'converged', converge.ok)
  if (!converge.ok) {
    // Timeout or the no-org-config 404 steady state: nothing landed to lock.
    // Narrate and continue with an unlocked picker rather than blocking.
    opts.stdout.write("Didn't hear back from your org's config in time; continuing with an unlocked picker.\n")
    return { status: 'ok', lockedSources: [] }
  }

  const resolveLayered = opts.resolveLayered ?? (() => defaultResolveLayered(opts))
  const layered = await resolveLayered()
  // The pick phase locks a row iff the central layer owns it (LLP 0129). The
  // classifier needs the catalog as its third argument to resolve a source id
  // to its owning plugin (the design sketch elides it for brevity).
  const lockedSources = [...opts.catalog.pickerDescriptors.keys()].filter(
    (id) => classifyClientProvenance(id, layered, opts.catalog) === 'central'
  )
  return { status: 'ok', lockedSources }
}

/**
 * Map an incomplete login to the fork-returning outcome (LLP 0129
 * #failed-join-returns-to-fork). The login lane already wrote the human
 * explanation to stderr via `explainLoginError`; we only classify by
 * matching the two *definitive* D7 rejection phrases (`no_membership`,
 * `org_not_permitted`) it emits. Those mean an admin has to act, so
 * retrying the same login is futile -> `'failed'`. Anything else - a
 * transient network error, a login timeout, an abandoned browser flow, a
 * store/seed failure - is retriable, so -> `'abandoned'`.
 *
 * @ref LLP 0058#d7 [constrained-by]: reuses the login lane's existing membership/permission taxonomy rather than re-encoding it
 * @param {Pick<LoginLaneResult, 'stderr'>} login
 * @returns {'failed' | 'abandoned'}
 */
export function classifyLoginFailure(login) {
  const stderr = login?.stderr ?? ''
  if (stderr.includes(LOGIN_NO_MEMBERSHIP_MESSAGE) || stderr.includes(LOGIN_ORG_NOT_PERMITTED_MESSAGE)) {
    return 'failed'
  }
  return 'abandoned'
}

/**
 * The production login lane: run `hyp remote login` (bare, so it resolves
 * the default target and the browser flow, `@ref LLP 0134#no-token-join`
 * - the wizard never passes a token) against the wizard's command context,
 * teeing its stderr so `classifyLoginFailure` can read the D7 phrase while
 * the user still sees the login lane's own output.
 *
 * @param {RunWizardJoinOptions} opts
 * @returns {Promise<LoginLaneResult>}
 */
async function defaultRunLogin(opts) {
  const ctx = opts.ctx
  if (!ctx) {
    throw new Error('runWizardJoin: no login context (opts.ctx) and no runLogin override was provided')
  }
  const capture = teeWriter(ctx.stderr)
  const teed = /** @type {CommandRunContext} */ ({ ...ctx, stderr: capture.stream })
  const exitCode = await runRemoteLogin([], teed, {})
  return { exitCode, stderr: capture.text() }
}

/**
 * Resolve the two-layer config from disk for the locked-source computation
 * (LLP 0031). Reads the same local + central layers `bootKernel` does; both
 * read-only.
 *
 * @param {RunWizardJoinOptions} opts
 * @returns {Promise<LayeredProvenance>}
 */
async function defaultResolveLayered(opts) {
  const obsEnv = readObservabilityEnv(opts.env)
  const configPath = resolveConfigPath({ env: opts.env, hypHome: obsEnv.hypHome })
  return resolveLayeredConfigFromDisk({
    stateRoot: obsEnv.stateDir,
    configPath,
    knownPlugins: opts.catalog?.pluginMetadata,
    knownDatasets: opts.catalog?.knownDatasets,
  })
}

/**
 * A write-through capture over a stream's `write`: every chunk is recorded
 * and forwarded to the underlying stream, so the login lane's stderr is both
 * shown to the user and available to `classifyLoginFailure`.
 *
 * @param {{ write(chunk: string): unknown }} target
 * @returns {{ stream: { write(chunk: string): unknown }, text(): string }}
 */
function teeWriter(target) {
  let captured = ''
  return {
    stream: {
      /** @param {string} chunk */
      write(chunk) {
        captured += String(chunk)
        return target.write(chunk)
      },
    },
    text() {
      return captured
    },
  }
}

/**
 * @param {{ setAttribute?: (key: string, value: unknown) => void } | undefined} span
 * @param {string} key
 * @param {unknown} value
 */
function setSpanAttr(span, key, value) {
  if (span && typeof span.setAttribute === 'function') span.setAttribute(key, value)
}
