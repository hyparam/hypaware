// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAttachHandler, attachHandler } from '../../src/core/config/action_attach.js'
import { markActionRefused } from '../../src/core/config/action_refusal.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'

/**
 * T6 (LLP 0044/0045/0046): the attach action handler, the reversible
 * instance of the client-action reconciler, the `action_backfill.js` twin.
 * These tests drive the handler hooks directly with injected fake
 * `clientDescriptors` + `clients` + filesystem, the way the plan prescribes;
 * the reconciler's generic gap loop is covered by `action-reconciler.test.js`.
 *
 * @import { ActionContext, ActionHandler } from '../../src/core/config/types.d.ts'
 * @import { ClientDescriptor } from '../../src/core/types.js'
 */

/**
 * Narrow the optional `reverse?` hook to a defined function (attach is the
 * reversible handler, so it always implements it).
 * @param {ActionHandler} handler
 * @returns {NonNullable<ActionHandler['reverse']>}
 */
function reverseOf(handler) {
  assert.ok(handler.reverse, 'attach handler must implement reverse()')
  return handler.reverse
}

/** A quiet logger so tests don't spam stderr. */
const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * A logger that records what it was told, for the paths whose only remaining
 * output is a log line (a removal the handler refuses names its files there).
 * @returns {{ log: any, warnings: { event: string, attrs: any }[] }}
 */
function capturingLog() {
  /** @type {{ event: string, attrs: any }[]} */
  const warnings = []
  return {
    warnings,
    log: {
      debug() {},
      info() {},
      warn(event, attrs) { warnings.push({ event, attrs }) },
      error() {},
    },
  }
}

const FIXED_NOW = Date.parse('2026-06-25T00:00:00.000Z')
const ENDPOINT = 'http://127.0.0.1:4123'

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/** @type {ClientDescriptor} */
const CODEX_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/codex'),
  name: 'codex',
  skillDir: 'skills/codex',
  attachProbe: { format: 'toml', settings_file: '.codex/config.toml', marker_header: '[model_providers.hypaware]' },
}

/**
 * A client descriptor with **no `attachProbe`**. perform() can attach it (it
 * only needs a live adapter), but the disk-driven reverse() has nothing to
 * replay, so it must be excluded from attach-eligibility and, if a marker is
 * ever applied out-of-band, treated as a failed (not no-op) reverse (#212).
 * @type {ClientDescriptor}
 */
const PROBELESS_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/probeless'),
  name: 'probeless',
  skillDir: 'skills/probeless',
}

/**
 * @param {ClientDescriptor[]} list
 * @returns {Map<string, ClientDescriptor>}
 */
function descriptorMap(list) {
  return new Map(list.map((d) => [d.name, d]))
}

/**
 * A fake gateway registry over a fixed set of registered client adapters. Only
 * `getClient` / `listClients` are exercised; the rest satisfy the shape.
 * @param {Record<string, any>} registrations  client name -> registration
 * @returns {any}
 */
function clientsWith(registrations) {
  const map = new Map(Object.entries(registrations))
  return {
    getClient(/** @type {string} */ name) { return map.get(name) },
    listClients() { return [...map.values()] },
    registerClient() {},
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    localEndpoint() { return ENDPOINT },
  }
}

/**
 * A fake client registration whose `attach()` writes the adapter's one-line
 * `json: true` payload (or throws / emits prose, per opts).
 * @param {string} name
 * @param {{ payload?: any, prose?: string, throws?: Error, onAttach?: (ctx: any) => void }} [opts]
 * @returns {any}
 */
function attachRegistration(name, opts = {}) {
  return {
    name,
    defaultUpstream: 'anthropic',
    /** @param {any} ctx */
    async attach(ctx) {
      opts.onAttach?.(ctx)
      if (opts.throws) throw opts.throws
      if (typeof opts.prose === 'string') {
        ctx.stdout.write(opts.prose)
        return
      }
      const payload = opts.payload ?? {
        status: 'attached', action: 'attach', client: name, dry_run: false, changed: true,
      }
      ctx.stdout.write(JSON.stringify(payload))
    },
  }
}

