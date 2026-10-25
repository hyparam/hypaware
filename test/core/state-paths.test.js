// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import * as paths from '../../src/core/runtime/paths.js'

/**
 * The on-disk layout under HYP_HOME, pinned as literal strings. A change here
 * is a layout change (LLP 0557): the migration table is a diff of this
 * fixture, so a helper that drifts without the fixture following is a failure,
 * not a refactor.
 */
const HYP_HOME = '/home/u/.hyp'
const ROOT = '/home/u/.hyp/hypaware'

/** @type {Array<[string, string]>} */
const LAYOUT = [
  ['stateRootOf', `${ROOT}`],
  ['localConfigPath', `${HYP_HOME}/hypaware-config.json`],
  ['captureSpoolRoot', `${HYP_HOME}/spool`],
  ['askRoot', `${HYP_HOME}/ask`],
]

/** @type {Array<[string, string]>} */
const STATE = [
  ['cacheRootOf', `${ROOT}/cache`],
  ['credentialsPath', `${ROOT}/credentials.json`],
  ['coldStateDir', `${ROOT}/state`],
  ['clientAssetLedgerPath', `${ROOT}/state/client-assets.json`],
  ['configControlDir', `${ROOT}/state`],
  ['configControlStatePath', `${ROOT}/state/config-control.json`],
  ['configControlActivePath', `${ROOT}/state/managed-config.active`],
  ['configControlSeedPath', `${ROOT}/state/managed-config.seed.json`],
  ['clientActionsPath', `${ROOT}/state/client-actions.json`],
  ['clientActionLocksDir', `${ROOT}/state/client-action-locks`],
  ['selfUpdateStatePath', `${ROOT}/state/self-update.json`],
  ['syncCheckProofDir', `${ROOT}/state/sync-check`],
  ['configBackupsDir', `${ROOT}/state/config-backups`],
  ['usagePolicyDir', `${ROOT}/usage-policy`],
  ['sessionIgnoresDir', `${ROOT}/session-ignores`],
  ['productTelemetryRoot', `${ROOT}/product-telemetry`],
  ['tlsDir', `${ROOT}/tls`],
  ['devTelemetryDir', `${ROOT}/dev-telemetry`],
  ['daemonRunDir', `${ROOT}/run`],
  ['pidFilePath', `${ROOT}/run/hypaware.pid`],
  ['statusFilePath', `${ROOT}/run/status.json`],
  ['daemonLogDir', `${ROOT}/logs`],
  ['daemonLogPath', `${ROOT}/logs/daemon.log`],
  ['processingStateRoot', `${ROOT}/processing`],
  ['processingSupervisorDir', `${ROOT}/processing/supervisor`],
  ['sinksRoot', `${ROOT}/sinks`],
]

/**
 * Where the moved files lived before LLP 0557 phase 2, relative to the state
 * root, keyed by the helper that names them now. `migrateStateLayout` must
 * carry each one across; the test below builds this tree and checks.
 * @type {Array<[string, string]>}
 */
const LEGACY = [
  ['credentialsPath', 'remote-credentials.json'],
  ['clientAssetLedgerPath', 'client-assets.json'],
  ['configControlStatePath', 'config-control/state.json'],
  ['configControlSeedPath', 'config-control/seed.json'],
  ['clientActionsPath', 'config-control/client-actions.json'],
  ['selfUpdateStatePath', 'run/self-update.json'],
]

