// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  SUGGESTED_PROMPTS,
  resolveLaunchers,
  resolveOnPath,
  runWizardFirstAsk,
} from '../../../../src/core/cli/wizard/first_ask.js'
import { PromptCancelledError } from '../../../../src/core/cli/tui/index.js'

// The wizard's closing first ask (LLP 0195): which clients it will offer,
// that a pick becomes a real spawn carrying the question, and that no
// failure mode of any of it can fail a finished install.
// @ref LLP 0195#first-ask [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/** A descriptor map with `claude` launchable and `claude-desktop` not. */
function descriptors() {
  return new Map(/** @type {any} */ ([
    ['claude', {
      plugin: '@hypaware/claude',
      name: 'claude',
      skillDir: '.claude/skills',
      launch: { bin: 'claude', args: ['{prompt}'], label: 'Claude Code' },
    }],
    ['codex', {
      plugin: '@hypaware/codex',
      name: 'codex',
      skillDir: '.codex/skills',
      launch: { bin: 'codex', args: ['{prompt}'], label: 'Codex' },
    }],
    ['claude-desktop', {
      plugin: '@hypaware/claude-desktop',
      name: 'claude-desktop',
      skillDir: '.claude/skills',
    }],
  ]))
}

/** Records what would have been spawned and exits 0 without running it. */
function recordingSpawn() {
  /** @type {{ cmd: string, args: string[], opts: any }[]} */
  const calls = []
  /** @type {any} */
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('close', 0))
    return child
  }
  return { fn, calls }
}

/** The list is editable content; tests anchor on its shape, never on an id. */
const FIRST = SUGGESTED_PROMPTS[0]

/** @param {string|number} value */
function selectReturning(value) {
  /** @type {any[]} */
  const seen = []
  /** @type {any} */
  const fn = async (spec) => { seen.push(spec); return value }
  return { fn, seen }
}

test('resolveOnPath: finds an executable on PATH, ignores a non-executable match', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-firstask-'))
  const exe = path.join(dir, 'fakeclient')
  await fsp.writeFile(exe, '#!/bin/sh\n', { mode: 0o755 })
  const plain = path.join(dir, 'notexec')
  await fsp.writeFile(plain, 'x', { mode: 0o644 })

  assert.equal(await resolveOnPath('fakeclient', { PATH: dir }, 'darwin'), exe)
  assert.equal(await resolveOnPath('notexec', { PATH: dir }, 'darwin'), undefined)
  assert.equal(await resolveOnPath('absent', { PATH: dir }, 'darwin'), undefined)
  // An empty PATH is not an error, just nothing found.
  assert.equal(await resolveOnPath('fakeclient', {}, 'darwin'), undefined)
})

test('resolveLaunchers: picked and resolvable only; a launch-less client is never offered', async () => {
  // @ref LLP 0195#path-probe [tests]: detection is not launchability
  const launchers = await resolveLaunchers({
    clients: ['claude', 'codex', 'claude-desktop'],
    descriptors: descriptors(),
    env: {},
    // codex is picked but absent from PATH; claude-desktop has no launch spec
    resolve: async (bin) => (bin === 'claude' ? '/usr/local/bin/claude' : undefined),
  })
  assert.deepEqual(launchers.map((l) => l.client), ['claude'])
  assert.equal(launchers[0].binPath, '/usr/local/bin/claude')
  assert.equal(launchers[0].label, 'Claude Code')
})

test('resolveLaunchers: an unpicked client is not offered even when it resolves', async () => {
  const launchers = await resolveLaunchers({
    clients: ['claude'],
    descriptors: descriptors(),
    env: {},
    resolve: async () => '/usr/local/bin/anything',
  })
  assert.deepEqual(launchers.map((l) => l.client), ['claude'])
})

test('runWizardFirstAsk: a pick spawns the client with the question as argv', async () => {
  // @ref LLP 0195#real-launch [tests]: the launch is real, inherits the terminal, and carries the prompt
  const stdout = makeBuf()
  const spawner = recordingSpawn()
  const chooser = selectReturning(FIRST.id)
  const result = await runWizardFirstAsk({
    clients: ['claude'],
    descriptors: descriptors(),
    stdout,
    env: {},
    interactive: true,
    cwd: '/w/acme',
    resolve: async () => '/usr/local/bin/claude',
    spawnFn: spawner.fn,
    select: chooser.fn,
  })

  assert.deepEqual(result, { launched: true, client: 'claude', promptId: FIRST.id, exitCode: 0 })
  assert.equal(spawner.calls.length, 1)
  assert.equal(spawner.calls[0].cmd, '/usr/local/bin/claude')
  const expected = FIRST.prompt
  assert.deepEqual(spawner.calls[0].args, [expected])
  // The child must own the terminal, or it draws over the wizard's frame.
  assert.equal(spawner.calls[0].opts.stdio, 'inherit')
  assert.equal(spawner.calls[0].opts.cwd, '/w/acme')
  // Announced before the handoff: a client that takes a moment to draw
  // must not read as a hang.
  assert.match(stdout.text(), /Starting Claude Code/)
  // A launch replaces the list; it is not also printed.
  assert.doesNotMatch(stdout.text(), /Questions worth asking/)
})

