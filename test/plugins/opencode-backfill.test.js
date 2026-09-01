// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createOpenCodeBackfillProvider } from '../../hypaware-core/plugins-workspace/opencode/src/backfill.js'

/**
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/** @param {string} id @param {string | undefined} directory */
function exportedSession(id, directory) {
  return {
    info: {
      id,
      ...(directory ? { directory } : {}),
      version: '1.18.22',
      time: { created: Date.parse('2026-08-24T10:00:00.000Z') },
    },
    messages: [
      {
        info: { id: `${id}-user`, role: 'user', time: { created: Date.parse('2026-08-24T10:00:01.000Z') } },
        parts: [{ id: `${id}-part`, type: 'text', text: `prompt ${id}` }],
      },
    ],
  }
}

/** @returns {BackfillRunContext} */
function runContext() {
  return {
    env: {},
    cacheRoot: '/unused',
    dryRun: false,
    since: '2026-08-24T09:00:00.000Z',
    until: '2026-08-24T11:00:00.000Z',
    storage: /** @type {any} */ ({}),
    log: /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {} }),
  }
}

/** @param {AsyncIterable<BackfillItem | BackfillEvent>} iterable */
async function collect(iterable) {
  /** @type {BackfillItem[]} */
  const items = []
  /** @type {BackfillEvent[]} */
  const events = []
  for await (const entry of iterable) {
    if (entry.type === 'event') events.push(entry)
    else items.push(entry)
  }
  return { items, events }
}

test('OpenCode backfill selects a bounded time window then exports only exact session ids', async () => {
  const calls = []
  const sessions = [
    { id: 'ses_in', updated: Date.parse('2026-08-24T10:00:00.000Z'), directory: '/work/in' },
    { id: 'ses_old', updated: Date.parse('2026-08-20T10:00:00.000Z'), directory: '/work/old' },
    { id: 'ses_no_time', directory: '/work/no-time' },
  ]
  const provider = createOpenCodeBackfillProvider({
    async runCommand(args) {
      calls.push(args)
      if (args[0] === 'session') return JSON.stringify(sessions)
      assert.deepEqual(args, ['export', 'ses_in'])
      return JSON.stringify(exportedSession('ses_in', '/work/in'))
    },
  })

  const result = await collect(provider.run(runContext()))
  assert.deepEqual(calls, [
    ['session', 'list', '--format', 'json', '--max-count', '1000'],
    ['export', 'ses_in'],
  ])
  assert.equal(result.items.length, 1)
  const projection = /** @type {any} */ (result.items[0].value)
  assert.equal(projection.session_id, 'ses_in')
  assert.equal(projection.entrypoint, 'unknown')
  assert.equal(projection.attributes.opencode.entrypoint_source, 'historical-export')
})

test('exact-id recovery does not list or inspect unrelated OpenCode history', async () => {
  const calls = []
  const provider = createOpenCodeBackfillProvider({
    exactSessionIds: ['ses_exact'],
    async runCommand(args) {
      calls.push(args)
      assert.deepEqual(args, ['export', 'ses_exact'])
      return JSON.stringify(exportedSession('ses_exact', '/work/exact'))
    },
  })

  const result = await collect(provider.run(runContext()))
  assert.deepEqual(calls, [['export', 'ses_exact']])
  assert.equal(result.items.length, 1)
})

test('recovery applies session ignore before export and reports missing cwd without guessing', async () => {
  const calls = []
  const provider = createOpenCodeBackfillProvider({
    exactSessionIds: ['ses_ignored', 'ses_missing'],
    ignoredSessions: new Set(['ses_ignored']),
    async runCommand(args) {
      calls.push(args)
      assert.deepEqual(args, ['export', 'ses_missing'])
      return JSON.stringify(exportedSession('ses_missing', undefined))
    },
  })

  const result = await collect(provider.run(runContext()))
  assert.deepEqual(calls, [['export', 'ses_missing']])
  assert.equal(result.items.length, 0)
  assert.deepEqual(result.events.map((entry) => entry.event), ['session_ignore_drop', 'missing_cwd'])
})

