// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyLoginFailure, runWizardJoin } from '../../../../src/core/cli/wizard/join.js'
import {
  LOGIN_NO_MEMBERSHIP_MESSAGE,
  LOGIN_ORG_NOT_PERMITTED_MESSAGE,
  LOGIN_ORG_SELECTION_MESSAGE,
} from '../../../../src/core/cli/remote_commands.js'

/**
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 */

// The wizard join phase (LLP 0135 #join, LLP 0134 #login-lane). A thin
// narration wrapper around `runRemoteLogin`: it classifies a failed login
// into the fork-returning taxonomy (LLP 0129 #failed-join-returns-to-fork),
// waits (bounded) for the org config to converge, and locks the picker rows
// the central layer owns.
// @ref LLP 0134#login-lane [tests]:
// @ref LLP 0129#failed-join-returns-to-fork [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * Build a catalog stub with the two descriptor maps the classifier reads
 * (`pickerRows`/`clientRows` are `{ id: plugin }` records), mirroring the
 * shared `client-provenance.test.js` fixture.
 *
 * @param {{ pickerRows?: Record<string, string>, clientRows?: Record<string, string> }} args
 */
function catalog({ pickerRows = {}, clientRows = {} }) {
  /** @type {Map<string, { plugin: string, id: string, label: string }>} */
  const pickerDescriptors = new Map()
  for (const [id, plugin] of Object.entries(pickerRows)) {
    pickerDescriptors.set(id, { plugin, id, label: id })
  }
  /** @type {Map<string, { plugin: string, name: string, skillDir: string }>} */
  const clientDescriptors = new Map()
  for (const [name, plugin] of Object.entries(clientRows)) {
    clientDescriptors.set(name, { plugin, name, skillDir: `/${name}` })
  }
  return { pickerDescriptors, clientDescriptors }
}

/**
 * @param {string[]} plugins
 * @returns {HypAwareV2Config | null}
 */
function cfg(plugins) {
  return plugins.length > 0
    ? /** @type {any} */ ({ version: 2, plugins: plugins.map((name) => ({ name })) })
    : null
}

/**
 * @param {string[]} centralPlugins
 * @param {string[]} effectivePlugins
 */
function layered(centralPlugins, effectivePlugins) {
  return { centralConfig: cfg(centralPlugins), effective: cfg(effectivePlugins) }
}

/**
 * Base options for a join run: a fresh stdout/stderr, an empty env, and the
 * given catalog. Every dependency (`runLogin`, `waitForConverge`,
 * `resolveLayered`) is injected per test so the real login lane and disk are
 * never touched.
 *
 * @param {ReturnType<typeof catalog>} cat
 * @param {Partial<import('../../../../src/core/cli/wizard/types.js').RunWizardJoinOptions>} over
 */
function joinOpts(cat, over) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  return /** @type {any} */ ({ stdout, stderr, env: {}, catalog: cat, ...over })
}

// --- classifyLoginFailure: the D7 taxonomy split ---

test('classifyLoginFailure: no_membership is a definitive rejection -> failed', () => {
  assert.equal(classifyLoginFailure({ stderr: `hyp remote login: ${LOGIN_NO_MEMBERSHIP_MESSAGE}\n` }), 'failed')
})

test('classifyLoginFailure: org_not_permitted is a definitive rejection -> failed', () => {
  assert.equal(classifyLoginFailure({ stderr: `hyp remote login: ${LOGIN_ORG_NOT_PERMITTED_MESSAGE}\n` }), 'failed')
})

// A multi-org account is definitive *for the wizard*: its bare login can
// never pass --org, so retrying the fork's "Join a team" is futile; the fix
// is a manual `hyp remote login --org <name>` then re-entering `hyp init`.
test('classifyLoginFailure: org_selection_required (multi-org account) -> failed', () => {
  assert.equal(classifyLoginFailure({ stderr: `hyp remote login: ${LOGIN_ORG_SELECTION_MESSAGE}\n` }), 'failed')
})

test('classifyLoginFailure: a transient network error is retriable -> abandoned', () => {
  assert.equal(classifyLoginFailure({ stderr: 'hyp remote login: connect ETIMEDOUT 10.0.0.1:443\n' }), 'abandoned')
})

test('classifyLoginFailure: an empty/absent stderr defaults to abandoned', () => {
  assert.equal(classifyLoginFailure({ stderr: '' }), 'abandoned')
  assert.equal(classifyLoginFailure(/** @type {any} */ ({})), 'abandoned')
})

