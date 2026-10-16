// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_TELEMETRY_PORT,
  resolveAttachTelemetryPort,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/source.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { writeStatusFile } from '../../src/core/daemon/status.js'

async function rig() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-port-'))
  return {
    stateRoot: path.join(root, 'hypaware'),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

/** @param {string} stateRoot @param {number} pid @param {number} listenPort */
function writeLiveStatus(stateRoot, pid, listenPort) {
  writePidFile(stateRoot, {
    pid,
    startedAt: new Date().toISOString(),
    runId: 'test-run',
    mode: 'foreground',
  })
  writeStatusFile(stateRoot, /** @type {any} */ ({
    sources: [
      { name: 'ai-gateway', plugin: '@hypaware/ai-gateway', details: { host: '127.0.0.1', port: 18521 } },
      { name: 'claude-telemetry', plugin: '@hypaware/claude', details: { listen_host: '127.0.0.1', listen_port: listenPort } },
    ],
  }))
}

test('no daemon and no config resolves the well-known default', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  const port = resolveAttachTelemetryPort({ stateRoot: r.stateRoot, config: {} })
  assert.equal(port, DEFAULT_TELEMETRY_PORT)
})

test('a configured fixed port wins over the default', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  const port = resolveAttachTelemetryPort({
    stateRoot: r.stateRoot,
    config: { telemetry: { listen_port: 5555 } },
  })
  assert.equal(port, 5555)
})

// A configured 0 asks for a dynamic port, which no attach can know until a
// daemon publishes the bound one; it must not leak into the endpoint.
test('a configured dynamic port (0) reads as unconfigured', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  const port = resolveAttachTelemetryPort({
    stateRoot: r.stateRoot,
    config: { telemetry: { listen_port: 0 } },
  })
  assert.equal(port, DEFAULT_TELEMETRY_PORT)
})

// The bind fallback moves the listener off its default when the port is
// taken; the promise that makes that safe is attach reading the bound port
// back off the source status.
// @ref LLP 0114#explicit-listen-fails-loudly [tests]: the fallback is only safe because attach reads the real bound port
test('a live daemon status wins over config and default', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  writeLiveStatus(r.stateRoot, process.pid, 6666)
  const port = resolveAttachTelemetryPort({
    stateRoot: r.stateRoot,
    config: { telemetry: { listen_port: 5555 } },
  })
  assert.equal(port, 6666)
})

// A status.json outlives its daemon; a dead pid must not hand back a port
// nobody is listening on when the config still names a real one.
test('a dead daemon status is ignored', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  // Far above any real pid ceiling on macOS/Linux, so signal 0 fails.
  writeLiveStatus(r.stateRoot, 2147483646, 6666)
  const port = resolveAttachTelemetryPort({
    stateRoot: r.stateRoot,
    config: { telemetry: { listen_port: 5555 } },
  })
  assert.equal(port, 5555)
})