test('runWizardFirstAsk: every `{prompt}` slot in a manifest arg template is filled', async () => {
  const spawner = recordingSpawn()
  const result = await runWizardFirstAsk({
    clients: ['x'],
    descriptors: new Map(/** @type {any} */ ([['x', {
      plugin: '@hypaware/x', name: 'x', skillDir: '.x',
      launch: { bin: 'x', args: ['run', '--prompt', '{prompt}'], label: 'X' },
    }]])),
    stdout: makeBuf(),
    env: {},
    interactive: true,
    resolve: async () => '/bin/x',
    spawnFn: spawner.fn,
    select: selectReturning(FIRST.id).fn,
  })
  assert.equal(result.launched, true)
  assert.deepEqual(spawner.calls[0].args.slice(0, 2), ['run', '--prompt'])
  assert.equal(spawner.calls[0].args[2], FIRST.prompt)
})

test('runWizardFirstAsk: no launchable client prints the list and launches nothing', async () => {
  const stdout = makeBuf()
  const spawner = recordingSpawn()
  const result = await runWizardFirstAsk({
    clients: ['claude-desktop'],
    descriptors: descriptors(),
    stdout,
    env: {},
    interactive: true,
    resolve: async () => undefined,
    spawnFn: spawner.fn,
    select: selectReturning(FIRST.id).fn,
  })
  assert.deepEqual(result, { launched: false, reason: 'no-launcher' })
  assert.equal(spawner.calls.length, 0)
  const text = stdout.text()
  assert.match(text, /Questions worth asking/)
  for (const p of SUGGESTED_PROMPTS) assert.ok(text.includes(p.prompt), `missing prompt ${p.id}`)
  // Nothing to start here, so the fallback names the manual route.
  assert.match(text, /Paste one into a Claude Code or Codex session/)
})

test('runWizardFirstAsk: the ask is framed, so it reads as a screen and not as more output', async () => {
  // @ref LLP 0195#frame [tests]: the closing ask is drawn as its own screen
  const stdout = makeBuf()
  const chooser = selectReturning(FIRST.id)
  await runWizardFirstAsk({
    clients: ['claude', 'codex'],
    descriptors: descriptors(),
    stdout,
    env: {},
    interactive: true,
    resolve: async () => '/usr/local/bin/anything',
    spawnFn: recordingSpawn().fn,
    select: chooser.fn,
  })
  // Both halves of the step: the question, then which client answers it.
  assert.equal(chooser.seen.length, 2)
  for (const spec of chooser.seen) assert.equal(spec.box, true)
})

test('runWizardFirstAsk: an empty cache suppresses the launch and says why', async () => {
  // @ref LLP 0195#empty-cache [tests]: no rows means no launch, whatever is on PATH
  const stdout = makeBuf()
  const spawner = recordingSpawn()
  const chooser = selectReturning(FIRST.id)
  const result = await runWizardFirstAsk({
    clients: ['claude'],
    descriptors: descriptors(),
    stdout,
    env: {},
    interactive: true,
    hasRows: false,
    resolve: async () => '/usr/local/bin/claude',
    spawnFn: spawner.fn,
    select: chooser.fn,
  })
  assert.deepEqual(result, { launched: false, reason: 'no-rows' })
  assert.equal(spawner.calls.length, 0)
  assert.equal(chooser.seen.length, 0, 'a menu whose every row answers from an empty cache is not shown')
  const text = stdout.text()
  assert.match(text, /Nothing recorded yet/)
  // The reason capture looks empty, which is not obvious: HypAware is not
  // retroactive beyond what backfill imported.
  assert.match(text, /captures from your next session onward/)
  // The questions still print, as something to come back to.
  for (const p of SUGGESTED_PROMPTS) assert.ok(text.includes(p.prompt), `missing prompt ${p.id}`)
  assert.match(text, /Run `hyp ask` then/)
})

test('runWizardFirstAsk: an unknown row count never withholds the offer', async () => {
  // @ref LLP 0195#empty-cache [tests]: only a definite no suppresses
  const spawner = recordingSpawn()
  const result = await runWizardFirstAsk({
    clients: ['claude'],
    descriptors: descriptors(),
    stdout: makeBuf(),
    env: {},
    interactive: true,
    // hasRows omitted: the caller could not tell
    resolve: async () => '/usr/local/bin/claude',
    spawnFn: spawner.fn,
    select: selectReturning(FIRST.id).fn,
  })
  assert.equal(result.launched, true)
  assert.equal(spawner.calls.length, 1)
})

