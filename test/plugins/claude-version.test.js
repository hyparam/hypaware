// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLAUDE_OTEL_MIN_VERSION,
  compareClaudeVersions,
  detectClaudeCodeVersion,
  isBelowClaudeVersion,
  parseClaudeVersion,
  resolveClaudeCodeVersion,
} from '../../hypaware-core/plugins-workspace/claude/src/claude_version.js'

test('parseClaudeVersion pulls the numeric triple out of the CLI banner', () => {
  assert.equal(parseClaudeVersion('2.1.233 (Claude Code)'), '2.1.233')
  assert.equal(parseClaudeVersion('Claude Code v2.1.193\n'), '2.1.193')
  assert.equal(parseClaudeVersion('no version here'), undefined)
  assert.equal(parseClaudeVersion(undefined), undefined)
  assert.equal(parseClaudeVersion(42), undefined)
})

// The trap the numeric compare exists for: lexically '2.1.193' < '2.1.9',
// which would refuse exactly the releases that clear the floor.
test('compareClaudeVersions is numeric, not lexical', () => {
  assert.ok(compareClaudeVersions('2.1.193', '2.1.9') > 0)
  assert.ok(compareClaudeVersions('2.1.9', '2.1.193') < 0)
  assert.equal(compareClaudeVersions('2.1.193', '2.1.193'), 0)
  assert.ok(compareClaudeVersions('3.0.0', '2.99.99') > 0)
})

// @ref LLP 0258#version-floor [tests]: *older than* the floor refuses; nothing else does
test('isBelowClaudeVersion: only a version proven older than the floor is below', () => {
  assert.equal(isBelowClaudeVersion('2.1.192'), true)
  assert.equal(isBelowClaudeVersion(CLAUDE_OTEL_MIN_VERSION), false)
  assert.equal(isBelowClaudeVersion('2.1.233'), false)
  // Unknown is not old.
  assert.equal(isBelowClaudeVersion(undefined), false)
  assert.equal(isBelowClaudeVersion('not-a-version'), false)
})

test('detectClaudeCodeVersion parses the probe output and never throws', async () => {
  const detected = await detectClaudeCodeVersion({
    exec: /** @type {any} */ (async () => ({ stdout: '2.1.233 (Claude Code)' })),
  })
  assert.equal(detected, '2.1.233')

  const missing = await detectClaudeCodeVersion({
    exec: /** @type {any} */ (async () => {
      throw new Error('ENOENT')
    }),
  })
  assert.equal(missing, undefined)
})

test('resolveClaudeCodeVersion: the env override wins without probing', async () => {
  let probed = false
  const version = await resolveClaudeCodeVersion(
    { HYP_CLAUDE_CODE_VERSION: '2.1.200' },
    {
      exec: /** @type {any} */ (async () => {
        probed = true
        return { stdout: '9.9.9' }
      }),
    }
  )
  assert.equal(version, '2.1.200')
  assert.equal(probed, false)
})

test('resolveClaudeCodeVersion: an unparseable override falls back to the probe', async () => {
  const version = await resolveClaudeCodeVersion(
    { HYP_CLAUDE_CODE_VERSION: 'whatever' },
    { exec: /** @type {any} */ (async () => ({ stdout: '2.1.233' })) }
  )
  assert.equal(version, '2.1.233')
})
