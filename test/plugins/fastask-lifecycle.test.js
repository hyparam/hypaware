// @ts-check

// The team graph replica's status and cleanup lifecycle (LLP 0481 T12), end
// to end in a disposable HYP_HOME: the daemon source (T8) with the real
// config resolver syncs from the loopback snapshot server (T5); the user then
// switches account or org, swaps a static token, changes the default remote,
// lets the lease run out with the daemon stopped, removes the remote, leaves
// the cloud, or the process is killed mid-download. What the cold path and
// `hyp graph replica status` say with the daemon stopped, and what the next
// daemon pass deletes, is checked after each.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { runRemoteRemove } from '../../src/core/cli/remote_commands.js'
import { writeSession, writeToken } from '../../src/core/remote/credentials.js'
import { pluginStateDir } from '../../src/core/runtime/paths.js'
import { readLocalReplica } from '../../hypaware-core/plugins-workspace/graph-cache/src/cold_replica.js'
import { runReplicaStatus } from '../../hypaware-core/plugins-workspace/graph-cache/src/commands.js'
import { createReplicaSource } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_source.js'
import { credentialFingerprint } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_sync.js'
import { replicasRoot } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_store.js'
import { createDefaultTargetResolver } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_target.js'
import { generatedGeneration, pinnedGeneration, startSnapshotServer } from '../helpers/fastask_snapshot_server.js'

/**
 * @import { TestContext } from 'node:test'
 * @import { PluginActivationContext, StartedSource } from '../../hypaware-plugin-kernel-types.js'
 */

const T0 = Date.parse('2026-10-09T16:00:00.000Z')
const LEASE_MS = 259200 * 1000

/**
 * A HYP_HOME whose config names `team` (one snapshot server) as the default
 * remote, a second remote `other`, and a fake clock shared by the daemon
 * source and the commands.
 *
 * @param {TestContext} t
 */
async function world(t) {
  const hypHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fastask-lifecycle-'))
  const team = await startSnapshotServer()
  const other = await startSnapshotServer()
  team.publish(pinnedGeneration())
  const stateRoot = path.join(hypHome, 'hypaware')
  const pluginDir = pluginStateDir(stateRoot, '@hypaware/graph-cache')
  const configPath = path.join(hypHome, 'hypaware-config.json')
  const env = { HYP_HOME: hypHome, HYP_CONFIG: configPath, HOME: hypHome }
  const clock = { now: T0 }
  /** @type {StartedSource | null} */
  let running = null

  /** @param {string} defaultRemote */
  const writeConfig = (defaultRemote) => fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: [{ name: '@hypaware/graph-cache' }],
    query: { default_remote: defaultRemote, remotes: { team: { url: team.url }, other: { url: other.url } } },
  }))
  writeConfig('team')
  const config = () => JSON.parse(fs.readFileSync(configPath, 'utf8'))

  const w = {
    hypHome, stateRoot, pluginDir, configPath, env, clock, team, other, writeConfig,
    /** An oidc login on `target` for `org`, presenting the bearer `token`. */
    login: (/** @type {string} */ target, /** @type {string} */ org, token = 'tok') =>
      writeSession(stateRoot, target, { refreshToken: `r-${org}`, accessJwt: token, expiresAt: '2099-01-01T00:00:00.000Z', org }),
    /** Starts the daemon source and waits for its first pass to finish. */
    async daemon() {
      const ctx = /** @type {PluginActivationContext} */ (/** @type {unknown} */ ({ paths: { stateDir: pluginDir }, log: { debug() {}, info() {}, warn() {}, error() {} }, env, config: {} }))
      running = await createReplicaSource({ now: () => clock.now, duty: 1 })(ctx)
      await settle(running)
      return running
    },
    async stopDaemon() {
      if (running) await running.stop()
      running = null
    },
    /** `hyp graph replica status --json` with the daemon stopped. */
    async coldStatus() {
      /** @type {string[]} */
      const out = []
      const ctx = /** @type {any} */ ({ env, config: config(), stdout: { write: (/** @type {string} */ s) => { out.push(s); return true } }, stderr: { write() { return true } } })
      assert.equal(await runReplicaStatus(['--json'], ctx, { pluginDir, now: () => clock.now }), 0)
      return JSON.parse(out.join(''))
    },
    /** What the cold path of `hyp fastask` would load for the current login. */
    async coldReplica() {
      const login = await createDefaultTargetResolver({ config: config(), env, hypStateDir: stateRoot })()
      assert.ok(login)
      return readLocalReplica(pluginDir, { target: login.target, origin: new URL(login.url).origin, org: login.org, credential: await credentialFingerprint(login) }, clock.now)
    },
    replicaDirs: () => { try { return fs.readdirSync(replicasRoot(pluginDir)).sort() } catch { return [] } },
    records: () => w.replicaDirs().map((d) => JSON.parse(fs.readFileSync(path.join(replicasRoot(pluginDir), d, 'replica.json'), 'utf8'))),
  }
  t.after(async () => {
    await w.stopDaemon()
    await team.close()
    await other.close()
    fs.rmSync(hypHome, { recursive: true, force: true })
  })
  return w
}