/**
 * Build the ActionContext a handler hook receives.
 * @param {{
 *   plugins?: any[],
 *   descriptors?: Map<string, ClientDescriptor>,
 *   clients?: any,
 *   endpoint?: string | undefined,
 *   env?: NodeJS.ProcessEnv,
 *   skills?: any,
 *   agents?: any,
 *   log?: any,
 * }} [opts]
 * @returns {ActionContext}
 */
function makeCtx(opts = {}) {
  return {
    config: /** @type {any} */ ({ version: 2, plugins: opts.plugins ?? [] }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: opts.env ?? { ...process.env },
    clientDescriptors: opts.descriptors,
    clients: /** @type {any} */ (opts.clients),
    // Absent unless a test opts in, which is also what a non-daemon boot looks
    // like: the install half of attach stays inert and never touches real HOME.
    skills: opts.skills,
    agents: opts.agents,
    endpoint: 'endpoint' in opts ? opts.endpoint : ENDPOINT,
    now: () => FIXED_NOW,
    log: opts.log ?? NOOP_LOG,
  }
}

/**
 * A registry stub over a fixed contribution list: the shape
 * `materializeClientAssets` reads.
 * @param {any[]} items
 * @returns {any}
 */
function registryOf(items) {
  return { register() {}, list() { return items } }
}

/* -------------------------------- shape --------------------------------- */

test('the default attachHandler is an attach-kind, reversible ActionHandler', () => {
  assert.equal(attachHandler.kind, 'attach')
  assert.equal(typeof attachHandler.desired, 'function')
  assert.equal(typeof attachHandler.perform, 'function')
  // Unlike backfill (run-once), attach implements reverse().
  assert.equal(typeof attachHandler.reverse, 'function')
})

/* ------------------------------- desired() ------------------------------- */

test('desired() emits one action per enabled client descriptor with a registered client', () => {
  const handler = createAttachHandler()
  const desired = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(desired, [
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
  ])
})

test('desired() emits an action per enabled descriptor across two client plugins', () => {
  const handler = createAttachHandler()
  const desired = handler.desired(makeCtx({
    plugins: [
      { name: '@hypaware/claude', enabled: true, config: {} },
      { name: '@hypaware/codex', enabled: true, config: {} },
    ],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude'), codex: attachRegistration('codex') }),
  }))
  assert.deepEqual(desired.map((d) => d.requestKey).sort(), ['claude', 'codex'])
})

test('desired() excludes a descriptor whose owning plugin is disabled or absent', () => {
  const handler = createAttachHandler()
  const disabled = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: false, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(disabled, [])
  const absent = handler.desired(makeCtx({
    plugins: [],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(absent, [])
})

test('desired() honors an explicit attach.on_join:false opt-out (no action)', () => {
  const handler = createAttachHandler()
  const desired = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: { attach: { on_join: false } } }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(desired, [])
})

test('desired() does not fail open on a non-boolean on_join (treats it as opt-out)', () => {
  const handler = createAttachHandler()
  // The typo'd JSON string `"false"` is not a boolean; it must suppress, not
  // fall through to default-on and silently edit the user's settings file.
  const stringFalse = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: { attach: { on_join: 'false' } } }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(stringFalse, [], 'on_join:"false" (string) must not attach')
})

test('desired() excludes a probe-less descriptor - attach-eligibility requires reverse-capability (#212)', () => {
  const handler = createAttachHandler()
  // Enabled plugin + registered client, but the descriptor declares no
  // attachProbe. perform() could attach it, but reverse() (disk-driven) could
  // never undo it, so it must never be named as an attach target, otherwise a
  // later config-drop drops the marker while the settings stay written.
  const desired = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/probeless', enabled: true, config: {} }],
    descriptors: descriptorMap([PROBELESS_DESCRIPTOR]),
    clients: clientsWith({ probeless: attachRegistration('probeless') }),
  }))
  assert.deepEqual(desired, [], 'a probe-less client must never be named as an attach target')
})

