// @ts-check

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { LayeredProvenance, LoginLaneResult, RunWizardJoinOptions, WizardJoinResult } from '../../../../src/core/cli/wizard/types.js'
 */

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { resolveConfigPath, resolveLayeredConfigFromDisk } from '../../runtime/boot.js'
import {
  remoteLogin,
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
 * mechanism (`@ref LLP 0134#login-lane`): it runs the login lane, waits
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
 * @ref LLP 0134#login-lane [implements]: the fork's shared-collection row ("Collect shared agent logs") wraps the `hyp remote login` lane; the wizard adds narration and the locked-row computation, not a second enrollment path.
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
  // The join lane owns no prompt spec of its own - it narrates, then hands
  // off to the login lane, which may prompt (org selection) inside. So its
  // position line is written here, once, above the narration: the whole
  // lane is one step however many prompts happen inside it.
  // @ref LLP 0135#progress [implements]: the join lane counts once, and prints its position where it starts
  if (opts.progress) opts.stdout.write(`${opts.progress}\n`)
  opts.stdout.write('Joining your team...\n')

  const runLogin = opts.runLogin ?? (() => defaultRunLogin(opts))
  const login = await runLogin()
  if (login.exitCode !== 0) {
    const status = classifyLoginFailure(login)
    setSpanAttr(span, 'status', 'error')
    setSpanAttr(span, Attr.ERROR_KIND, status === 'failed' ? 'login_rejected' : 'login_abandoned')
    return { status, detail: login.stderr, ...(login.reason ? { reason: login.reason } : {}) }
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

  const lockedSources = await computeCentralLockedSources(opts)
  return { status: 'ok', lockedSources, managed: true }
}

/**
 * Compute the picker source ids the central layer owns: resolve the
 * two-layer config from disk and keep every catalog picker id whose
 * owning plugin classifies `'central'`. The pick phase locks exactly this
 * set (LLP 0129 #join-before-picker). Shared by the join phase (after
 * convergence) and by every wizard entry that reaches the picker on an
 * already-managed machine without a join: the returning gate's single
 * Reconfigure re-entry (LLP 0182), and the first-run path a managed
 * machine falls to when its merged config no longer validates. In both,
 * no join runs but the org's rows must still render locked.
 *
 * The classifier needs the catalog as its third argument to resolve a
 * source id to its owning plugin (the design sketch elides it for
 * brevity).
 *
 * @param {Pick<RunWizardJoinOptions, 'env' | 'catalog' | 'resolveLayered'>} opts
 * @returns {Promise<string[]>}
 */
export async function computeCentralLockedSources(opts) {
  const resolveLayered = opts.resolveLayered ?? (() => defaultResolveLayered(opts))
  const layered = await resolveLayered()
  return [...opts.catalog.pickerDescriptors.keys()].filter(
    (id) => classifyClientProvenance(id, layered, opts.catalog) === 'central'
  )
}

/**
 * Map an incomplete login to the fork-returning outcome (LLP 0129
 * #failed-join-returns-to-fork), reading the login lane's reason code.
 * The *definitive* D7 rejections are `no_membership` and
 * `org_not_permitted` (an admin has to act) and `org_selection_required`
 * (a multi-org account needs an explicit `hyp remote login --org <name>`
 * the wizard's bare login cannot supply). Retrying the same login is
 * futile for all three -> `'failed'`. Anything else - a provider denial,
 * a transient network error, a login timeout, an abandoned browser flow,
 * a store/seed failure - is retriable, so -> `'abandoned'`.
 *
 * A lane result with no reason (an old-shaped test double) classifies as
 * retriable, which is the same answer the stderr matcher gave when it
 * recognized nothing.
 *
 * @ref LLP 0058#d7 [constrained-by]: the three definitive reasons are the D7 refusal codes verbatim, so the split is the server's taxonomy and not a wizard-local one
 * @ref LLP 0179#no-prose-control-flow [implements]: classify on the reason code, never on the lane's English
 * @param {Pick<LoginLaneResult, 'reason'>} login
 * @returns {'failed' | 'abandoned'}
 */
export function classifyLoginFailure(login) {
  switch (login?.reason) {
    case 'no_membership':
    case 'org_not_permitted':
    case 'org_selection_required':
      return 'failed'
    default:
      return 'abandoned'
  }
}

/**
 * The production login lane: run `hyp remote login` (bare, so it resolves
 * the default target and the browser flow, `@ref LLP 0134#no-token-join`
 * - the wizard never passes a token) against the wizard's command context.
 * `remoteLogin` reports the outcome, so classification reads a code; the
 * stderr tee stays for `detail`, which echoes the lane's own explanation
 * back to the user (LLP 0179#no-prose-control-flow).
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
  const { exitCode, reason } = await remoteLogin([], teed, {})
  return { exitCode, reason, stderr: capture.text() }
}

/**
 * Resolve the two-layer config from disk for the locked-source computation
 * (LLP 0031). Reads the same local + central layers `bootKernel` does; both
 * read-only.
 *
 * @param {Pick<RunWizardJoinOptions, 'env' | 'catalog'>} opts
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
 * shown to the user and available as the failure `detail`.
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
