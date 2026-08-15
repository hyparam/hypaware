// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MODE_BASE_URL, MODE_PROXY, attach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { caPaths, ensureLocalCa } from '../../src/core/tls/ca.js'

const PORT = 18521

/**
 * A temp home with a settings file and a real local CA.
 *
 * @param {Record<string, unknown>} [settings]
 */
async function rig(settings) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-proxy-attach-'))
  const settingsPath = path.join(root, '.claude', 'settings.json')
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
  if (settings) await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')

  const stateRoot = path.join(root, '.hyp', 'hypaware')
  const ca = await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })

  return {
    root,
    stateRoot,
    settingsPath,
    ca,
    stateFile: path.join(root, 'session-context.jsonl'),
    /** @returns {Promise<Record<string, any>>} */
    async read() {
      return JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
    },
    /** The env a core detach resolves the CA and the settings file from. */
    env: { HOME: root, HYP_HOME: path.join(root, '.hyp') },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

/** @param {{ settingsPath: string, stateFile: string, ca: { certPath: string } }} r */
function proxyAttach(r, extra = {}) {
  return attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_PROXY,
    caCertPath: r.ca.certPath,
    ...extra,
  })
}

/** The claude descriptor, as the core undo receives it. */
const CLAUDE_DESCRIPTOR = {
  name: 'claude',
  plugin: '@hypaware/claude',
  attachProbe: {
    format: 'json',
    settings_file: '.claude/settings.json',
    marker_key: '_hypaware',
  },
}

// The reason the whole change exists: Remote Control refuses to run unless the
// base URL is api.anthropic.com, so proxy mode must not write one.
// @ref LLP 0232#attach-writes-https_proxy-not-a-base-url [tests]
test('proxy attach sets HTTPS_PROXY and leaves the base URL alone', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const value = await r.read()

  assert.equal(value.env.HTTPS_PROXY, `http://127.0.0.1:${PORT}`)
  assert.equal(value.env.NODE_EXTRA_CA_CERTS, r.ca.certPath)
  assert.equal(Object.hasOwn(value.env, 'ANTHROPIC_BASE_URL'), false)
  assert.equal(value._hypaware.mode, 'proxy')
})

// Both keys exist only to undo defaults Claude Code flips behind a
// non-first-party base URL. Proxy mode is genuinely first party, so setting
// them would be claiming something that is no longer true.
test('proxy attach writes neither first-party override key', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const value = await r.read()

  assert.equal(Object.hasOwn(value.env, 'ENABLE_TOOL_SEARCH'), false)
  assert.equal(Object.hasOwn(value.env, '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'), false)
})

test('proxy attach still installs the managed session hooks', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const value = await r.read()

  // The cwd attribution and folder-classification hooks ride the same settings
  // file write, so changing the transport must not cost them.
  const events = Object.keys(value.hooks).sort()
  assert.deepEqual(events, ['CwdChanged', 'PostToolUse', 'SessionStart', 'UserPromptSubmit'])
  assert.match(JSON.stringify(value.hooks), /claude-hook session-context/)
  assert.match(JSON.stringify(value.hooks), /claude-hook classify-cwd/)
})

test('proxy attach refuses without a CA on disk', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await fsp.rm(caPaths(r.stateRoot).certPath)
  await assert.rejects(
    () => proxyAttach(r),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'CA_MISSING')
      assert.match(String(/** @type {any} */ (err).message), /start the daemon with proxy mode/)
      return true
    }
  )
  // Nothing was written: a refused preflight must not half-attach.
  const value = await r.read()
  assert.deepEqual(value, {})
})

test('proxy attach requires an absolute CA path', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await assert.rejects(
    () => proxyAttach(r, { caCertPath: 'relative/ca.pem' }),
    /must be an absolute path/
  )
})

// A pre-existing HTTPS_PROXY is far more likely to be corporate egress than a
// leftover, so it is backed up and the user is told how to keep it working.
// @ref LLP 0044#conflict-back-up--override-restore-on-leave [tests]
test('an existing HTTPS_PROXY is backed up, reported, and restored on detach', async (t) => {
  const r = await rig({ env: { HTTPS_PROXY: 'http://proxy.corp:8080' } })
  t.after(() => r.cleanup())

  const result = await proxyAttach(r)
  assert.equal(result.changed, true)
  assert.equal(result.prevValue, 'http://proxy.corp:8080')
  assert.match(String(result.warnings?.join(' ')), /upstream_proxy/)

  const attached = await r.read()
  assert.equal(attached.env.HTTPS_PROXY, `http://127.0.0.1:${PORT}`)
  assert.equal(attached._hypaware.prev_env.HTTPS_PROXY, 'http://proxy.corp:8080')

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })
  const detached = await r.read()
  assert.equal(detached.env.HTTPS_PROXY, 'http://proxy.corp:8080')
  assert.equal(Object.hasOwn(detached.env, 'NODE_EXTRA_CA_CERTS'), false)
  assert.equal(Object.hasOwn(detached, '_hypaware'), false)
})