test('desired() guards on the runtime registry actually having the client', () => {
  const handler = createAttachHandler()
  // Enabled plugin + descriptor, but the gateway registered no such client →
  // never name a client `perform()` cannot reach.
  const desired = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({}),
  }))
  assert.deepEqual(desired, [])
})

test('desired() is daemon-only: inert with no clientDescriptors and with no clients (a plain CLI boot)', () => {
  const handler = createAttachHandler()
  // No client catalog at all.
  assert.deepEqual(handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: undefined,
    clients: clientsWith({ claude: attachRegistration('claude') }),
  })), [])
  // Descriptors but no gateway registry (gateway capability absent).
  assert.deepEqual(handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: undefined,
  })), [])
})

/* ------------------------------- perform() ------------------------------- */

test('perform() attaches via the registry (endpoint + json mode) and records settings_path + prev_value', async () => {
  /** @type {any} */
  let attachCtx
  const registration = attachRegistration('claude', {
    onAttach: (ctx) => { attachCtx = ctx },
    payload: {
      status: 'attached', action: 'attach', client: 'claude', dry_run: false,
      changed: true, settings_path: '/home/u/.claude/settings.json', port: 4123,
      prev_value: 'https://foreign.example/api',
    },
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, {
    status: 'done',
    detail: { endpoint: ENDPOINT, settings_path: '/home/u/.claude/settings.json', prev_value: 'https://foreign.example/api' },
  })
  // The adapter was invoked with the gateway endpoint, an empty config, and
  // the machine-readable json flag.
  assert.equal(attachCtx.endpoint, ENDPOINT)
  assert.equal(attachCtx.json, true)
  assert.deepEqual(attachCtx.config, {})
})

test('perform() records done with only settings_path when the attach had no prior value to back up', async () => {
  const registration = attachRegistration('claude', {
    payload: {
      status: 'attached', action: 'attach', client: 'claude', dry_run: false,
      changed: true, settings_path: '/home/u/.claude/settings.json',
    },
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done', detail: { endpoint: ENDPOINT, settings_path: '/home/u/.claude/settings.json' } })
})

test('perform() records done (endpoint only) on an idempotent re-attach (changed:false)', async () => {
  const registration = attachRegistration('claude', {
    payload: { status: 'noop', action: 'attach', client: 'claude', dry_run: false, changed: false },
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done', detail: { endpoint: ENDPOINT } })
})

test('perform() records done (endpoint only) when the adapter emits an unparseable payload', async () => {
  const registration = attachRegistration('claude', { prose: 'attached claude (human prose)\n' })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done', detail: { endpoint: ENDPOINT } })
})

test('perform() parses the last non-empty line when prose precedes the JSON', async () => {
  const registration = attachRegistration('claude', {
    onAttach: (ctx) => {
      ctx.stdout.write('Attaching claude...\n')
      ctx.stdout.write(JSON.stringify({ status: 'attached', client: 'claude', settings_path: '/p' }) + '\n')
    },
    prose: '',
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.deepEqual(outcome, { status: 'done', detail: { endpoint: ENDPOINT, settings_path: '/p' } })
})

test('perform() returns failed when the adapter throws (file not writable)', async () => {
  const registration = attachRegistration('claude', { throws: new Error('EACCES: permission denied') })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /EACCES/)
})

test('perform() returns refused when the adapter throws a marked refusal', async () => {
  const registration = attachRegistration('claude', {
    throws: markActionRefused(new Error('models.providers.anthropic already exists and was not written by HypAware')),
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: registration }) }),
  )
  assert.equal(outcome.status, 'refused')
  assert.match(String(outcome.reason), /already exists/)
})

test('perform() returns failed when the registry has no such client', async () => {
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({}) }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /no registered client/)
})

test('perform() returns failed when no gateway endpoint is set', async () => {
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude' } },
    makeCtx({ clients: clientsWith({ claude: attachRegistration('claude') }), endpoint: undefined }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /endpoint/)
})

test('perform() guards against a missing client name', async () => {
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: '', params: {} },
    makeCtx({ clients: clientsWith({}) }),
  )
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /missing client name/)
})

