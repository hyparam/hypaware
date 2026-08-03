// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createOpenclawAttach } from '../../hypaware-core/plugins-workspace/openclaw/src/attach.js'

/**
 * LLP 0172 §1.2 (design) / LLP 0171 R1, R2, R4: the OpenClaw attach surface
 * writes the two `models.providers` entries of LLP 0167#override-entries and
 * nothing else, refuses instead of merging when either key is already there,
 * and ends by telling the user to restart the gateway.
 *
 * Three of the four cases here are the ones the design and plan singled out as
 * "worth a dedicated unit test rather than trusting the acceptance run":
 *
 * - the bare-origin (`anthropic`) vs `+/v1` (`openai`) asymmetry, because both
 *   spellings are schema-valid, so the wrong one produces a config OpenClaw
 *   accepts and silently does not route through the gateway;
 * - the refusal, because it must be a *pure read-then-decide* with no partial
 *   write to roll back (R2);
 * - and the refusal not throwing, because that is the whole mechanism by which
 *   a refuse during attach-on-join warns instead of failing the join
 *   (LLP 0169#decision).
 *
 * @ref LLP 0167#attach-detach [tests]
 * @ref LLP 0169#decision [tests]
 */

const ENDPOINT = 'http://127.0.0.1:18521'

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Stage an OpenClaw config home with `openclaw.json` holding `config`.
 *
 * @param {Record<string, unknown>} config
 * @returns {Promise<{ homeDir: string, settingsPath: string }>}
 */
async function stage(config) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-openclaw-attach-'))
  const settingsPath = path.join(homeDir, '.openclaw', 'openclaw.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify(config, null, 2))
  return { homeDir, settingsPath }
}

/**
 * @param {{ homeDir: string }} staged
 * @param {{ json?: boolean, dryRun?: boolean }} [opts]
 */
async function runAttach(staged, opts = {}) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const attacher = createOpenclawAttach({ homeDir: staged.homeDir, env: {} })
  const outcome = await attacher.attach(
    /** @type {any} */ ({
      endpoint: ENDPOINT,
      config: {},
      stdout,
      stderr,
      dryRun: opts.dryRun === true,
      json: opts.json === true,
    })
  )
  return { outcome, stdout: stdout.text(), stderr: stderr.text() }
}

/** @param {string} settingsPath */
async function readConfig(settingsPath) {
  return JSON.parse(await fs.readFile(settingsPath, 'utf8'))
}

