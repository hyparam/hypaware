// @ts-check

/**
 * Detach empties the raw-body spool the attach marker recorded.
 *
 * The undo is plugin-agnostic, so it learns the directory from the marker
 * rather than computing it - which makes the path settings-file input, and the
 * containment gate part of the behavior under test rather than an
 * implementation detail.
 *
 * @ref LLP 0253#purge-and-detach-sweep [tests]: detach removes the spool
 *   directory's contents
 * @ref LLP 0258#marker-and-spool [tests]: the recorded path is what the undo
 *   uses
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { MODE_OTEL, attach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { claudeBodySpoolDir } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'

/** @import { ClientDescriptor } from '../../src/core/types.js' */

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/** A temp home carrying an `otel`-mode attach and a spool with bodies in it. */
async function rig() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-spool-'))
  const hypHome = path.join(root, '.hyp')
  const settingsPath = path.join(root, '.claude', 'settings.json')
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
  const spoolDir = claudeBodySpoolDir(hypHome)

  return {
    root,
    hypHome,
    settingsPath,
    spoolDir,
    env: { HOME: root, HYP_HOME: hypHome },
    /** @param {string} [dir] */
    async stageBodies(dir = spoolDir) {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(path.join(dir, 'req-1.json'), '{"messages":["a raw prompt"]}')
      await fsp.writeFile(path.join(dir, 'resp-1.json'), '{"content":["a raw reply"]}')
    },
    /** @param {{ spoolDir?: string }} [extra] */
    attachOtel(extra = {}) {
      return attach({
        port: 18521,
        version: '2.0.0',
        stateFile: path.join(root, 'session-context.jsonl'),
        settingsPath,
        mode: MODE_OTEL,
        telemetryPort: 4319,
        spoolDir,
        claudeVersion: '2.1.233',
        ...extra,
      })
    },
    detach() {
      return detachClientFromDisk({
        descriptor: CLAUDE_DESCRIPTOR,
        homeDir: root,
        env: /** @type {any} */ ({ HOME: root, HYP_HOME: hypHome }),
      })
    },
    /** @returns {Promise<Record<string, any>>} */
    async readSettings() {
      return JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

test('detach empties the spool the marker recorded and keeps the directory', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  await r.attachOtel()
  await r.stageBodies()
  assert.equal((await fsp.readdir(r.spoolDir)).length, 2)

  const result = await r.detach()
  assert.equal(result.changed, true)
  assert.equal(result.warning, undefined)
  assert.deepEqual(await fsp.readdir(r.spoolDir), [])
})

test('detach leaves a spool the marker names outside the HypAware home alone, and says so', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  const foreign = path.join(r.root, 'not-a-spool')
  await r.attachOtel()
  // The marker is in the user's own settings file: a hand edit can repoint it,
  // and the undo must not become a delete primitive because of that.
  const settings = await r.readSettings()
  settings._hypaware.spool_dir = foreign
  await fsp.writeFile(r.settingsPath, JSON.stringify(settings, null, 2) + '\n')
  await r.stageBodies(foreign)

  const result = await r.detach()
  assert.equal(result.changed, true)
  assert.match(String(result.warning), /body spool outside/)
  assert.equal((await fsp.readdir(foreign)).length, 2)
})

test('a proxy-mode marker records no spool, so detach sweeps nothing', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  // Bodies from a previous otel attach are still on disk, but this marker does
  // not name them, and the undo never guesses a path.
  await r.stageBodies()
  await fsp.mkdir(r.hypHome, { recursive: true })
  await fsp.writeFile(path.join(r.hypHome, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n')
  await attach({
    port: 18521,
    version: '2.0.0',
    stateFile: path.join(r.root, 'session-context.jsonl'),
    settingsPath: r.settingsPath,
    mode: 'proxy',
    caCertPath: path.join(r.hypHome, 'ca.pem'),
  })

  const result = await r.detach()
  assert.equal(result.changed, true)
  assert.equal((await fsp.readdir(r.spoolDir)).length, 2)
})

test('a marker whose undo record was damaged still sweeps its spool', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  await r.attachOtel()
  await r.stageBodies()
  // The `managed` record is what a hand edit (or corruption) loses first; the
  // top-level `mode` and `spool_dir` survive it, and so must the sweep.
  const settings = await r.readSettings()
  delete settings._hypaware.managed
  await fsp.writeFile(r.settingsPath, JSON.stringify(settings, null, 2) + '\n')

  const result = await r.detach()
  assert.equal(result.changed, true)
  assert.deepEqual(await fsp.readdir(r.spoolDir), [])
})
