import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_GATEWAY_ENDPOINT,
  GATEWAY_ENDPOINT_ENV_VAR,
  resolveGatewayEndpoint,
} from '../src/gateway_endpoint.js'

test('resolveGatewayEndpoint: falls back to the fixed default when unset', () => {
  assert.equal(resolveGatewayEndpoint({}), DEFAULT_GATEWAY_ENDPOINT)
})

test('resolveGatewayEndpoint: falls back when the env var is blank', () => {
  assert.equal(resolveGatewayEndpoint({ [GATEWAY_ENDPOINT_ENV_VAR]: '   ' }), DEFAULT_GATEWAY_ENDPOINT)
})

test('resolveGatewayEndpoint: uses the configured value, trimmed', () => {
  const endpoint = resolveGatewayEndpoint({ [GATEWAY_ENDPOINT_ENV_VAR]: '  http://127.0.0.1:19999  ' })
  assert.equal(endpoint, 'http://127.0.0.1:19999')
})