/* ------------------------- perform(): client assets ----------------------- */

/**
 * LLP 0107 §every-attach: an org-driven attach materializes the client's
 * registered skills and subagents, so an enrolled machine gets the helpers
 * (including the privacy-review skill) without anyone re-running login. LLP
 * 0138 folds both asset kinds into the one materializer these assert against.
 */

/**
 * A temp HOME holding one skill source tree and one agent source file, plus a
 * descriptor pointing at asset dirs inside it.
 * @returns {Promise<{ home: string, descriptor: ClientDescriptor, skills: any, agents: any }>}
 */
async function assetFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-assets-'))
  const skillSrc = path.join(home, 'src', 'helper-skill')
  await fs.mkdir(skillSrc, { recursive: true })
  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'skill body\n', 'utf8')
  const agentSrc = path.join(home, 'src', 'helper-agent.md')
  await fs.writeFile(agentSrc, 'agent body\n', 'utf8')
  return {
    home,
    descriptor: { ...CLAUDE_DESCRIPTOR, skillDir: '.claude/skills', agentDir: '.claude/agents' },
    skills: registryOf([{ name: 'helper-skill', plugin: '@hypaware/claude', clients: ['claude'], sourceDir: skillSrc }]),
    agents: registryOf([{ name: 'helper-agent', plugin: '@hypaware/claude', clients: ['claude'], sourceFile: agentSrc }]),
  }
}

test('perform() materializes the client assets and records them as the undo record', async () => {
  const { home, descriptor, skills, agents } = await assetFixture()
  const handler = createAttachHandler()

  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
    makeCtx({
      descriptors: descriptorMap([descriptor]),
      clients: clientsWith({ claude: attachRegistration('claude') }),
      env: { HOME: home },
      skills,
      agents,
    }),
  )

  const skillDest = path.join(home, '.claude', 'skills', 'helper-skill')
  const agentDest = path.join(home, '.claude', 'agents', 'helper-agent.md')
  assert.equal(await fs.readFile(path.join(skillDest, 'SKILL.md'), 'utf8'), 'skill body\n')
  assert.equal(await fs.readFile(agentDest, 'utf8'), 'agent body\n')
  assert.equal(outcome.status, 'done')
  // Recorded on the marker so reverse() removes exactly what this attach wrote.
  assert.deepEqual(outcome.detail?.installed_assets, [skillDest, agentDest])
})

test('perform() stays done when an asset copy fails - the attach itself applied', async () => {
  const { home, descriptor } = await assetFixture()
  const handler = createAttachHandler()

  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
    makeCtx({
      descriptors: descriptorMap([descriptor]),
      clients: clientsWith({ claude: attachRegistration('claude') }),
      env: { HOME: home },
      skills: registryOf([
        { name: 'gone', plugin: '@hypaware/claude', clients: ['claude'], sourceDir: path.join(home, 'nope') },
      ]),
    }),
  )

  // A failed copy must not churn the marker to `failed`: that would re-attach
  // every pass over a problem re-attaching cannot fix.
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.detail?.installed_assets, undefined)
})

test('perform() installs no assets when the daemon threaded no registries', async () => {
  const { home, descriptor } = await assetFixture()
  const handler = createAttachHandler()

  const outcome = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
    makeCtx({
      descriptors: descriptorMap([descriptor]),
      clients: clientsWith({ claude: attachRegistration('claude') }),
      env: { HOME: home },
    }),
  )

  assert.equal(outcome.status, 'done')
  assert.equal(outcome.detail?.installed_assets, undefined)
  await assert.rejects(fs.access(path.join(home, '.claude', 'skills')))
})

