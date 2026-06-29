// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { redactRemoteUserinfo } from '../../hypaware-core/plugins-workspace/codex/src/git-remote.js'

// @ref LLP 0032#remote-redaction: strip credentials from a remote at ingress.

test('strips user:token userinfo from an https remote', () => {
  assert.equal(
    redactRemoteUserinfo('https://x-access-token:ghp_SECRET@github.com/acme/repo.git'),
    'https://github.com/acme/repo.git',
  )
})

test('strips a token-only userinfo from an https remote', () => {
  assert.equal(
    redactRemoteUserinfo('https://ghp_SECRET@github.com/acme/repo.git'),
    'https://github.com/acme/repo.git',
  )
})

test('strips userinfo from an ssh:// URL (key-auth, but harmless to drop)', () => {
  assert.equal(
    redactRemoteUserinfo('ssh://git@github.com/acme/repo.git'),
    'ssh://github.com/acme/repo.git',
  )
})

test('leaves the scp-like SSH form intact (git@ is the conventional user, no secret)', () => {
  assert.equal(
    redactRemoteUserinfo('git@github.com:acme/repo.git'),
    'git@github.com:acme/repo.git',
  )
})

test('leaves a credential-free https remote unchanged', () => {
  assert.equal(
    redactRemoteUserinfo('https://github.com/acme/repo.git'),
    'https://github.com/acme/repo.git',
  )
})

test('passes undefined / empty through unchanged', () => {
  assert.equal(redactRemoteUserinfo(undefined), undefined)
  assert.equal(redactRemoteUserinfo(''), '')
})

test('does not mistake an @ in the path for userinfo', () => {
  // No userinfo before the first path slash → nothing is stripped.
  assert.equal(
    redactRemoteUserinfo('https://github.com/acme/repo@v2.git'),
    'https://github.com/acme/repo@v2.git',
  )
})
