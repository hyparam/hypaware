// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { ensureLocalCa } from '../../src/core/tls/ca.js'
import { derToPem } from '../../src/core/tls/x509.js'

/** @import { CollectStatusOptions, HypAwareStatusReport } from '../../src/core/daemon/types.js' */

// Proxy-mode capture rests on two things nothing else in `hyp status` can be
// read for: the login keychain still trusting the CA on disk, and
// `NODE_USE_SYSTEM_CA` being live in the launchd environment. A CA re-mint
// strands the first silently, so both must be stated, not inferred.
// @ref LLP 0237#consequences [tests]:
// @ref LLP 0239#terminals-predating-attach [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-proxy-trust-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @param {{ platform?: NodeJS.Platform, trusted?: boolean, launchdEnvSet?: boolean, probesThrow?: boolean }} [over]
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome, over = {}) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: over.platform ?? 'darwin',
    isLaunchAgentInstalled: () => false,
    isSystemdUnitInstalled: () => false,
    isCaTrusted: async () => {
      if (over.probesThrow) throw new Error('security: command not found')
      return over.trusted ?? true
    },
    isLaunchdEnvSet: async () => {
      if (over.probesThrow) throw new Error('launchctl: command not found')
      return over.launchdEnvSet ?? true
    },
  }
}

/** @returns {{ write(chunk: string): void, text(): string }} */
function buffer() {
  /** @type {string[]} */
  const chunks = []
  return { write: (chunk) => { chunks.push(chunk) }, text: () => chunks.join('') }
}

/**
 * @param {HypAwareStatusReport} report
 * @param {string} cacheRoot
 */
function renderText(report, cacheRoot) {
  const stdout = buffer()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot, stdout })
  return stdout.text()
}

