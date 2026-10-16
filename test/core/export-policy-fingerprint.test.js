// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createSourceWithholdResolver } from '../../src/core/cache/source-withhold.js'
import { localOnlyListPath, writeLocalOnlyEntries } from '../../src/core/usage-policy/local_only.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/matcher.js'

/** @param {import('node:test').TestContext} t @returns {string} */
function makeStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-policy-fp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('usage-policy fingerprint tracks the machine-local list content, not history', async (t) => {
  const stateDir = makeStateDir(t)
  const listPath = localOnlyListPath(stateDir)
  const resolver = createUsagePolicyResolver({ localOnlyListPath: listPath })

  const absent = resolver.fingerprint?.()
  assert.equal(absent, 'absent')

  await writeLocalOnlyEntries({ stateDir, entries: [{ dir: '/work/private', class: 'local-only' }] })
  const marked = resolver.fingerprint?.()
  assert.ok(marked && marked !== 'absent')
  assert.doesNotMatch(/** @type {string} */ (marked), /private/, 'no directory path leaves the store')
  assert.equal(resolver.fingerprint?.(), marked, 'stable across calls with no change')

  await writeLocalOnlyEntries({ stateDir, entries: [] })
  const cleared = resolver.fingerprint?.()
  assert.notEqual(cleared, marked, 'unmarking changes the digest')

  assert.equal(createUsagePolicyResolver({}).fingerprint?.(), 'no-list')
})

test('source-withhold fingerprint tracks the live opted-out set', () => {
  /** @type {Set<string>} */
  const withheld = new Set()
  const resolver = createSourceWithholdResolver({
    withheldSourceIds: () => withheld,
    datasetAttributionColumns: new Map([['ai_gateway_messages', 'client_name']]),
  })
  const before = resolver.fingerprint?.()
  withheld.add('codex')
  withheld.add('claude')
  const after = resolver.fingerprint?.()
  assert.notEqual(after, before)
  assert.equal(after, 'claude,codex', 'sorted, so set-iteration order cannot fake a change')
})

test('exportPolicyFingerprint composes both resolver halves and is constant without them', async (t) => {
  const stateDir = makeStateDir(t)
  const cacheRoot = path.join(stateDir, 'cache')
  /** @type {Set<string>} */
  const withheld = new Set()
  const storage = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir) }),
    sourceWithholdResolver: createSourceWithholdResolver({
      withheldSourceIds: () => withheld,
      datasetAttributionColumns: new Map(),
    }),
  })
  const initial = storage.exportPolicyFingerprint?.()
  assert.ok(typeof initial === 'string' && initial.startsWith('v1 '))

  withheld.add('codex')
  const optedOut = storage.exportPolicyFingerprint?.()
  assert.notEqual(optedOut, initial, 'a client opt-out changes the digest')

  await writeLocalOnlyEntries({ stateDir, entries: [{ dir: '/work/private', class: 'local-only' }] })
  const marked = storage.exportPolicyFingerprint?.()
  assert.notEqual(marked, optedOut, 'a local-only marking changes the digest')
  assert.equal(storage.exportPolicyFingerprint?.(), marked, 'no change reads as no change')

  const bare = createQueryStorageService({ cacheRoot })
  assert.equal(bare.exportPolicyFingerprint?.(), 'v1 usage:none source:none')
})

test('a policy change the fingerprint reports is one the verdicts already apply', async (t) => {
  // The digest exists so a consumer can derive durable state from the export
  // seam's verdicts (LLP 0367). That is only sound if the two describe the
  // same policy: reporting a change while the seam still answers from the
  // policy it replaced lets the consumer stamp the new fingerprint over
  // pre-change verdicts (hyparam/hypaware#1317).
  const stateDir = makeStateDir(t)
  const dir = path.join(stateDir, 'work')
  fs.mkdirSync(dir, { recursive: true })
  // A frozen clock, so nothing here rides on the memo TTL elapsing: this is
  // the window in which a long-lived daemon resolver holds a warm verdict.
  const resolver = createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir), now: () => 1_000 })

  assert.equal(resolver.resolve(dir).class, 'full', 'warm, as ongoing capture in that directory leaves it')
  const before = resolver.fingerprint?.()

  await writeLocalOnlyEntries({ stateDir, entries: [{ dir, class: 'local-only' }] })
  const after = resolver.fingerprint?.()

  assert.notEqual(after, before, 'the marking changes the digest')
  assert.equal(resolver.resolve(dir).class, 'local-only', 'and the verdict the seam serves changed with it')
})
