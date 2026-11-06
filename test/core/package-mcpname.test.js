// @ts-check

import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

// The MCP Registry checks a server entry's npm package against the published
// package's `mcpName` (the Phase 2 distribution design, LLP 0499 #mcpname).
// Dropping or changing the line fails nothing here at runtime; the registry
// refuses the next publish, long after the edit.
test('package.json names the MCP Registry entry', () => {
  assert.equal(pkg.mcpName, 'ai.hypaware/hypaware')
})