test('state paths: every kernel path resolves to the pinned layout', () => {
  for (const [name, expected] of LAYOUT) {
    const fn = /** @type {(h: string) => string} */ (/** @type {any} */ (paths)[name])
    assert.equal(typeof fn, 'function', name)
    assert.equal(fn(HYP_HOME), expected, name)
  }
  for (const [name, expected] of STATE) {
    if (name === 'usagePolicyDir') continue
    const fn = /** @type {(r: string) => string} */ (/** @type {any} */ (paths)[name])
    assert.equal(typeof fn, 'function', name)
    assert.equal(fn(ROOT), expected, name)
  }
  assert.equal(paths.configSlotPath(ROOT, 'a'), `${ROOT}/state/managed-config.a.json`)
  assert.equal(paths.configSlotPath(ROOT, 'b'), `${ROOT}/state/managed-config.b.json`)
  assert.equal(paths.configSlotEtagPath(ROOT, 'a'), `${ROOT}/state/managed-config.a.etag`)
  assert.equal(paths.configSlotEtagPath(ROOT, 'b'), `${ROOT}/state/managed-config.b.etag`)
  assert.equal(paths.usagePolicyPath(ROOT, 'first-sync-hold'), `${ROOT}/usage-policy/first-sync-hold.json`)
  assert.equal(paths.usagePolicyPath(ROOT, 'folder-ask'), `${ROOT}/usage-policy/folder-ask.json`)
  assert.equal(paths.usagePolicyPath(ROOT, 'local-only'), `${ROOT}/usage-policy/local-only.json`)
  assert.equal(paths.usagePolicyPath(ROOT, 'client-sync'), `${ROOT}/usage-policy/client-sync.json`)
  assert.equal(paths.sinkOutboxDir(ROOT, 'central'), `${ROOT}/sinks/central/outbox`)
  assert.equal(paths.pluginStateDir(ROOT, '@hypaware/claude'), `${ROOT}/plugins/@hypaware/claude`)
  assert.equal(paths.configBackupPath(`${HYP_HOME}/hypaware-config.json`, 'T1'), `${ROOT}/state/config-backups/hypaware-config.json.bak-T1`)
  // The processing daemon's files are the ordinary helpers over its own root.
  assert.equal(paths.pidFilePath(paths.processingStateRoot(ROOT)), `${ROOT}/processing/run/hypaware.pid`)
  assert.equal(paths.daemonLogPath(paths.processingStateRoot(ROOT)), `${ROOT}/processing/logs/daemon.log`)
})

test('state paths: HYP_HOME resolution honours the override, the given home, and never an empty home', () => {
  assert.equal(paths.hypHomeFromEnv({ HYP_HOME: '/x' }, '/ignored'), '/x')
  assert.equal(paths.hypHomeFromEnv({}, '/home/u'), '/home/u/.hyp')
  assert.equal(paths.stateRootFromEnv({}, '/home/u'), '/home/u/.hyp/hypaware')
  // @ref LLP 0300#home-resolution [tests]: '' is never a home
  assert.ok(path.isAbsolute(paths.hypHomeFromEnv({}, '')))
  assert.notEqual(paths.hypHomeFromEnv({}, ''), '.hyp')
})

/** @returns {{ hypHome: string, root: string }} */
function tmpTree() {
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-state-layout-'))
  const root = path.join(hypHome, 'hypaware')
  fs.mkdirSync(root, { recursive: true })
  return { hypHome, root }
}

/** @param {string} file @param {string} body */
function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** @param {string} dir @returns {string[]} */
function tree(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tree(full))
    else out.push(path.relative(dir, full))
  }
  return out.map((p) => path.relative(dir, path.join(dir, p)))
}

/** @param {string} root */
function buildLegacyTree(root) {
  for (const [name, rel] of LEGACY) put(path.join(root, rel), `{"from":"${name}"}`)
  put(path.join(root, 'config-control', 'config.a.json'), '{"slot":"a"}')
  put(path.join(root, 'config-control', 'config.b.json'), '{"slot":"b"}')
  put(path.join(root, 'config-control', 'config.a.etag'), 'etag-a')
  put(path.join(root, 'config-control', 'config.b.etag'), 'etag-b')
  fs.symlinkSync('config.b.json', path.join(root, 'config-control', 'active'))
  put(path.join(root, 'config-control', 'client-action-locks', 'attach-claude.lock'), '')
  put(path.join(root, 'sync-check', 'abc.json'), '{}')
  // Unmoved neighbours, which must stay exactly where they are.
  put(path.join(root, 'usage-policy', 'local-only.json'), '{}')
  put(path.join(root, 'run', 'status.json'), '{}')
  put(path.join(root, 'logs', 'daemon.log'), '')
  const hypHome = path.dirname(root)
  put(path.join(hypHome, 'hypaware-config.json'), '{"version":2}')
  for (let i = 1; i <= 7; i++) put(path.join(hypHome, `hypaware-config.json.bak-2026-10-0${i}T00-00-00-000Z`), `{"n":${i}}`)
}