test('attach writes exactly the two provider entries, bare origin vs +/v1', async () => {
  const staged = await stage({ models: { providers: {} } })
  try {
    const { outcome } = await runAttach(staged)
    assert.deepEqual(outcome, { status: 'done' })

    const written = await readConfig(staged.settingsPath)
    // The exact two-entry shape, asserted whole rather than field by field: a
    // stray extra key under `models.providers.<name>` is as wrong as a missing
    // one, since this is the shape LLP 0167 verified live.
    assert.deepEqual(written.models.providers, {
      anthropic: {
        baseUrl: 'http://127.0.0.1:18521',
        // The marker routes (gateway upstream preset); the client header
        // attributes (openclaw exchange projector match, LLP 0175).
        headers: { 'x-hypaware-upstream': 'anthropic', 'x-hypaware-client': 'openclaw' },
        models: [],
      },
      openai: {
        // The asymmetry: OpenClaw's Anthropic client appends `/v1/messages`
        // itself and wants the bare origin, its OpenAI client appends only
        // `/responses` or `/chat/completions` and needs the `/v1` baked in.
        baseUrl: 'http://127.0.0.1:18521/v1',
        headers: { 'x-hypaware-upstream': 'openai', 'x-hypaware-client': 'openclaw' },
        models: [],
      },
    })
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

test('attach preserves every other key in openclaw.json (R1)', async () => {
  const staged = await stage({
    $schema: 'https://openclaw.dev/schema.json',
    theme: 'dark',
    models: {
      default: 'anthropic/claude-opus-4',
      providers: { azure: { baseUrl: 'https://azure.example', models: [] } },
    },
  })
  try {
    await runAttach(staged)

    const written = await readConfig(staged.settingsPath)
    assert.equal(written.$schema, 'https://openclaw.dev/schema.json')
    assert.equal(written.theme, 'dark')
    // Both the sibling `models` key and the unrelated provider survive: attach
    // owns two keys under `models.providers` and touches nothing else.
    assert.equal(written.models.default, 'anthropic/claude-opus-4')
    assert.deepEqual(written.models.providers.azure, {
      baseUrl: 'https://azure.example',
      models: [],
    })
    assert.deepEqual(Object.keys(written.models.providers).sort(), ['anthropic', 'azure', 'openai'])
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

test('attach refuses without writing when a provider key already exists (R2)', async () => {
  for (const existingKey of ['anthropic', 'openai']) {
    const before = {
      models: { providers: { [existingKey]: { baseUrl: 'https://mine.example', models: [] } } },
    }
    const staged = await stage(before)
    try {
      const { outcome, stdout } = await runAttach(staged)

      assert.equal(outcome.status, 'failed')
      assert.match(
        outcome.status === 'failed' ? outcome.reason : '',
        new RegExp(`models\\.providers\\.${existingKey} already exists`)
      )
      // The reason has to be actionable, not just a diagnosis.
      assert.match(outcome.status === 'failed' ? outcome.reason : '', /hyp detach --client openclaw/)
      assert.match(stdout, /did not apply/)

      // Pure read-then-decide: the file is byte-identical to what was staged.
      // A partial write here is the failure mode the ordering exists to
      // prevent, and it would not show up in the returned status.
      assert.deepEqual(await readConfig(staged.settingsPath), before)
    } finally {
      await fs.rm(staged.homeDir, { recursive: true, force: true })
    }
  }
})

// The other half of R2, and the one the presence-only refusal got wrong: the
// entry HypAware itself wrote is not a user override, so re-attaching over it
// must succeed. `action_attach.js`'s `isCurrent()` re-performs attach whenever
// the daemon rebound to a new ephemeral port (LLP 0086) or the contributed
// asset set changed (LLP 0107), and its own contract says `perform()` is
// idempotent. Refusing there churned the marker to `failed` and left
// `openclaw.json` pointing at the dead port while the marker-header probe still
// reported `attached: true`.
// @ref LLP 0086#re-attach-on-drift [tests]: a second attach at a moved endpoint
// rewrites the entries the first one wrote rather than refusing over them
test('a second attach at a moved endpoint rewrites both baseUrls (re-attach on drift)', async () => {
  const staged = await stage({ theme: 'dark', models: { providers: {} } })
  try {
    const first = await runAttach(staged)
    assert.deepEqual(first.outcome, { status: 'done' })

    // The ephemeral-port rebind `isCurrent()` exists to catch.
    const moved = 'http://127.0.0.1:4111'
    const stdout = makeBuf()
    const stderr = makeBuf()
    const outcome = await createOpenclawAttach({ homeDir: staged.homeDir, env: {} }).attach(
      /** @type {any} */ ({ endpoint: moved, config: {}, stdout, stderr, json: false })
    )
    assert.deepEqual(outcome, { status: 'done' })

    const written = await readConfig(staged.settingsPath)
    assert.equal(written.models.providers.anthropic.baseUrl, moved)
    assert.equal(written.models.providers.openai.baseUrl, `${moved}/v1`)
    // Still exactly the two entries, still both headers, still the rest
    // of the file: a rewrite is not a merge.
    assert.deepEqual(written.models.providers.anthropic.headers, { 'x-hypaware-upstream': 'anthropic', 'x-hypaware-client': 'openclaw' })
    assert.deepEqual(written.models.providers.openai.models, [])
    assert.equal(written.theme, 'dark')
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

// Upgrade path from entries written before the client header existed: the
// ownership predicate keys on the marker header alone, so a pre-fix entry
// (marker, empty models, no `x-hypaware-client`) is still ours, and a
// re-attach over it must succeed and add the client header rather than
// refuse. Without this, every install attached before the LLP 0175 fix would
// keep misattributing until a manual detach/attach cycle.
// @ref LLP 0175#root-cause [tests]: re-attach upgrades a pre-client-header entry in place
test('re-attach over a pre-client-header entry succeeds and adds the header', async () => {
  const staged = await stage({
    models: {
      providers: {
        anthropic: {
          baseUrl: 'http://127.0.0.1:4000',
          headers: { 'x-hypaware-upstream': 'anthropic' },
          models: [],
        },
        openai: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          headers: { 'x-hypaware-upstream': 'openai' },
          models: [],
        },
      },
    },
  })
  try {
    const { outcome } = await runAttach(staged)
    assert.deepEqual(outcome, { status: 'done' })
    const written = await readConfig(staged.settingsPath)
    assert.equal(written.models.providers.anthropic.headers['x-hypaware-client'], 'openclaw')
    assert.equal(written.models.providers.openai.headers['x-hypaware-client'], 'openclaw')
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

// R2 must survive the ownership rule: everything that is not *exactly* the
// entry attach writes is still somebody else's, and still refuses. These are
// the near misses, not the obvious cases the test above covers.
test('an entry that is not ours still refuses, however close it looks (R2)', async () => {
  /** @type {Array<[string, unknown]>} */
  const notOurs = [
    // A deliberate "route nothing here" override: bare presence, no shape.
    ['null', null],
    // The marker header, but a hand-edited model list: not the shape attach
    // produces, so not an entry attach may silently replace.
    ['marker header but a hand-edited models list', {
      baseUrl: 'http://127.0.0.1:4000',
      headers: { 'x-hypaware-upstream': 'anthropic' },
      models: ['claude-opus-4'],
    }],
    // The marker header naming a *different* upstream: whatever wrote this, it
    // is not the anthropic entry attach writes at this key.
    ['marker header naming another key', {
      baseUrl: 'http://127.0.0.1:4000',
      headers: { 'x-hypaware-upstream': 'openai' },
      models: [],
    }],
    // Our exact shape minus the marker: the marker is the whole ownership
    // claim, so without it this is a user pointing at a local proxy of theirs.
    ['no marker header', { baseUrl: 'http://127.0.0.1:4000', models: [] }],
  ]
  for (const [label, entry] of notOurs) {
    const before = { models: { providers: { anthropic: entry } } }
    const staged = await stage(before)
    try {
      const { outcome } = await runAttach(staged)
      assert.equal(outcome.status, 'failed', label)
      assert.match(outcome.status === 'failed' ? outcome.reason : '', /models\.providers\.anthropic already exists/)
      // Pure read-then-decide still: nothing partially written over a refusal.
      assert.deepEqual(await readConfig(staged.settingsPath), before, label)
    } finally {
      await fs.rm(staged.homeDir, { recursive: true, force: true })
    }
  }
})

test('attach never throws on refusal, so attach-on-join warns instead of failing', async () => {
  const staged = await stage({
    models: { providers: { openai: { baseUrl: 'https://mine.example', models: [] } } },
  })
  try {
    // Deliberately unguarded by assert.rejects/doesNotReject wrappers: any
    // throw fails the test outright, which is the assertion. The reconciler's
    // `perform()` turns a throw into a `failed` outcome for the *whole join*
    // action, so the refusal has to come back as a value.
    const { outcome } = await runAttach(staged, { json: true })
    assert.equal(outcome.status, 'failed')
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

test('attach prints the openclaw gateway restart instruction on the human path (R4)', async () => {
  const staged = await stage({ models: { providers: {} } })
  try {
    const { stdout } = await runAttach(staged)
    assert.match(stdout, /openclaw gateway restart/)
    assert.match(stdout, /OpenClaw attached/)
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

test('attach prints the restart instruction on the --json path too (R4)', async () => {
  const staged = await stage({ models: { providers: {} } })
  try {
    const { stdout } = await runAttach(staged, { json: true })
    const payload = JSON.parse(stdout.trim())
    assert.equal(payload.status, 'ok')
    assert.equal(payload.action, 'attach')
    assert.equal(payload.client, 'openclaw')
    assert.equal(payload.changed, true)
    assert.equal(payload.settings_path, staged.settingsPath)
    // A scripted caller is as blocked on the restart as a human is, so the
    // instruction is a field, not prose it would have to scrape.
    assert.equal(payload.restart_required, true)
    assert.equal(payload.restart_command, 'openclaw gateway restart')
    assert.match(payload.message, /openclaw gateway restart/)
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

test('attach --dry-run reports the write without touching the file', async () => {
  const before = { models: { providers: {} } }
  const staged = await stage(before)
  try {
    const { outcome, stdout } = await runAttach(staged, { dryRun: true })
    assert.deepEqual(outcome, { status: 'done' })
    assert.match(stdout, /\(dry-run\) Would attach OpenClaw/)
    assert.match(stdout, /openclaw gateway restart/)
    assert.deepEqual(await readConfig(staged.settingsPath), before)
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

test('attach --dry-run reports the refusal it would hit, not a write it would not do', async () => {
  const staged = await stage({
    models: { providers: { anthropic: { baseUrl: 'https://mine.example', models: [] } } },
  })
  try {
    const { outcome } = await runAttach(staged, { dryRun: true })
    assert.equal(outcome.status, 'failed')
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})

test('attach resolves openclaw.json through $OPENCLAW_HOME when set', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-openclaw-attach-home-'))
  const openclawHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-openclaw-attach-oc-'))
  try {
    const settingsPath = path.join(openclawHome, 'openclaw.json')
    await fs.writeFile(settingsPath, JSON.stringify({ models: { providers: {} } }, null, 2))

    const stdout = makeBuf()
    const stderr = makeBuf()
    const attacher = createOpenclawAttach({ homeDir, env: { OPENCLAW_HOME: openclawHome } })
    const outcome = await attacher.attach(
      /** @type {any} */ ({ endpoint: ENDPOINT, config: {}, stdout, stderr, json: true })
    )

    assert.deepEqual(outcome, { status: 'done' })
    assert.equal(JSON.parse(stdout.text().trim()).settings_path, settingsPath)
    const written = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(written.models.providers.anthropic.baseUrl, ENDPOINT)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
    await fs.rm(openclawHome, { recursive: true, force: true })
  }
})

test('a missing openclaw.json is a hard failure, not a config attach invents', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-openclaw-attach-missing-'))
  try {
    const { outcome } = await runAttach({ homeDir })
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.status === 'failed' ? outcome.reason : '', /does not exist/)
    // Attach cannot reason about a config it cannot read, and creating one
    // would hand OpenClaw a file it never had.
    await assert.rejects(fs.stat(path.join(homeDir, '.openclaw', 'openclaw.json')))
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('a malformed openclaw.json is a hard failure, and is left alone', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-openclaw-attach-bad-'))
  try {
    const settingsPath = path.join(homeDir, '.openclaw', 'openclaw.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, '{ not json')

    const { outcome } = await runAttach({ homeDir })
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.status === 'failed' ? outcome.reason : '', /malformed JSON/)
    assert.equal(await fs.readFile(settingsPath, 'utf8'), '{ not json')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('a trailing slash on the endpoint does not double the openai /v1 separator', async () => {
  const staged = await stage({ models: { providers: {} } })
  try {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const attacher = createOpenclawAttach({ homeDir: staged.homeDir, env: {} })
    await attacher.attach(
      /** @type {any} */ ({ endpoint: `${ENDPOINT}/`, config: {}, stdout, stderr })
    )

    const written = await readConfig(staged.settingsPath)
    assert.equal(written.models.providers.anthropic.baseUrl, ENDPOINT)
    assert.equal(written.models.providers.openai.baseUrl, `${ENDPOINT}/v1`)
  } finally {
    await fs.rm(staged.homeDir, { recursive: true, force: true })
  }
})