/** @param {StartedSource} source */
async function settle(source) {
  for (let i = 0; i < 500; i++) {
    const d = /** @type {any} */ ((await source.status?.())?.details)
    // A pass has run once its reason is no longer the initial one (a pass
    // with no login records no check at all).
    if (d && d.reason !== 'not_checked' && !d.refresh_in_progress) return d
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the daemon source did not finish a pass')
}

/** @param {StartedSource} source */
async function pass(source) {
  await source.reload?.(/** @type {any} */ ({}))
  await new Promise((resolve) => setTimeout(resolve, 20))
  return settle(source)
}

test('an org switch with the daemon stopped: the cold path refuses at once, the next pass deletes the old org\'s replica', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  await w.daemon()
  assert.equal((await w.coldReplica())?.servable, true)
  await w.stopDaemon()

  await w.login('team', 'globex')
  const cold = await w.coldReplica()
  assert.equal(cold?.servable, false, 'another org\'s replica is never served cold')
  assert.equal(cold?.reason, 'login_changed')
  const status = await w.coldStatus()
  assert.equal(status.servable, false)
  assert.match(status.summary_line, /^team graph: not used \(the login changed since the last check; the daemon re-checks it\) \(daemon not running\)$/)

  const globex = await generatedGeneration({ generation: '1760010000000-1' })
  globex.manifest.org = 'globex'
  w.team.publish(globex)
  await w.daemon()
  const records = w.records()
  assert.equal(records.length, 1, 'only the current login\'s replica remains')
  assert.equal(records[0].org, 'globex')
  assert.equal(records[0].generation, '1760010000000-1')
  assert.equal((await w.coldReplica())?.servable, true)
})

test('a static token swapped to another org is refused cold and replaced at the next pass; a same-org rotation keeps it', async (t) => {
  const w = await world(t)
  await writeToken(w.stateRoot, 'team', 'tok')
  await w.daemon()
  await w.stopDaemon()

  // Rotated within the same org: refused cold until the daemon re-confirms it.
  await writeToken(w.stateRoot, 'team', 'tok-rotated')
  w.team.state.acceptedToken = 'tok-rotated'
  assert.equal((await w.coldReplica())?.reason, 'login_changed')
  const downloads = w.team.dataRequests().length
  await w.daemon()
  assert.equal(w.team.requests.at(-1)?.ifNoneMatch, null, 'the changed credential is checked unconditionally')
  assert.equal(w.team.dataRequests().length, downloads, 'same org and generation: nothing downloaded')
  assert.equal((await w.coldReplica())?.servable, true)
  await w.stopDaemon()

  // Swapped to another org whose current generation id collides.
  const globex = await generatedGeneration({ generation: pinnedGeneration().manifest.generation, nodeCount: 4 })
  globex.manifest.org = 'globex'
  w.team.publish(globex)
  await writeToken(w.stateRoot, 'team', 'tok-globex')
  w.team.state.acceptedToken = 'tok-globex'
  assert.equal((await w.coldReplica())?.servable, false)
  await w.daemon()
  const [record] = w.records()
  assert.equal(record.org, 'globex')
  assert.deepEqual(record.rows, { nodes: 4, edges: 2 })
})

test('a default-remote change: the cold path finds nothing for the new remote, the next pass deletes the old replica', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  await w.login('other', 'acme')
  w.other.publish(await generatedGeneration({ generation: '1760020000000-1' }))
  await w.daemon()
  await w.stopDaemon()
  const before = w.replicaDirs()

  w.writeConfig('other')
  assert.equal(await w.coldReplica(), null, 'no replica of the new default yet')
  assert.match((await w.coldStatus()).summary_line, /^team graph: not downloaded yet \(daemon not running\)$/)
  assert.deepEqual(w.replicaDirs(), before, 'nothing is deleted without the daemon')

  await w.daemon()
  const records = w.records()
  assert.equal(records.length, 1)
  assert.equal(records[0].target, 'other')
  assert.equal(records[0].generation, '1760020000000-1')
})

test('the lease running out with the daemon stopped: the cold path refuses an expired replica', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  await w.daemon()
  await w.stopDaemon()
  w.clock.now = T0 + LEASE_MS - 1000
  assert.equal((await w.coldReplica())?.servable, true, 'within the lease it is served')
  w.clock.now = T0 + LEASE_MS
  const cold = await w.coldReplica()
  assert.equal(cold?.servable, false)
  assert.equal(cold?.state, 'expired')
  const status = await w.coldStatus()
  assert.equal(status.summary_line, 'team graph: expired, not used; reconnect to refresh (daemon not running)')

  // The next pass, with the server gone, deletes the expired files.
  await w.team.close()
  await w.daemon()
  assert.equal(w.records()[0].generation, null)
  assert.ok(!fs.existsSync(path.join(replicasRoot(w.pluginDir), w.replicaDirs()[0], 'generations')) ||
    fs.readdirSync(path.join(replicasRoot(w.pluginDir), w.replicaDirs()[0], 'generations')).length === 0)
})