test('detach removes both managed keys when there was nothing to restore', async (t) => {
  const r = await rig({ env: { ANTHROPIC_API_KEY: 'sk-user-key' } })
  t.after(() => r.cleanup())

  await proxyAttach(r)
  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  const value = await r.read()
  assert.deepEqual(value.env, { ANTHROPIC_API_KEY: 'sk-user-key' })
  assert.equal(Object.hasOwn(value, 'hooks'), false)
})

// A trusted signing key must not outlive the attach that installed it.
// @ref LLP 0235#detach-removes-the-ca [tests]
// Routine detach must NOT delete the CA: its keychain trust is a
// once-per-machine grant, and deleting the CA strands it. What detach does
// release is the launchd environment variable, which re-attach can restore
// silently.
// @ref LLP 0238#ca-survives-detach [tests]
// @ref LLP 0239#launchctl-setenv [tests]
test('detach keeps the CA and releases the launchd environment', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  await fsp.stat(caPaths(r.stateRoot).keyPath)

  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
    platform: 'darwin',
    runCommand: async (cmd, args) => {
      calls.push({ cmd, args })
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  await fsp.stat(caPaths(r.stateRoot).keyPath)
  await fsp.stat(caPaths(r.stateRoot).certPath)
  assert.deepEqual(calls, [{ cmd: 'launchctl', args: ['unsetenv', 'NODE_USE_SYSTEM_CA'] }])
})

// The launchd release is Darwin-only machinery; any other platform's detach
// must not shell out at all.
// @ref LLP 0237#darwin-only [tests]
test('a non-darwin detach never touches launchctl', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)

  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
    platform: 'linux',
    runCommand: async (cmd, args) => {
      calls.push({ cmd, args })
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  assert.deepEqual(calls, [])
  await fsp.stat(caPaths(r.stateRoot).keyPath)
})

test('a base-URL detach leaves the CA alone', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })
  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  // Nothing about a base-URL attach installed a CA, so nothing about its
  // reversal may remove one another client could be relying on.
  await fsp.stat(caPaths(r.stateRoot).keyPath)
})

// Migrating an already-attached machine must not strand the old mode's keys.
// @ref LLP 0232#mode-migration [tests]
test('switching from base-URL to proxy mode releases the old keys', async (t) => {
  const r = await rig({ env: { ANTHROPIC_BASE_URL: 'https://gw.corp.example' } })
  t.after(() => r.cleanup())

  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })
  const baseUrlAttached = await r.read()
  assert.equal(baseUrlAttached.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${PORT}`)
  assert.equal(baseUrlAttached.env.ENABLE_TOOL_SEARCH, 'true')

  await proxyAttach(r)
  const value = await r.read()

  // The user's own base URL came back rather than being left pointed at us.
  assert.equal(value.env.ANTHROPIC_BASE_URL, 'https://gw.corp.example')
  assert.equal(Object.hasOwn(value.env, 'ENABLE_TOOL_SEARCH'), false)
  assert.equal(Object.hasOwn(value.env, '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'), false)
  assert.equal(value.env.HTTPS_PROXY, `http://127.0.0.1:${PORT}`)
  assert.equal(value._hypaware.mode, 'proxy')
})