test('hyp status reports the trust state alongside the CA fingerprint, and the launchd env', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    const ca = await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.deepEqual(report.proxyTrust, {
      caFingerprint: ca.fingerprint,
      hosts: ['api.anthropic.com'],
      trusted: true,
      launchdEnvSet: true,
    })

    const text = renderText(report, path.join(stateRoot, 'cache'))
    assert.match(text, /proxy trust:/)
    assert.ok(text.includes(`ca fingerprint: ${ca.fingerprint}`), 'the fingerprint is on the text surface')
    assert.match(text, /login keychain: trusted\n/)
    assert.match(text, /launchd env: {4}NODE_USE_SYSTEM_CA=1 set\n/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.deepEqual(json.proxy_trust, {
      ca_fingerprint: ca.fingerprint,
      permitted_hosts: ['api.anthropic.com'],
      ca_trusted: true,
      launchd_env_set: true,
    })
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The grant is wider than the install: the CA permits every provider host the
// product can ever intercept, so a user capturing Claude alone still carries
// one covering the OpenAI hosts. The attach dialog names them once; after that
// this is the only surface that can, and LLP 0238 requires it to.
test('every permitted host the trust grant covers is named on both surfaces', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    // The full static provider set of LLP 0238#full-provider-constraints, on
    // an install that captures only the first of them.
    const hosts = ['api.anthropic.com', 'api.openai.com', 'chatgpt.com']
    const ca = await ensureLocalCa({ stateRoot, hosts })

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.deepEqual(report.proxyTrust?.hosts, hosts)

    const text = renderText(report, path.join(stateRoot, 'cache'))
    for (const host of hosts) {
      assert.ok(text.includes(host), `${host} is named on the text surface`)
    }
    assert.match(text, /permitted: {6}api\.anthropic\.com, api\.openai\.com, chatgpt\.com\n/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.deepEqual(json.proxy_trust?.permitted_hosts, hosts)
    // The hosts are read back off the certificate, not from config, so the
    // line can never drift from what the keychain actually vouches for.
    assert.deepEqual(json.proxy_trust?.ca_fingerprint, ca.fingerprint)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The permitted hosts are the one field of this report that is bytes off disk
// rather than a string we wrote: a `dNSName` is an IA5String, read out of
// whatever certificate sits at the CA path and decoded as latin1 with no
// charset check anywhere on the way. Our own mint refuses a non-printable host
// (`assertAsciiHost`), so the only way to one is a foreign or damaged
// certificate at that path - which is exactly the case the "not host-limited"
// arm of the renderer exists for. It must not be able to repaint the terminal
// of the person reading `hyp status`.
// @ref LLP 0225#decision [tests]: a status label carrying captured bytes is sanitized before it is rendered
test('a permitted host carrying terminal control bytes cannot repaint hyp status', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    // Minted with a filler of the payload's exact width, then byte-patched in
    // the DER: same length keeps every ASN.1 length valid, and nothing on the
    // read path verifies the signature the patch invalidates. This is the only
    // way to produce the certificate, since the mint refuses the host outright.
    const hostile = 'evil\u001b[2K\nforged.example'
    const filler = 'z'.repeat(hostile.length)
    await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com', filler] })

    const certPath = path.join(stateRoot, 'tls', 'ca-cert.pem')
    const der = Buffer.from(new crypto.X509Certificate(await fs.readFile(certPath, 'utf8')).raw)
    const at = der.indexOf(Buffer.from(filler, 'latin1'))
    assert.ok(at >= 0, 'the filler host is in the DER to patch')
    Buffer.from(hostile, 'latin1').copy(der, at)
    await fs.writeFile(certPath, derToPem(der))

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    // Stripped, not dropped: the subtree is still part of the grant, so it is
    // still named, just without the bytes that drive a terminal.
    assert.deepEqual(report.proxyTrust?.hosts, ['api.anthropic.com', 'evil[2Kforged.example'])

    const text = renderText(report, path.join(stateRoot, 'cache'))
    assert.ok(!text.includes('\u001b'), 'no escape sequence reaches the text surface')
    assert.match(text, /permitted: {6}api\.anthropic\.com, evil\[2Kforged\.example\n/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    // Sanitized at collection, so `--json` carries exactly what was printed.
    assert.deepEqual(json.proxy_trust?.permitted_hosts, ['api.anthropic.com', 'evil[2Kforged.example'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The state this exists for: the dialog was cancelled, or a re-mint stranded
// the trust. Capture keeps working, so nothing else in the report degrades and
// only this line can say so.
test('a CA the keychain does not trust is stated, with the repair, on both surfaces', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    const ca = await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })

    const report = await collectHypAwareStatus(
      collectOpts(hypHome, { trusted: false, launchdEnvSet: false })
    )
    assert.equal(report.proxyTrust?.trusted, false)
    assert.equal(report.proxyTrust?.launchdEnvSet, false)

    const text = renderText(report, path.join(stateRoot, 'cache'))
    assert.ok(text.includes(`ca fingerprint: ${ca.fingerprint}`))
    assert.match(text, /login keychain: not trusted - .*hyp attach claude/)
    assert.match(text, /launchd env: {4}NODE_USE_SYSTEM_CA not set - .*hyp attach claude/)
    // The report is still healthy: capture works without keychain trust
    // (LLP 0237#attach-anyway-on-refusal), which is exactly why the line has
    // to exist.
    assert.equal(report.overall, 'healthy')

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.equal(json.proxy_trust?.ca_trusted, false)
    assert.equal(json.proxy_trust?.launchd_env_set, false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// `--json` is a machine copy, so a probe that could not run must not be
// rounded to `false`: "the dialog was cancelled" and "`security` did not run"
// are different answers and only the first is actionable.
test('a probe that could not run reports unknown, never a false negative', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })

    const report = await collectHypAwareStatus(collectOpts(hypHome, { probesThrow: true }))
    assert.equal(report.proxyTrust?.trusted, null)
    assert.equal(report.proxyTrust?.launchdEnvSet, null)

    const text = renderText(report, path.join(stateRoot, 'cache'))
    assert.match(text, /login keychain: unknown - the keychain probe could not run\n/)
    assert.match(text, /launchd env: {4}unknown - the launchctl probe could not run\n/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.equal(json.proxy_trust?.ca_trusted, null)
    assert.equal(json.proxy_trust?.launchd_env_set, null)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Both mechanisms are macOS facts (LLP 0237#darwin-only). A Linux host has no
// keychain and no launchd, so the honest surface is no section at all - not a
// row of unknowns the user could not act on.
test('a non-darwin host reports no section rather than an unknown one', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })

    const report = await collectHypAwareStatus(collectOpts(hypHome, { platform: 'linux' }))
    assert.equal(report.proxyTrust, null)

    const text = renderText(report, path.join(stateRoot, 'cache'))
    assert.doesNotMatch(text, /proxy trust/)
    assert.doesNotMatch(text, /keychain/)
    assert.doesNotMatch(text, /unknown/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.equal(json.proxy_trust, null)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// An install that never turned proxy mode on has no CA, so there is nothing
// to be trusted or untrusted. The V1 text surface stays unchanged.
test('a darwin host with no CA on disk keeps the surface unchanged', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(report.proxyTrust, null)

    const text = renderText(report, path.join(stateRoot, 'cache'))
    assert.doesNotMatch(text, /proxy trust/)

    const json = renderStatusJson({
      report,
      clientNames: [],
      datasets: [],
      cacheRoot: path.join(stateRoot, 'cache'),
    })
    assert.equal(json.proxy_trust, null)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The probes shell out. `hyp status` on a machine with no CA must not spawn
// `security` or `launchctl` at all, and no status path may spawn them under
// the test runner (LLP 0181's guard rejects that spawn, which is what the
// unknown-state test above exercises).
test('the probes are not run when there is no CA to ask about', async () => {
  const { hypHome } = await makeHome()
  try {
    let calls = 0
    const report = await collectHypAwareStatus({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      platform: 'darwin',
      isLaunchAgentInstalled: () => false,
      isCaTrusted: async () => { calls += 1; return true },
      isLaunchdEnvSet: async () => { calls += 1; return true },
    })
    assert.equal(report.proxyTrust, null)
    assert.equal(calls, 0)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
