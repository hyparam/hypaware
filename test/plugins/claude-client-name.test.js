// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  claudeClientName,
  claudeClientVersion,
} from '../../hypaware-core/plugins-workspace/claude/src/anthropic.js'

test('claudeClientName stamps claude-desktop off the Desktop User-Agent', () => {
  assert.equal(claudeClientName({ 'user-agent': 'Claude-Desktop/1.2581.0' }), 'claude-desktop')
  assert.equal(claudeClientName({ 'user-agent': 'claude-desktop/9' }), 'claude-desktop')
})

test('claudeClientName falls back for CLI and generic SDK traffic', () => {
  assert.equal(claudeClientName({ 'user-agent': 'claude-cli/1.0.83' }), 'claude')
  assert.equal(claudeClientName({ 'user-agent': 'anthropic-sdk-python/0.1' }), 'claude')
  assert.equal(claudeClientName(undefined), 'claude')
  assert.equal(claudeClientName({}, 'claude'), 'claude')
})

test('claudeClientName honors a non-default fallback', () => {
  assert.equal(claudeClientName({ 'user-agent': 'curl/8' }, 'claude'), 'claude')
})

test('claudeClientVersion extracts both CLI and Desktop versions', () => {
  assert.equal(claudeClientVersion({ 'user-agent': 'claude-cli/1.0.83 (external)' }), '1.0.83')
  assert.equal(claudeClientVersion({ 'user-agent': 'Claude-Desktop/1.2581.0' }), '1.2581.0')
  assert.equal(claudeClientVersion({ 'user-agent': 'curl/8.0' }), undefined)
  assert.equal(claudeClientVersion(undefined), undefined)
})