test('switching back to base-URL mode releases the proxy keys', async (t) => {
  const r = await rig({ env: { HTTPS_PROXY: 'http://proxy.corp:8080' } })
  t.after(() => r.cleanup())

  await proxyAttach(r)
  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })

  const value = await r.read()
  assert.equal(value.env.HTTPS_PROXY, 'http://proxy.corp:8080')
  assert.equal(Object.hasOwn(value.env, 'NODE_EXTRA_CA_CERTS'), false)
  assert.equal(value.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${PORT}`)
})

test('a re-attach keeps the original backup rather than backing up our own value', async (t) => {
  const r = await rig({ env: { HTTPS_PROXY: 'http://proxy.corp:8080' } })
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const second = await proxyAttach(r)

  const value = await r.read()
  assert.equal(value._hypaware.prev_env.HTTPS_PROXY, 'http://proxy.corp:8080')
  // Nothing new was displaced this run, so nothing new is warned about.
  assert.equal(second.changed && second.warnings, undefined)
})

test('a user value the detach did not write is left in place and reported', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const value = await r.read()
  value.env.HTTPS_PROXY = 'http://someone-else:3128'
  await fsp.writeFile(r.settingsPath, JSON.stringify(value, null, 2) + '\n')

  const result = await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  const after = await r.read()
  assert.equal(after.env.HTTPS_PROXY, 'http://someone-else:3128')
  assert.match(String(result.warning), /HTTPS_PROXY was overridden externally/)
})

// A proxy marker never claims ANTHROPIC_BASE_URL, so a following base-URL
// attach is the FIRST to take that key over and must back up the user's value.
// Reading "a prior marker exists" as "we already own this key" destroyed it.
// @ref LLP 0232#mode-migration [tests]
test('base-URL attach over a proxy marker still backs up the user base URL', async (t) => {
  const r = await rig({ env: { ANTHROPIC_BASE_URL: 'https://corp.example' } })
  t.after(() => r.cleanup())

  await proxyAttach(r)
  // Proxy mode leaves it alone.
  assert.equal((await r.read()).env.ANTHROPIC_BASE_URL, 'https://corp.example')

  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })
  const attached = await r.read()
  assert.equal(attached.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${PORT}`)
  assert.equal(attached._hypaware.prev_base_url, 'https://corp.example')

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })
  assert.equal((await r.read()).env.ANTHROPIC_BASE_URL, 'https://corp.example')
})

test('a base -> proxy -> base round trip preserves the user base URL', async (t) => {
  const r = await rig({ env: { ANTHROPIC_BASE_URL: 'https://corp.example' } })
  t.after(() => r.cleanup())

  const baseAttach = () => attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })

  await baseAttach()
  await proxyAttach(r)
  await baseAttach()
  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  assert.equal((await r.read()).env.ANTHROPIC_BASE_URL, 'https://corp.example')
})

// A hand-edit between two attaches is the user's value, not ours to overwrite
// without a backup. Detach already compares before reversing; attach must agree.
// @ref LLP 0044#conflict-back-up--override-restore-on-leave [tests]
test('a hand-edited HTTPS_PROXY between attaches is backed up, not swallowed', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const edited = await r.read()
  edited.env.HTTPS_PROXY = 'http://corp.proxy:8080'
  await fsp.writeFile(r.settingsPath, JSON.stringify(edited, null, 2) + '\n')

  const second = await proxyAttach(r)
  assert.equal(second.changed && second.prevValue, 'http://corp.proxy:8080')

  const value = await r.read()
  assert.equal(value._hypaware.prev_env.HTTPS_PROXY, 'http://corp.proxy:8080')

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })
  assert.equal((await r.read()).env.HTTPS_PROXY, 'http://corp.proxy:8080')
})

// The undo is routinely pointed at a sandbox home. Resolving the settings file
// from homeDir but the CA from the ambient home deletes another install's key.
// @ref LLP 0235#detach-removes-the-ca [tests]
// The launchd plist detach removes is resolved from `homeDir`, never the
// ambient home: this undo is routinely pointed at a sandbox, and unlinking
// another install's LaunchAgent would silently break its Remote Control.
test('detach removes the launchd plist under homeDir, not the ambient one', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())
  await proxyAttach(r)

  const plistRel = path.join('Library', 'LaunchAgents', 'com.hyperparam.hypaware.node-system-ca.plist')
  const sandboxPlist = path.join(r.root, plistRel)
  await fsp.mkdir(path.dirname(sandboxPlist), { recursive: true })
  await fsp.writeFile(sandboxPlist, '<plist/>\n')

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: {},
    platform: 'darwin',
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  })

  await assert.rejects(fsp.stat(sandboxPlist), /ENOENT/)
  // And the CA under that home survives regardless.
  await fsp.stat(caPaths(r.stateRoot).keyPath)
})

// A marker whose undo record was damaged still has to reverse the proxy keys.
// Leaving HTTPS_PROXY pointing at a gateway that is no longer attached breaks
// every HTTPS request the client makes, not merely its capture.
// @ref LLP 0232#detach-restores-any-managed-key [tests]
test('a damaged proxy marker still reverses HTTPS_PROXY', async (t) => {
  const r = await rig({ env: { HTTPS_PROXY: 'http://proxy.corp:8080' } })
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const value = await r.read()
  // Damage the record the undo would normally replay, keeping the backup.
  delete value._hypaware.managed
  await fsp.writeFile(r.settingsPath, JSON.stringify(value, null, 2) + '\n')

  const result = await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  const after = await r.read()
  assert.equal(after.env.HTTPS_PROXY, 'http://proxy.corp:8080')
  assert.equal(Object.hasOwn(after, '_hypaware'), false)
  assert.match(String(result.warning), /no readable undo record/)
})