test('recovery drops .hypignore and machine-local ignore while preserving local-only for local storage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-opencode-backfill-'))
  const ignored = path.join(root, 'ignored')
  const localOnly = path.join(root, 'local-only')
  const privateDir = path.join(root, 'machine-private')
  const policyPath = path.join(root, 'usage-policy', 'local-only.json')
  try {
    await fs.mkdir(ignored, { recursive: true })
    await fs.mkdir(localOnly, { recursive: true })
    await fs.mkdir(privateDir, { recursive: true })
    await fs.writeFile(path.join(ignored, '.hypignore'), 'ignore\n', 'utf8')
    await fs.mkdir(path.dirname(policyPath), { recursive: true })
    await fs.writeFile(policyPath, JSON.stringify({
      version: 2,
      entries: [
        { dir: localOnly, class: 'local-only' },
        { dir: privateDir, class: 'ignore' },
      ],
    }), 'utf8')

    const exports = {
      ses_dotfile: exportedSession('ses_dotfile', ignored),
      ses_local: exportedSession('ses_local', localOnly),
      ses_private: exportedSession('ses_private', privateDir),
    }
    const provider = createOpenCodeBackfillProvider({
      exactSessionIds: Object.keys(exports),
      localOnlyListPath: policyPath,
      async runCommand(args) {
        return JSON.stringify(exports[/** @type {keyof typeof exports} */ (args[1])])
      },
    })

    const result = await collect(provider.run(runContext()))
    assert.deepEqual(result.items.map((item) => /** @type {any} */ (item.value).session_id), ['ses_local'])
    assert.equal(/** @type {any} */ (result.items[0].value).cwd, localOnly)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// One unreadable session must not sink the rest of the run: the export shells
// out per session, so a single missing/corrupt session id would otherwise throw
// out of the generator and drop every session after it (up to 1000 of them).
test('OpenCode backfill warns past an unreadable session and keeps going', async () => {
  const sessions = [
    { id: 'ses_a', updated: Date.parse('2026-08-24T10:00:00.000Z'), directory: '/work/a' },
    { id: 'ses_throws', updated: Date.parse('2026-08-24T10:00:00.000Z'), directory: '/work/b' },
    { id: 'ses_bad_json', updated: Date.parse('2026-08-24T10:00:00.000Z'), directory: '/work/c' },
    { id: 'ses_z', updated: Date.parse('2026-08-24T10:00:00.000Z'), directory: '/work/d' },
  ]
  const provider = createOpenCodeBackfillProvider({
    async runCommand(args) {
      if (args[0] === 'session') return JSON.stringify(sessions)
      if (args[1] === 'ses_throws') throw new Error('opencode exited with code 1')
      if (args[1] === 'ses_bad_json') return '{ not json'
      return JSON.stringify(exportedSession(args[1], `/work/${args[1]}`))
    },
  })

  /** @type {{ event: string, attrs: Record<string, any> }[]} */
  const warnings = []
  const ctx = runContext()
  ctx.log = /** @type {any} */ ({
    info() {},
    debug() {},
    error() {},
    warn(/** @type {string} */ event, /** @type {any} */ attrs) { warnings.push({ event, attrs }) },
  })

  const { items } = await collect(provider.run(ctx))

  assert.deepEqual(items.map((i) => i.provenance?.native_id), ['ses_a', 'ses_z'])
  assert.deepEqual(warnings.map((w) => w.event), [
    'opencode.backfill.session_read_failed',
    'opencode.backfill.session_read_failed',
  ])
  assert.deepEqual(warnings.map((w) => w.attrs.session_id), ['ses_throws', 'ses_bad_json'])
  assert.equal(warnings[0].attrs.error_kind, 'session_read_failed')
  assert.equal(warnings[0].attrs.source_path, 'opencode export ses_throws')
  assert.equal(warnings[0].attrs.status, 'error')
})

// A Desktop-only install has no `opencode` binary, and Desktop is half of what
// this adapter attaches. The list command's ENOENT is that machine saying it
// has no CLI history to read, not a failure: reading it as one made every
// OpenCode setup close on "backfill opencode: failed", where the file-reading
// claude and codex providers report ok with zero rows for the same fact.
test('OpenCode backfill reports no history rather than a failure when the CLI is absent', async () => {
  const provider = createOpenCodeBackfillProvider({
    async runCommand() {
      const err = /** @type {NodeJS.ErrnoException} */ (new Error('spawn opencode ENOENT'))
      err.code = 'ENOENT'
      throw err
    },
  })

  /** @type {{ event: string, attrs: Record<string, any> }[]} */
  const logged = []
  const ctx = runContext()
  ctx.log = /** @type {any} */ ({
    debug() {},
    warn() {},
    error() {},
    info(/** @type {string} */ event, /** @type {any} */ attrs) { logged.push({ event, attrs }) },
  })

  const { items, events } = await collect(provider.run(ctx))
  assert.deepEqual(items, [])
  assert.deepEqual(events, [])
  assert.deepEqual(logged.map((l) => l.event), ['opencode.backfill.cli_absent'])
  assert.equal(logged[0].attrs.status, 'ok')
  assert.equal(logged[0].attrs.reason, 'opencode_cli_absent')
})

// Only the spawn's own ENOENT is "no history here". A list command that ran and
// then failed is a real failure and must still reach the caller, or a broken
// OpenCode install silently reports zero sessions forever.
test('OpenCode backfill still fails when the list command runs and errors', async () => {
  const provider = createOpenCodeBackfillProvider({
    async runCommand() { throw new Error('opencode exited with code 1') },
  })
  await assert.rejects(collect(provider.run(runContext())), /exited with code 1/)
})
