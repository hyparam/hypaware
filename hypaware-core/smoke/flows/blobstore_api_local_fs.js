// @ts-check

import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'

/**
 * @import { BlobStore } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * BlobStore API smoke. Activates `@hypaware/local-fs`, reaches into the
 * kernel's capability registry for the resolved `hypaware.blob-store`
 * value, and exercises every method on the contract:
 *
 *   - `putObject`  three keys with distinct payloads
 *   - `listObjects` over a prefix; assert deterministic ordering and
 *                   the set of yielded keys
 *   - `getObject`  one key; assert byte-identity vs. what we put
 *   - `deleteObject` one key; assert the next list omits it
 *   - `ifNoneMatch='*'` precondition; assert a conflicting put
 *                   rejects with the canonical error_kind
 *
 * The smoke deliberately exercises the BlobStore API DIRECTLY: no
 * sink instance is instantiated, no `driver.tick()` is fired. The
 * sink-instance code path is already exercised by
 * `blob_sink_parquet_local_fs.js`; this smoke proves the new
 * BlobStore capability value is the real surface and not the
 * deprecated metadata-only marker.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'blobstore_api_local_fs: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  // Locate the in-repo @hypaware/local-fs plugin and load+activate it.
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
  const localFsDir = path.join(repoRoot, 'hypaware-core', 'plugins-workspace', 'local-fs')

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'plugin_activate',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([localFsDir])
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
      const result = await activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
      for (const r of result.results) {
        if (!r.ok) {
          throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
        }
      }
    }
  )

  // Resolve the BlobStore through the capability registry. From V1
  // onwards the capability VALUE is the BlobStore object itself, not a
  // metadata-only `{ kind: ... }` marker.
  const blobStore = /** @type {BlobStore} */ (
    kernel.capabilities.require('blobstore_api_local_fs.smoke', 'hypaware.blob-store', '^1.0.0')
  )

  expect.that(
    'capability: hypaware.blob-store kind=local-fs',
    blobStore?.kind,
    (v) => v === 'local-fs'
  )
  expect.that(
    'capability: blob-store exports putObject',
    typeof blobStore?.putObject,
    (v) => v === 'function'
  )
  expect.that(
    'capability: blob-store exports getObject',
    typeof blobStore?.getObject,
    (v) => v === 'function'
  )
  expect.that(
    'capability: blob-store exports listObjects',
    typeof blobStore?.listObjects,
    (v) => v === 'function'
  )
  expect.that(
    'capability: blob-store exports deleteObject',
    typeof blobStore?.deleteObject,
    (v) => v === 'function'
  )

  // Three distinct payloads under a known prefix.
  const payloads = {
    'datasets/foo/p1.bin': new TextEncoder().encode('payload-1'),
    'datasets/foo/p2.bin': new TextEncoder().encode('payload-2-longer'),
    'datasets/bar/p1.bin': new TextEncoder().encode('payload-bar-1'),
  }
  for (const [key, bytes] of Object.entries(payloads)) {
    const result = await blobStore.putObject({ key, body: bytes })
    expect.that(
      `putObject: result.key matches input.key (${key})`,
      result.key,
      (v) => v === key
    )
  }

  // Listing under `datasets/foo/` should yield the two foo keys in
  // sorted order, and not the bar key.
  /** @type {Array<{ key: string, size: number }>} */
  const fooKeys = []
  for await (const entry of blobStore.listObjects({ prefix: 'datasets/foo/' })) {
    fooKeys.push({ key: entry.key, size: entry.size })
  }
  expect.that(
    'listObjects: foo prefix yields exactly the two foo keys',
    fooKeys.map((e) => e.key),
    (v) => Array.isArray(v) && v.length === 2 &&
      v[0] === 'datasets/foo/p1.bin' && v[1] === 'datasets/foo/p2.bin'
  )
  expect.that(
    'listObjects: foo prefix reports correct sizes',
    fooKeys.map((e) => e.size),
    (v) => Array.isArray(v) && v[0] === payloads['datasets/foo/p1.bin'].byteLength &&
      v[1] === payloads['datasets/foo/p2.bin'].byteLength
  )

  // Round-trip one key and check byte-identity.
  const got = await blobStore.getObject({ key: 'datasets/foo/p2.bin' })
  expect.that(
    'getObject: returns a body for existing key',
    got,
    (v) => v !== null && typeof v === 'object'
  )
  if (!got) return
  /** @type {Uint8Array[]} */
  const chunks = []
  for await (const chunk of got.body) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else chunks.push(chunk)
  }
  const collected = chunks.length === 1
    ? chunks[0]
    : Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
  expect.that(
    'getObject: byte-identical to putObject body',
    Buffer.from(collected).equals(Buffer.from(payloads['datasets/foo/p2.bin'])),
    (v) => v === true
  )
  expect.that(
    'getObject: contentLength matches payload size',
    got.contentLength,
    (v) => typeof v === 'number' && v === payloads['datasets/foo/p2.bin'].byteLength
  )

  // Delete one key and confirm the next listing reflects the removal.
  if (!blobStore.deleteObject) throw new Error('blob-store deleteObject missing')
  await blobStore.deleteObject({ key: 'datasets/foo/p1.bin' })
  const fooKeysAfter = []
  for await (const entry of blobStore.listObjects({ prefix: 'datasets/foo/' })) {
    fooKeysAfter.push(entry.key)
  }
  expect.that(
    'deleteObject: list omits the deleted key',
    fooKeysAfter,
    (v) => Array.isArray(v) && v.length === 1 && v[0] === 'datasets/foo/p2.bin'
  )

  // Precondition: a re-put with ifNoneMatch='*' to an existing key
  // must reject with the canonical error_kind, not silently overwrite.
  let preconditionErr
  try {
    await blobStore.putObject({
      key: 'datasets/foo/p2.bin',
      body: new TextEncoder().encode('overwrite'),
      ifNoneMatch: '*',
    })
  } catch (err) {
    preconditionErr = err
  }
  expect.that(
    'putObject ifNoneMatch="*": rejects with blob_precondition_failed',
    preconditionErr,
    (err) =>
      err instanceof Error &&
      /** @type {any} */ (err).errorKind === 'blob_precondition_failed'
  )

  // BlobStore base resolution: with HYP_HOME set under the smoke
  // sandbox, the plugin's default base is `<HYP_HOME>/exports/`. Confirm
  // the put landed there so the dispatcher's path-resolution contract is
  // observable from disk.
  const onDisk = await fs.readFile(
    path.join(harness.hypHome, 'exports', 'datasets', 'foo', 'p2.bin')
  )
  expect.that(
    'disk: putObject wrote under <HYP_HOME>/exports/',
    Buffer.from(onDisk).equals(Buffer.from(payloads['datasets/foo/p2.bin'])),
    (v) => v === true
  )

  await obs.shutdown()
}