/* ------------------------------- reverse() ------------------------------- */

test('reverse() removes exactly the assets its own marker recorded', async () => {
  const { home, descriptor, skills, agents } = await assetFixture()
  const handler = createAttachHandler({ detach: async () => ({ changed: true }) })
  const ctx = makeCtx({
    descriptors: descriptorMap([descriptor]),
    env: { HOME: home },
    skills,
    agents,
  })
  const performed = await handler.perform(
    { requestKey: 'claude', params: { client: 'claude', plugin: '@hypaware/claude' } },
    { ...ctx, clients: /** @type {any} */ (clientsWith({ claude: attachRegistration('claude') })) },
  )

  // A skill the user installed themselves: no marker names it, so a leave must
  // leave it alone (LLP 0107 §reversal).
  const manual = path.join(home, '.claude', 'skills', 'my-own-skill')
  await fs.mkdir(manual, { recursive: true })
  await fs.writeFile(path.join(manual, 'SKILL.md'), 'mine\n', 'utf8')

  const outcome = await reverseOf(handler)('claude', ctx, {
    status: 'done',
    request_key: 'claude',
    ...performed.detail,
  })

  assert.deepEqual(outcome, { status: 'done' })
  await assert.rejects(fs.access(path.join(home, '.claude', 'skills', 'helper-skill')))
  await assert.rejects(fs.access(path.join(home, '.claude', 'agents', 'helper-agent.md')))
  assert.equal(await fs.readFile(path.join(manual, 'SKILL.md'), 'utf8'), 'mine\n')
})

test('reverse() refuses to remove a marker path outside the client asset dirs', async () => {
  const { home, descriptor } = await assetFixture()
  // `client-actions.json` is a plain file on disk: a hand edit or a corrupt
  // write can point `installed_assets` anywhere, and removal is a recursive
  // force-rm. Containment is re-checked on the delete side, not just the write
  // side, so an escaping path is reported rather than obeyed.
  const outsider = path.join(home, 'precious')
  await fs.mkdir(outsider, { recursive: true })
  await fs.writeFile(path.join(outsider, 'keep.txt'), 'keep\n', 'utf8')
  // The skills dir itself is a base, not something beneath one: a marker
  // naming it must not take every skill in it, the user's own included.
  const skillsDir = path.join(home, '.claude', 'skills')
  await fs.mkdir(path.join(skillsDir, 'my-own-skill'), { recursive: true })
  await fs.writeFile(path.join(skillsDir, 'my-own-skill', 'SKILL.md'), 'mine\n', 'utf8')

  const { log, warnings } = capturingLog()
  const handler = createAttachHandler({ detach: async () => ({ changed: true }) })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([descriptor]),
    env: { HOME: home },
    log,
  }), {
    status: 'done',
    request_key: 'claude',
    installed_assets: [outsider, skillsDir, '/'],
  })

  // Nothing was deleted: not the escaping dir, not the skills dir itself.
  assert.equal(await fs.readFile(path.join(outsider, 'keep.txt'), 'utf8'), 'keep\n')
  assert.equal(await fs.readFile(path.join(skillsDir, 'my-own-skill', 'SKILL.md'), 'utf8'), 'mine\n')
  await fs.stat('/')
  // A refusal is deterministic, so the reverse completes rather than failing
  // forever over paths it will refuse identically on every future pass. The
  // record moves from the marker to the log on its way out.
  assert.equal(outcome.status, 'done')
  const refusal = warnings.find((w) => w.event === 'client_action.attach_reverse_assets_refused')
  assert.ok(refusal, 'the refused paths are named before the marker drops')
  assert.match(String(refusal.attrs.detail), /remove by hand/)
  for (const dest of [outsider, skillsDir, '/']) {
    assert.ok(String(refusal.attrs.detail).includes(dest), `${dest} is named`)
  }
})

