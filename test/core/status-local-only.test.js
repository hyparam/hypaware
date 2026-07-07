// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { localOnlyListPath, writeLocalOnlyDirs } from '../../src/core/usage-policy/local_only.js'

// T8 - `hyp status` never-silent withholding surface (LLP 0069 R9, LLP 0080
// #status). `collectHypAwareStatus` reads the machine-local local-only list
// best-effort; the text/JSON renderers surface the count so an "enrolled but
// withholding" host is never a silent state.
// @ref LLP 0069#requirements [tests]: R9

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-local-only-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

test('no local-only list yet: count is 0 and the text/JSON surfaces stay quiet', async () => {
  const hypHome = await makeHome()

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.deepEqual(report.usagePolicy, { localOnlyDirCount: 0 })
  assert.ok(!report.diagnostics.some((d) => d.kind === 'local_only_list_unreadable'))

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.deepEqual(json.usage_policy, { local_only_dir_count: 0 })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.doesNotMatch(stdout.text(), /local-only:/)
})

test('an empty (but present) list also hides the line', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  await writeLocalOnlyDirs({ stateDir: stateRoot, dirs: [] })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.deepEqual(report.usagePolicy, { localOnlyDirCount: 0 })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.doesNotMatch(stdout.text(), /local-only:/)
})

test('N > 0 renders the withholding line in text and the count in JSON', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  await writeLocalOnlyDirs({
    stateDir: stateRoot,
    dirs: [path.join(stateRoot, 'side-project'), path.join(stateRoot, 'clients', 'acme')],
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.deepEqual(report.usagePolicy, { localOnlyDirCount: 2 })
  assert.equal(report.overall, 'healthy')

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.deepEqual(json.usage_policy, { local_only_dir_count: 2 })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.match(
    stdout.text(),
    /local-only:\s+withholding 2 directories from forwarding \(recorded locally\)/
  )
})

test('a corrupt local-only list surfaces a diagnostic and a null usagePolicy, never a silent 0', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const listPath = localOnlyListPath(stateRoot)
  await fs.mkdir(path.dirname(listPath), { recursive: true })
  await fs.writeFile(listPath, '{ not valid json', 'utf8')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.usagePolicy, null)
  assert.equal(report.overall, 'degraded', 'an uninterpretable privacy signal degrades overall, loudly')

  const diag = report.diagnostics.find((d) => d.kind === 'local_only_list_unreadable')
  assert.ok(diag, 'a diagnostic names the unreadable list')
  assert.equal(diag?.severity, 'error')
  assert.ok(diag?.message.includes(listPath))

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.equal(json.usage_policy, null)
  assert.ok(
    /** @type {any[]} */ (json.diagnostics).some((d) => d.kind === 'local_only_list_unreadable'),
    'the JSON diagnostics array carries the same finding'
  )

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()
  assert.doesNotMatch(text, /local-only:\s+withholding/, 'never renders a count it does not trust')
  assert.match(text, /local_only_list_unreadable/)
})
