// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { appendRowsToTable } from '../../src/core/cache/iceberg/store.js'

const run = promisify(execFile)

test('central exports large stored VARIANT batches under a small heap, including replay and withholding', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-forward-memory-'))
  try {
    const tools = Array.from({ length: 8 }, (_, i) => ({
      name: `tool-${i}`,
      description: '界'.repeat(4096),
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    }))
    // Small encoded data, hundreds of MB when VARIANT objects are expanded.
    // Write real row groups, not a generator that assumes the reader streams.
    await appendRowsToTable(path.join(root, 'datasets/ai_gateway_messages/source=claude'), [
      { name: 'message_id', type: 'STRING', nullable: false },
      { name: 'cwd', type: 'STRING', nullable: false },
      { name: 'tools', type: 'JSON', nullable: false },
      { name: '_hyp_ingest_seq', type: 'INT64', nullable: false },
    ], Array.from({ length: 4096 }, (_, i) => ({
      message_id: String(i),
      cwd: i % 17 === 0 || i === 4095 ? '/private' : '/shared',
      tools,
      // The first row has the highest seq. Checkpointing each HTTP chunk
      // would skip the remaining rows after the deliberate partial failure.
      _hyp_ingest_seq: BigInt(4096 - i),
    })))
    const helper = fileURLToPath(new URL('../helpers/central_forward_memory.js', import.meta.url))
    const { stdout } = await run(process.execPath, ['--expose-gc', '--max-old-space-size=128', helper, root], {
      timeout: 60_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, HYP_DEV_TELEMETRY: '1', DEV_RUN_ID: 'central-forward-memory' },
    })
    const result = JSON.parse(stdout)
    t.diagnostic(stdout.trim())
    assert.equal(result.status, 'ok')
    assert.equal(result.rows, 3854)
    assert.ok(result.peakHeap < 96 * 1024 * 1024, `live heap peaked at ${result.peakHeap}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