test('hyp remote remove deletes the target\'s replica at once, and nothing brings it back', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  await w.daemon()
  await w.stopDaemon()
  assert.equal(w.replicaDirs().length, 1)
  const legacy = pluginStateDir(w.stateRoot, '@hypaware/fastask')
  fs.cpSync(w.pluginDir, legacy, { recursive: true })
  /** @type {string[]} */
  const out = []
  const ctx = /** @type {any} */ ({ env: w.env, config: JSON.parse(fs.readFileSync(w.configPath, 'utf8')), stdout: { write: (/** @type {string} */ s) => { out.push(s); return true } }, stderr: { write() { return true } } })
  assert.equal(await runRemoteRemove(['team'], ctx), 0)
  assert.match(out.join(''), /and its team graph replica/)
  assert.deepEqual(w.replicaDirs(), [])
  assert.deepEqual(fs.readdirSync(path.join(legacy, 'replicas')), [])
  await w.daemon()
  assert.deepEqual(w.replicaDirs(), [], 'no login, no replica')
})

test('hyp leave leaves the replica, its login and its sync alone (LLP 0482)', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  /** @param {string[]} argv */
  const run = async (argv) => {
    let text = ''
    const buf = { write(/** @type {string} */ s) { text += s; return true } }
    const code = await dispatch(argv, /** @type {any} */ ({ stdout: buf, stderr: buf, stdin: { isTTY: true }, env: { ...process.env, ...w.env, CLAUDE_HOME: '' } }))
    return { code, text }
  }
  const joined = await run(['join', 'https://central.example', 'policy-token-1', '--no-daemon'])
  assert.equal(joined.code, 0, joined.text)
  w.writeConfig('team')
  await w.daemon()
  const before = w.records()[0]
  await w.stopDaemon()

  const left = await run(['leave'])
  assert.equal(left.code, 0, left.text)
  assert.deepEqual(w.records()[0], before, 'the replica record is untouched')
  assert.equal((await w.coldReplica())?.servable, true, 'still served cold after leave')
  await w.daemon()
  assert.equal(w.records()[0].state, 'synced', 'and the daemon keeps syncing it')
})

test('lease renewal: an unusable new generation keeps the old lease end; the old data expires on schedule (LLP 0483)', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  const source = await w.daemon()
  const lease = w.records()[0].lease_expires_at
  w.clock.now += 3600_000
  const next = await generatedGeneration({ generation: '1760030000000-1' })
  next.manifest.schema.schema_version = 2
  w.team.publish(next)
  await pass(source)
  const [record] = w.records()
  assert.equal(record.state, 'unsupported')
  assert.equal(record.lease_expires_at, lease, 'not renewed by a generation this client cannot use')
  await w.stopDaemon()
  const status = await w.coldStatus()
  assert.match(status.summary_line, /^team graph: unsupported, upgrade hypaware; still using data as of .* until /)
  w.clock.now = Date.parse(lease)
  assert.equal((await w.coldReplica())?.state, 'expired')
})

test('a kill mid-download leaves staging that the next daemon start removes, keeping the active generation', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  await w.daemon()
  await w.stopDaemon()
  const dir = path.join(replicasRoot(w.pluginDir), w.replicaDirs()[0])
  fs.mkdirSync(path.join(dir, 'staging', 'killed'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'staging', 'killed', 'nodes.ndjson.gz'), 'partial')
  fs.mkdirSync(path.join(dir, 'generations', 'never-recorded'), { recursive: true })
  await w.daemon()
  const staging = path.join(dir, 'staging')
  assert.ok(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0, 'the abandoned download is gone')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'generations')), [pinnedGeneration().manifest.generation])
  assert.equal((await w.coldReplica())?.servable, true)
})

test('the status line, cold, in each state the lifecycle reaches', async (t) => {
  const w = await world(t)
  await w.login('team', 'acme')
  assert.match((await w.coldStatus()).summary_line, /^team graph: not downloaded yet \(daemon not running\)$/)
  await w.daemon()
  await w.stopDaemon()
  assert.match((await w.coldStatus()).summary_line, /^team graph: synced, data as of \d+ (min|h|d) ago \(acme\), \d+ (B|KB) \(daemon not running\)$/)
  const again = await w.daemon()
  w.team.state.answer = '403-snapshot_access_withdrawn'
  await pass(again)
  await w.stopDaemon()
  assert.equal((await w.coldStatus()).summary_line, 'team graph: removed, access to acme was withdrawn (daemon not running)')
})