test('runWizardFirstAsk: "Not now" and a cancelled prompt both decline, and keep the list', async () => {
  for (const chooser of [
    selectReturning('__not_now__').fn,
    /** @type {any} */ (async () => { throw new PromptCancelledError() }),
  ]) {
    const stdout = makeBuf()
    const spawner = recordingSpawn()
    const result = await runWizardFirstAsk({
      clients: ['claude'],
      descriptors: descriptors(),
      stdout,
      env: {},
      interactive: true,
      resolve: async () => '/usr/local/bin/claude',
      spawnFn: spawner.fn,
      select: chooser,
    })
    assert.deepEqual(result, { launched: false, reason: 'declined' })
    assert.equal(spawner.calls.length, 0)
    assert.match(stdout.text(), /hyp ask/)
  }
})

test('runWizardFirstAsk: a non-interactive run prints the list and never prompts', async () => {
  const stdout = makeBuf()
  const chooser = selectReturning(FIRST.id)
  const result = await runWizardFirstAsk({
    clients: ['claude'],
    descriptors: descriptors(),
    stdout,
    env: {},
    interactive: false,
    resolve: async () => '/usr/local/bin/claude',
    select: chooser.fn,
  })
  assert.deepEqual(result, { launched: false, reason: 'not-interactive' })
  assert.equal(chooser.seen.length, 0)
  assert.match(stdout.text(), /Questions worth asking/)
})

test('runWizardFirstAsk: a spawn failure degrades to the list, never a throw', async () => {
  // @ref LLP 0195#real-launch [tests]: nothing here may fail a finished install
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {any} */
  const failing = () => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', new Error('ENOENT')))
    return child
  }
  const result = await runWizardFirstAsk({
    clients: ['claude'],
    descriptors: descriptors(),
    stdout,
    stderr,
    env: {},
    interactive: true,
    resolve: async () => '/usr/local/bin/claude',
    spawnFn: failing,
    select: selectReturning(FIRST.id).fn,
  })
  assert.deepEqual(result, { launched: false, reason: 'spawn-failed' })
  assert.match(stderr.text(), /Could not start claude: ENOENT/)
  assert.match(stdout.text(), /Questions worth asking/)
})

test('runWizardFirstAsk: an unforeseen error is contained', async () => {
  const stdout = makeBuf()
  const result = await runWizardFirstAsk({
    clients: ['claude'],
    descriptors: descriptors(),
    stdout,
    env: {},
    interactive: true,
    resolve: async () => '/usr/local/bin/claude',
    select: /** @type {any} */ (async () => { throw new TypeError('boom') }),
  })
  assert.deepEqual(result, { launched: false, reason: 'error' })
  assert.match(stdout.text(), /Questions worth asking/)
})

test('runWizardFirstAsk: two launchable clients ask which one answers', async () => {
  const spawner = recordingSpawn()
  /** @type {any[]} */
  const specs = []
  /** @type {any} */
  const chooser = async (spec) => {
    specs.push(spec)
    return specs.length === 1 ? FIRST.id : 'codex'
  }
  const result = await runWizardFirstAsk({
    clients: ['claude', 'codex'],
    descriptors: descriptors(),
    stdout: makeBuf(),
    env: {},
    interactive: true,
    resolve: async (bin) => `/usr/local/bin/${bin}`,
    spawnFn: spawner.fn,
    select: chooser,
  })
  assert.deepEqual(result, { launched: true, client: 'codex', promptId: FIRST.id, exitCode: 0 })
  assert.equal(specs.length, 2)
  assert.match(specs[1].title, /Which client/)
  assert.equal(spawner.calls[0].cmd, '/usr/local/bin/codex')
})

test('the suggested prompts are a short list of distinct, routable questions', async () => {
  // @ref LLP 0195#split [tests]: core owns the questions, and they name no machinery
  // The exact count is editable content, not a contract. What is pinned is
  // that the list stays short enough to scan and long enough to teach: a
  // menu of one is not a curriculum, and one of ten is a wall.
  assert.ok(SUGGESTED_PROMPTS.length >= 3 && SUGGESTED_PROMPTS.length <= 6,
    `expected 3-6 questions, got ${SUGGESTED_PROMPTS.length}`)
  assert.equal(new Set(SUGGESTED_PROMPTS.map((p) => p.id)).size, SUGGESTED_PROMPTS.length, 'ids must be unique')
  for (const p of SUGGESTED_PROMPTS) {
    assert.ok(p.id && p.label && p.prompt, 'every question needs an id, a label, and a prompt')
    assert.ok(p.prompt.length > 20, `${p.id} prompt is too terse to route`)
    // A skill *name* is machinery the user should never have to learn; the
    // word "skill" as a subject ("worth making into a skill") is theirs.
    assert.doesNotMatch(p.prompt, /hypaware-[a-z]|\bdataset\b|\bSQL\b/i,
      `${p.id} names machinery the user should not need`)
  }
})

test('every suggested label fits a narrow terminal without wrapping', async () => {
  // A wrapped menu row costs two lines and reads as two options. 72 columns
  // leaves room for the "> " cursor gutter inside an 80-column terminal.
  const tooLong = SUGGESTED_PROMPTS.filter((p) => p.label.length > 72)
  assert.deepEqual(tooLong.map((p) => `${p.id} (${p.label.length} cols)`), [])
})