test('reverse() of a marker with no installed_assets touches no files', async () => {
  const { home, descriptor } = await assetFixture()
  const manual = path.join(home, '.claude', 'skills', 'my-own-skill')
  await fs.mkdir(manual, { recursive: true })
  await fs.writeFile(path.join(manual, 'SKILL.md'), 'mine\n', 'utf8')

  const handler = createAttachHandler({ detach: async () => ({ changed: true }) })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([descriptor]),
    env: { HOME: home },
  }), { status: 'done', request_key: 'claude' })

  // Pre-LLP-0138 markers, and manual attaches, record nothing to undo.
  assert.deepEqual(outcome, { status: 'done' })
  assert.equal(await fs.readFile(path.join(manual, 'SKILL.md'), 'utf8'), 'mine\n')
})

test('reverse() invokes the disk-driven undo once and never consults ctx.clients', async () => {
  /** @type {any[]} */
  const calls = []
  // A registry that explodes if the handler ever touches it: proving reverse
  // is adapter-independent (the dropped client is gone after the restart).
  const poisonClients = {
    getClient() { throw new Error('reverse() must not consult ctx.clients') },
    listClients() { throw new Error('reverse() must not consult ctx.clients') },
  }
  const handler = createAttachHandler({
    detach: async (args) => {
      calls.push(args)
      return { changed: true, settingsPath: '/home/u/.claude/settings.json', restoredValue: 'https://foreign.example/api' }
    },
  })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: poisonClients,
  }))
  assert.deepEqual(outcome, { status: 'done' })
  assert.equal(calls.length, 1)
  // The T4 undo got the descriptor (its attachProbe is what the undo replays).
  assert.equal(calls[0].descriptor, CLAUDE_DESCRIPTOR)
})

test('reverse() reports a replayed malformed-block backup by path, and never its contents', async () => {
  // The reconciler half of #500 finding 3. `hyp detach` prints a line per
  // restored path; this reverse is an org config drop with nobody at a
  // terminal, so the log is the only place a rewrite of the user's settings
  // file can be recorded - and the failure half of the same replay was already
  // logged here while the success half was not.
  /** @type {{ event: string, attrs: any }[]} */
  const records = []
  /** @type {any} */
  const log = {
    debug() {},
    info(/** @type {string} */ event, /** @type {any} */ attrs) { records.push({ event, attrs }) },
    warn(/** @type {string} */ event, /** @type {any} */ attrs) { records.push({ event, attrs }) },
    error() {},
  }
  const handler = createAttachHandler({
    detach: async () => ({
      changed: true,
      settingsPath: '/home/u/.claude/settings.json',
      restoredPaths: ['env', 'hooks.SessionStart'],
    }),
  })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    log,
  }))

  assert.deepEqual(outcome, { status: 'done' })
  const restored = records.find((r) => r.event === 'client_action.attach_reverse_restored')
  assert.ok(restored, 'a replayed backup is named before the marker drops')
  assert.equal(restored.attrs.client, 'claude')
  for (const dotted of ['env', 'hooks.SessionStart']) {
    assert.ok(String(restored.attrs.detail).includes(dotted), `${dotted} is named`)
  }
})

test('reverse() says nothing about a restore that did not happen', async () => {
  // The guard on the line above: `restoredPaths` is absent on every undo that
  // replayed no backup, which is nearly all of them, and an org-driven detach
  // must not emit a restore record for one.
  /** @type {string[]} */
  const events = []
  /** @type {any} */
  const log = {
    debug() {},
    info(/** @type {string} */ event) { events.push(event) },
    warn(/** @type {string} */ event) { events.push(event) },
    error() {},
  }
  const handler = createAttachHandler({ detach: async () => ({ changed: true }) })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    log,
  }))

  assert.deepEqual(outcome, { status: 'done' })
  assert.equal(events.includes('client_action.attach_reverse_restored'), false)
})

