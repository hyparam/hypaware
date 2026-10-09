// @ts-check

// The fastask stress run's team server (LLP 0481 T11): the loopback snapshot
// server the source tests use (test/helpers/fastask_snapshot_server.js), in
// its own process so its CPU and memory stay out of the daemon's numbers.
// Driven over IPC by stress.mjs:
//
//   { id, type: 'publish', dir, generation }   serve the generation in dir
//   { id, type: 'publish_manifest', manifest } advertise a manifest whose files are never served
//   { id, type: 'requests' }                   data-file requests so far
//
// Each message is answered with { id, ok, ... }.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startSnapshotServer } from '../../test/helpers/fastask_snapshot_server.js'
import { manifestFor } from './generate.mjs'

const PINNED_MANIFEST = fileURLToPath(new URL('../../test/fixtures/contracts/graph-snapshot/v1/manifest.json', import.meta.url))

const server = await startSnapshotServer({ token: process.env.FASTASK_STRESS_TOKEN })

process.on('message', async (input) => {
  const msg = /** @type {any} */ (input)
  try {
    if (msg.type === 'publish') {
      const manifest = await manifestFor(msg.dir, msg.generation, PINNED_MANIFEST)
      const previous = server.state.current
      server.publish({
        manifest,
        files: {
          nodes: fs.readFileSync(path.join(msg.dir, 'nodes.ndjson.gz')),
          edges: fs.readFileSync(path.join(msg.dir, 'edges.ndjson.gz')),
        },
      })
      // Only the current generation stays in memory.
      if (previous && previous !== msg.generation) server.retire(previous)
      process.send?.({ id: msg.id, ok: true, manifest })
    } else if (msg.type === 'publish_manifest') {
      server.publish({ manifest: msg.manifest, files: { nodes: Buffer.alloc(0), edges: Buffer.alloc(0) } })
      process.send?.({ id: msg.id, ok: true })
    } else if (msg.type === 'requests') {
      process.send?.({ id: msg.id, ok: true, data: server.dataRequests().length })
    }
  } catch (err) {
    process.send?.({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

process.send?.({ type: 'ready', url: server.url })
process.on('disconnect', () => { void server.close().then(() => process.exit(0)) })