// @ref LLP 0557#phase-2-cold-state-into-state [tests]: the old tree moves across once, the second run finds nothing to do, and the old tree is gone
test('state layout: the migration moves the legacy tree across and is idempotent', () => {
  const { hypHome, root } = tmpTree()
  buildLegacyTree(root)

  const moved = paths.migrateStateLayout(root)
  assert.ok(moved.length >= LEGACY.length + 7, `moved ${moved.length}`)

  for (const [name, rel] of LEGACY) {
    const fn = /** @type {(r: string) => string} */ (/** @type {any} */ (paths)[name])
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} still at the legacy path`)
    assert.equal(fs.readFileSync(fn(root), 'utf8'), `{"from":"${name}"}`, name)
  }
  assert.equal(fs.readFileSync(paths.configSlotPath(root, 'a'), 'utf8'), '{"slot":"a"}')
  assert.equal(fs.readFileSync(paths.configSlotEtagPath(root, 'b'), 'utf8'), 'etag-b')
  // The pointer is recreated against the renamed slot, and still resolves.
  assert.equal(fs.readlinkSync(paths.configControlActivePath(root)), 'managed-config.b.json')
  assert.equal(fs.readFileSync(paths.configControlActivePath(root), 'utf8'), '{"slot":"b"}')
  assert.ok(fs.existsSync(path.join(paths.clientActionLocksDir(root), 'attach-claude.lock')))
  assert.ok(fs.existsSync(path.join(paths.syncCheckProofDir(root), 'abc.json')))
  assert.equal(fs.existsSync(path.join(root, 'config-control')), false, 'the empty legacy directory is removed')
  assert.equal(fs.existsSync(path.join(root, 'sync-check')), false)
  // Backups moved in and capped to the newest five.
  const backups = fs.readdirSync(paths.configBackupsDir(root)).sort()
  assert.deepEqual(backups.map((n) => n.replace(/^.*bak-2026-10-(..).*$/, '$1')), ['03', '04', '05', '06', '07'])
  assert.deepEqual(fs.readdirSync(hypHome).filter((n) => n.includes('.bak-')), [])
  // Neighbours untouched.
  assert.ok(fs.existsSync(path.join(root, 'usage-policy', 'local-only.json')))
  assert.ok(fs.existsSync(path.join(root, 'run', 'status.json')))
  assert.ok(fs.existsSync(path.join(root, 'logs', 'daemon.log')))

  const after = tree(root)
  assert.deepEqual(paths.migrateStateLayout(root), [], 'a second run has nothing to move')
  assert.deepEqual(tree(root), after)
  fs.rmSync(hypHome, { recursive: true, force: true })
})

test('state layout: a fresh tree is left exactly as found', () => {
  const { hypHome, root } = tmpTree()
  assert.deepEqual(paths.migrateStateLayout(root), [])
  assert.deepEqual(fs.readdirSync(root), [])
  assert.equal(paths.settleStateLayout(root), 'current')
  assert.deepEqual(fs.readdirSync(root), [], 'a CLI settle creates nothing')
  assert.equal(paths.settleStateLayout(root, { daemon: true }), 'current')
  assert.deepEqual(fs.readdirSync(root), ['state'], 'the daemon marks the tree current')
  fs.rmSync(hypHome, { recursive: true, force: true })
})

// @ref LLP 0557#phase-2-cold-state-into-state [tests]: beside a live daemon from the previous release the CLI reads the legacy side and moves nothing
test('state layout: a live daemon from the previous release holds the CLI on the legacy paths', () => {
  const { hypHome, root } = tmpTree()
  buildLegacyTree(root)
  put(paths.pidFilePath(root), JSON.stringify({ pid: process.pid, startedAt: 'x', runId: 'r', mode: 'detached' }))

  assert.equal(paths.settleStateLayout(root), 'legacy')
  assert.equal(paths.credentialsPath(root), path.join(root, 'remote-credentials.json'))
  assert.equal(paths.configSlotPath(root, 'a'), path.join(root, 'config-control', 'config.a.json'))
  assert.equal(paths.configControlDir(root), path.join(root, 'config-control'))
  assert.equal(paths.configBackupPath(path.join(hypHome, 'hypaware-config.json'), 'T'), path.join(hypHome, 'hypaware-config.json.bak-T'))
  assert.ok(fs.existsSync(path.join(root, 'config-control', 'state.json')), 'nothing moved')
  assert.equal(fs.existsSync(path.join(root, 'state')), false)

  // The daemon's own start is the moment the move happens.
  assert.equal(paths.settleStateLayout(root, { daemon: true }), 'current')
  assert.equal(paths.credentialsPath(root), path.join(root, 'credentials.json'))
  assert.ok(fs.existsSync(paths.configControlStatePath(root)))
  fs.rmSync(hypHome, { recursive: true, force: true })
})

test('state layout: config backups are pruned to the newest five', () => {
  const { hypHome, root } = tmpTree()
  const dir = paths.configBackupsDir(root)
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 10; i <= 18; i++) fs.writeFileSync(path.join(dir, `hypaware-config.json.bak-2026-10-${i}T00-00-00-000Z`), '')
  fs.writeFileSync(path.join(dir, 'other.json.bak-2026-10-01T00-00-00-000Z'), '')
  paths.pruneConfigBackups(dir, 'hypaware-config.json')
  const left = fs.readdirSync(dir).sort()
  assert.equal(left.filter((n) => n.startsWith('hypaware-config.json.bak-')).length, paths.CONFIG_BACKUPS_KEEP)
  assert.ok(left.includes('hypaware-config.json.bak-2026-10-18T00-00-00-000Z'))
  assert.ok(!left.includes('hypaware-config.json.bak-2026-10-10T00-00-00-000Z'))
  assert.ok(left.includes('other.json.bak-2026-10-01T00-00-00-000Z'), 'another family is not touched')
  fs.rmSync(hypHome, { recursive: true, force: true })
})

/**
 * The segments and basenames that only `paths.js` may spell. A `path.join`
 * that names a state-root variable and one of these literals is a second
 * definition of the layout, which is what LLP 0557 phase 1 removed.
 */
const OWNED = [
  'state', 'config-control', 'usage-policy', 'product-telemetry', 'session-ignores', 'sync-check', 'config-backups',
  'run', 'processing', 'logs', 'sinks', 'tls', 'spool', 'dev-telemetry', 'cache', 'hypaware', '.hyp', 'ask',
  'client-assets.json', 'remote-credentials.json', 'self-update.json', 'status.json', 'hypaware.pid',
  'daemon.log', 'state.json', 'config-control.json', 'seed.json', 'client-actions.json', 'hypaware-config.json',
]
const ROOT_IDENTS = ['stateRoot', 'stateDir', 'hypHome', 'controlDir', 'processingRoot', 'cacheRoot']
const SCAN = new RegExp(
  `path\\.join\\([^)]*\\b(${ROOT_IDENTS.join('|')})\\b[^)]*'(${OWNED.map((s) => s.replace(/\./g, '\\.')).join('|')})'`,
)

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue
      out.push(...sourceFiles(full))
    } else if (entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

test('state paths: no module outside paths.js joins a state root with a layout literal', () => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const repo = path.resolve(here, '..', '..')
  const owner = path.join(repo, 'src', 'core', 'runtime', 'paths.js')
  /** @type {string[]} */
  const offenders = []
  for (const dir of ['src', path.join('hypaware-core', 'plugins-workspace')]) {
    for (const file of sourceFiles(path.join(repo, dir))) {
      if (file === owner) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        if (SCAN.test(line)) offenders.push(`${path.relative(repo, file)}:${i + 1}: ${line.trim()}`)
      })
    }
  }
  assert.deepEqual(offenders, [], 'state paths are defined in src/core/runtime/paths.js only')
})