// --- runWizardJoin: the login-failure branch returns to the fork ---

test('runWizardJoin: a non-zero login exit returns the classified failure and never waits', async () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  let waited = false
  const opts = joinOpts(cat, {
    runLogin: async () => ({ exitCode: 1, stderr: `hyp remote login: ${LOGIN_NO_MEMBERSHIP_MESSAGE}\n` }),
    waitForConverge: async () => { waited = true; return { ok: true, attached: ['claude'] } },
  })
  const out = await runWizardJoin(opts)
  assert.deepEqual(out, { status: 'failed', detail: `hyp remote login: ${LOGIN_NO_MEMBERSHIP_MESSAGE}\n` })
  assert.equal(waited, false, 'must not wait for convergence after a failed login')
  assert.match(opts.stdout.text(), /Joining your team/)
})

test('runWizardJoin: a transient login failure returns abandoned', async () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  const opts = joinOpts(cat, {
    runLogin: async () => ({ exitCode: 1, stderr: 'hyp remote login: request timed out\n' }),
  })
  const out = await runWizardJoin(opts)
  assert.equal(out.status, 'abandoned')
})

// --- runWizardJoin: the converged branch locks central-owned rows ---

test('runWizardJoin: on convergence, locks exactly the central-layer picker rows', async () => {
  const cat = catalog({
    pickerRows: {
      claude: '@hypaware/claude',
      codex: '@hypaware/codex',
      otel: '@hypaware/otel',
    },
  })
  // Central owns claude + otel; codex is a local addition; a client with no
  // config would be absent. Only central-owned rows lock.
  const lc = layered(
    ['@hypaware/claude', '@hypaware/otel'],
    ['@hypaware/claude', '@hypaware/otel', '@hypaware/codex']
  )
  const opts = joinOpts(cat, {
    runLogin: async () => ({ exitCode: 0, stderr: '' }),
    waitForConverge: async () => ({ ok: true, attached: ['claude'] }),
    resolveLayered: async () => lc,
  })
  const out = await runWizardJoin(opts)
  assert.equal(out.status, 'ok')
  assert.deepEqual([...(out.lockedSources ?? [])].sort(), ['claude', 'otel'])
  assert.match(opts.stdout.text(), /Applying your org's configuration/)
})

test('runWizardJoin: convergence with no central-owned rows locks nothing', async () => {
  const cat = catalog({ pickerRows: { codex: '@hypaware/codex' } })
  // A central layer exists but owns a different plugin; codex stays local.
  const lc = layered(['@hypaware/claude'], ['@hypaware/claude', '@hypaware/codex'])
  const opts = joinOpts(cat, {
    runLogin: async () => ({ exitCode: 0, stderr: '' }),
    waitForConverge: async () => ({ ok: true, attached: ['claude'] }),
    resolveLayered: async () => lc,
  })
  const out = await runWizardJoin(opts)
  // `managed` is still true: the central layer exists even though it owns
  // no picker rows, so the pick phase annotates additions (LLP 0132).
  assert.deepEqual(out, { status: 'ok', lockedSources: [], managed: true })
})

// --- runWizardJoin: the timeout / no-org-config branch ---

test('runWizardJoin: a convergence timeout narrates and returns an empty lock set', async () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  let resolved = false
  const opts = joinOpts(cat, {
    runLogin: async () => ({ exitCode: 0, stderr: '' }),
    waitForConverge: async () => ({ ok: false, attached: [] }),
    // resolveLayered must never run on the timeout path (nothing to lock).
    resolveLayered: async () => { resolved = true; return layered([], []) },
  })
  const out = await runWizardJoin(opts)
  assert.deepEqual(out, { status: 'ok', lockedSources: [] })
  assert.equal(resolved, false, 'must not resolve the layered config after a timeout')
  assert.match(opts.stdout.text(), /continuing with an unlocked picker/)
})

test('runWizardJoin: passes the org-config wait budget through to the converge helper', async () => {
  const cat = catalog({ pickerRows: { claude: '@hypaware/claude' } })
  /** @type {any} */
  let sawWaitOpts = null
  const opts = joinOpts(cat, {
    runLogin: async () => ({ exitCode: 0, stderr: '' }),
    waitForConverge: async (_o, waitOpts) => { sawWaitOpts = waitOpts; return { ok: false, attached: [] } },
  })
  await runWizardJoin(opts)
  assert.ok(sawWaitOpts && typeof sawWaitOpts.timeoutMs === 'number' && sawWaitOpts.timeoutMs > 0)
})