test('a damaged proxy marker leaves an externally changed proxy alone', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  const value = await r.read()
  delete value._hypaware.managed
  value.env.HTTPS_PROXY = 'http://someone-else:3128'
  await fsp.writeFile(r.settingsPath, JSON.stringify(value, null, 2) + '\n')

  const result = await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  assert.equal((await r.read()).env.HTTPS_PROXY, 'http://someone-else:3128')
  assert.match(String(result.warning), /HTTPS_PROXY was overridden externally/)
})

// The trust pointer and the signing key have to come off together. This branch
// already reverses `HTTPS_PROXY` by convention, so leaving the CA behind here
// would strand trusted key material on exactly the path where the user has the
// least evidence anything was missed.
// @ref LLP 0235#detach-removes-the-ca [tests]
test('a damaged proxy marker still deletes the CA', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await proxyAttach(r)
  await fsp.stat(caPaths(r.stateRoot).keyPath)

  const value = await r.read()
  delete value._hypaware.managed
  await fsp.writeFile(r.settingsPath, JSON.stringify(value, null, 2) + '\n')

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  await assert.rejects(fsp.stat(caPaths(r.stateRoot).keyPath), /ENOENT/)
  await assert.rejects(fsp.stat(caPaths(r.stateRoot).certPath), /ENOENT/)
})

// Same branch, same homeDir rule as the record-driven one: a sandboxed undo
// must not reach into the ambient home for the key it deletes.
// @ref LLP 0235#detach-removes-the-ca [tests]
test('a damaged proxy marker deletes the CA under homeDir, not the ambient one', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())
  await proxyAttach(r)

  const decoyHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-decoy-damaged-'))
  t.after(() => fsp.rm(decoyHome, { recursive: true, force: true }))
  const decoyRoot = path.join(decoyHome, '.hyp', 'hypaware')
  await ensureLocalCa({ stateRoot: decoyRoot, hosts: ['api.anthropic.com'] })

  const value = await r.read()
  delete value._hypaware.managed
  await fsp.writeFile(r.settingsPath, JSON.stringify(value, null, 2) + '\n')

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: {},
  })

  await assert.rejects(fsp.stat(caPaths(r.stateRoot).keyPath), /ENOENT/)
  await fsp.stat(caPaths(decoyRoot).keyPath)
})

// A damaged *base-URL* marker must not delete a CA: nothing it wrote installed
// one, and another client may still be attached in proxy mode.
test('a damaged base-URL marker leaves the CA alone', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })
  const value = await r.read()
  delete value._hypaware.managed
  await fsp.writeFile(r.settingsPath, JSON.stringify(value, null, 2) + '\n')

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  await fsp.stat(caPaths(r.stateRoot).keyPath)
})

// A corporate `HTTPS_PROXY` routinely carries `user:pass@`. Attach reports what
// it displaced and detach reports what it gave back, and both reports reach a
// terminal, a `--json` payload and (for the warning) a log record a sink may
// ship off the machine. The backup on the marker must stay verbatim, because it
// is the only copy the restore has.
test('a credential-bearing HTTPS_PROXY is redacted in every report but restored intact', async (t) => {
  const secret = 'http://alice:s3cr3t@proxy.corp:8080'
  const r = await rig({ env: { HTTPS_PROXY: secret } })
  t.after(() => r.cleanup())

  const result = await proxyAttach(r)
  assert.equal(result.changed, true)

  // What the user is shown, and what a scripted caller reads out of
  // `prev_value`.
  assert.equal(result.prevValue, 'http://***@proxy.corp:8080')
  const warned = String(result.warnings?.join(' '))
  assert.equal(warned.includes('s3cr3t'), false, 'the warning must not carry the password')
  assert.equal(warned.includes('alice'), false, 'nor the username')
  assert.match(warned, /proxy\.corp:8080/, 'but must still name the proxy that was displaced')

  // The backup is the restore's only copy, so it stays exactly as it was.
  const attached = await r.read()
  assert.equal(attached._hypaware.prev_env.HTTPS_PROXY, secret)

  const detached = await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })
  // The reversal is unaffected: the user's own proxy comes back byte for byte.
  assert.equal((await r.read()).env.HTTPS_PROXY, secret)
  // The detach report is not.
  assert.equal(detached.restoredValue, 'http://***@proxy.corp:8080')
})
