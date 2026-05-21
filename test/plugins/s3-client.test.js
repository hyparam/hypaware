// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { detectCredentialSourceKind } from '../../hypaware-core/plugins-workspace/s3/src/client.js'

test('detectCredentialSourceKind prefers explicit profile', () => {
  assert.equal(
    detectCredentialSourceKind({
      profile: 'staging',
      env: { AWS_ACCESS_KEY_ID: 'AKIA-FAKE', AWS_SECRET_ACCESS_KEY: 'secret' },
    }),
    'profile'
  )
})

test('detectCredentialSourceKind falls through to env vars when no profile is set', () => {
  assert.equal(
    detectCredentialSourceKind({
      env: { AWS_ACCESS_KEY_ID: 'AKIA-FAKE', AWS_SECRET_ACCESS_KEY: 'secret' },
    }),
    'env'
  )
})

test('detectCredentialSourceKind detects web identity (EKS IRSA)', () => {
  assert.equal(
    detectCredentialSourceKind({
      env: { AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/eks.amazonaws.com/serviceaccount/token' },
    }),
    'web_identity'
  )
})

test('detectCredentialSourceKind detects SSO', () => {
  assert.equal(
    detectCredentialSourceKind({
      env: { AWS_SSO_START_URL: 'https://my-org.awsapps.com/start' },
    }),
    'sso'
  )
})

test('detectCredentialSourceKind detects credential_process', () => {
  assert.equal(
    detectCredentialSourceKind({
      env: { AWS_CREDENTIAL_PROCESS: '/usr/local/bin/aws-creds' },
    }),
    'process'
  )
})

test('detectCredentialSourceKind falls back to metadata when nothing else matches', () => {
  assert.equal(detectCredentialSourceKind({ env: {} }), 'metadata')
})

test('detectCredentialSourceKind never returns the credential material itself', () => {
  // Defensive: even though the function takes env values, the return is
  // a fixed-vocabulary token. This test pins the contract so a future
  // refactor cannot accidentally return the raw AWS_ACCESS_KEY_ID.
  const result = detectCredentialSourceKind({
    env: { AWS_ACCESS_KEY_ID: 'AKIA-SHOULD-NEVER-LEAK', AWS_SECRET_ACCESS_KEY: 'top-secret' },
  })
  assert.equal(typeof result, 'string')
  assert.ok(
    ['profile', 'env', 'web_identity', 'sso', 'process', 'metadata', 'injected'].includes(result),
    `unexpected credential_source_kind: ${result}`
  )
  assert.equal(result.includes('AKIA'), false)
  assert.equal(result.includes('secret'), false)
})

test('detectCredentialSourceKind ignores empty-string AWS_ACCESS_KEY_ID', () => {
  // A real-world misconfiguration: env var is exported but empty. The
  // SDK treats that as no creds; our detector should not classify it
  // as `env`.
  assert.equal(
    detectCredentialSourceKind({
      env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
    }),
    'metadata'
  )
})
