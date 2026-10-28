// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import * as paths from '../../src/core/runtime/paths.js'

/**
 * The on-disk layout under HYP_HOME, pinned as literal strings. A change here
 * is a layout change (LLP 0557 phase 2): the migration table is a diff of this
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
  ['credentialsPath', `${ROOT}/remote-credentials.json`],
  ['clientAssetLedgerPath', `${ROOT}/client-assets.json`],
  ['configControlDir', `${ROOT}/config-control`],
  ['configControlStatePath', `${ROOT}/config-control/state.json`],
  ['configControlActivePath', `${ROOT}/config-control/active`],
  ['configControlSeedPath', `${ROOT}/config-control/seed.json`],
  ['clientActionsPath', `${ROOT}/config-control/client-actions.json`],
  ['clientActionLocksDir', `${ROOT}/config-control/client-action-locks`],
  ['sessionIgnoresDir', `${ROOT}/session-ignores`],
  ['productTelemetryRoot', `${ROOT}/product-telemetry`],
  ['syncCheckProofDir', `${ROOT}/sync-check`],
  ['tlsDir', `${ROOT}/tls`],
  ['devTelemetryDir', `${ROOT}/dev-telemetry`],
  ['daemonRunDir', `${ROOT}/run`],
  ['pidFilePath', `${ROOT}/run/hypaware.pid`],
  ['statusFilePath', `${ROOT}/run/status.json`],
  ['selfUpdateStatePath', `${ROOT}/run/self-update.json`],
  ['daemonLogDir', `${ROOT}/logs`],
  ['daemonLogPath', `${ROOT}/logs/daemon.log`],
  ['processingStateRoot', `${ROOT}/processing`],
  ['processingSupervisorDir', `${ROOT}/processing/supervisor`],
  ['sinksRoot', `${ROOT}/sinks`],
]

test('state paths: every kernel path resolves to the pinned layout', () => {
  for (const [name, expected] of LAYOUT) {
    const fn = /** @type {(h: string) => string} */ (/** @type {any} */ (paths)[name])
    assert.equal(typeof fn, 'function', name)
    assert.equal(fn(HYP_HOME), expected, name)
  }
  for (const [name, expected] of STATE) {
    const fn = /** @type {(r: string) => string} */ (/** @type {any} */ (paths)[name])
    assert.equal(typeof fn, 'function', name)
    assert.equal(fn(ROOT), expected, name)
  }
  assert.equal(paths.configSlotPath(ROOT, 'a'), `${ROOT}/config-control/config.a.json`)
  assert.equal(paths.configSlotEtagPath(ROOT, 'b'), `${ROOT}/config-control/config.b.etag`)
  assert.equal(paths.usagePolicyPath(ROOT, 'first-sync-hold'), `${ROOT}/usage-policy/first-sync-hold.json`)
  assert.equal(paths.usagePolicyPath(ROOT, 'folder-ask'), `${ROOT}/usage-policy/folder-ask.json`)
  assert.equal(paths.usagePolicyPath(ROOT, 'local-only'), `${ROOT}/usage-policy/local-only.json`)
  assert.equal(paths.usagePolicyPath(ROOT, 'client-sync'), `${ROOT}/usage-policy/client-sync.json`)
  assert.equal(paths.sinkOutboxDir(ROOT, 'central'), `${ROOT}/sinks/central/outbox`)
  assert.equal(paths.pluginStateDir(ROOT, '@hypaware/claude'), `${ROOT}/plugins/@hypaware/claude`)
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

/**
 * The segments and basenames that only `paths.js` may spell. A `path.join`
 * that names a state-root variable and one of these literals is a second
 * definition of the layout, which is what LLP 0557 phase 1 removed.
 */
const OWNED = [
  'config-control', 'usage-policy', 'product-telemetry', 'session-ignores', 'sync-check',
  'run', 'processing', 'logs', 'sinks', 'tls', 'spool', 'dev-telemetry', 'cache', 'hypaware', '.hyp', 'ask',
  'client-assets.json', 'remote-credentials.json', 'self-update.json', 'status.json', 'hypaware.pid',
  'daemon.log', 'state.json', 'seed.json', 'client-actions.json', 'hypaware-config.json',
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