test('reverse() replays the real core undo from disk with no adapter loaded (fs round-trip)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-action-attach-'))
  try {
    const settingsPath = path.join(home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    // A hand-written self-describing marker, what claude `attach()` records:
    // the managed env value plus the prior base URL to restore (LLP 0045 §Part 3).
    const original = JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: ENDPOINT },
      _hypaware: {
        prev_base_url: 'https://foreign.example/api',
        managed: { env: { ANTHROPIC_BASE_URL: ENDPOINT }, hooks: [] },
      },
    }, null, 2) + '\n'
    await fs.writeFile(settingsPath, original)

    // No ctx.clients at all: the adapter is unloaded post-restart. Bind the
    // fixture home through the injected (real) detach.
    const handler = createAttachHandler({
      detach: ({ descriptor }) => detachClientFromDisk({ descriptor, homeDir: home }),
    })
    const outcome = await reverseOf(handler)('claude', makeCtx({
      descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
      clients: undefined,
    }))
    assert.deepEqual(outcome, { status: 'done' })

    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('_hypaware' in after, false, 'marker stripped')
    assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://foreign.example/api', 'prior base URL restored')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('reverse() of a probe-less descriptor fails - never silently drops the marker, orphaning settings (#212)', async () => {
  // A marker applied out-of-band (manual `hyp attach`, or a pre-fix marker) for
  // a probe-less client: the core undo returns { changed:false } for "no probe"
  // exactly as it does for "already clean", so a `done` here would drop the
  // marker while the settings stay on disk. reverse() must short-circuit on the
  // missing probe and fail (retryable/visible), without consulting the undo.
  let detachCalled = false
  const handler = createAttachHandler({
    detach: async () => { detachCalled = true; return { changed: false } },
  })
  const outcome = await reverseOf(handler)('probeless', makeCtx({
    descriptors: descriptorMap([PROBELESS_DESCRIPTOR]),
    clients: undefined,
  }))
  assert.equal(outcome.status, 'failed', 'a probe-less reverse is a failure, not a marker-dropping no-op')
  assert.match(String(outcome.reason), /attach_probe/)
  assert.equal(detachCalled, false, 'reverse must not pretend the disk undo ran')
})

test('reverse() returns failed (retry next pass) when the descriptor is gone from the catalog', async () => {
  const handler = createAttachHandler({
    detach: async () => { throw new Error('detach should not be called without a descriptor') },
  })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([]),
    clients: undefined,
  }))
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /no client descriptor/)
})

test('reverse() returns failed when the disk undo throws (concurrent edit)', async () => {
  const handler = createAttachHandler({
    detach: async () => { throw new Error('CONCURRENT_EDIT') },
  })
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: undefined,
  }))
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.reason), /CONCURRENT_EDIT/)
})

/* ---------------------- desired/reverse compose (gap) -------------------- */

test('the reverse-gap contract: a dropped client falls out of desired() and reverse() then undoes it', async () => {
  /** @type {any[]} */
  const calls = []
  const handler = createAttachHandler({
    detach: async (args) => { calls.push(args); return { changed: true, settingsPath: '/p' } },
  })
  // Joined + enabled → named by desired() (the reconciler would perform it).
  const named = handler.desired(makeCtx({
    plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(named.map((d) => d.requestKey), ['claude'])

  // Central config drops the plugin → desired() omits it; the descriptor stays
  // in the catalog, so the reconciler's reverse gap fires for the marker key.
  const dropped = handler.desired(makeCtx({
    plugins: [],
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: clientsWith({ claude: attachRegistration('claude') }),
  }))
  assert.deepEqual(dropped, [])

  // reverse() undoes it from disk.
  const outcome = await reverseOf(handler)('claude', makeCtx({
    descriptors: descriptorMap([CLAUDE_DESCRIPTOR]),
    clients: undefined,
  }))
  assert.deepEqual(outcome, { status: 'done' })
  assert.equal(calls.length, 1)
})
