/**
 * Construct the table URL the table-format sink hands to `icebird` for
 * a given dataset prefix. The URL embeds the BlobStore key prefix so
 * `pathToKey` can split it back out without keeping a separate table.
 *
 * Example: `tableUrlForBlobPrefix('iceberg/datasets/foo')` →
 *   `blob://iceberg/datasets/foo`
 *
 * @param {string} blobPrefix
 * @returns {string}
 */
export function tableUrlForBlobPrefix(blobPrefix: string): string;
/**
 * Inverse of `tableUrlForBlobPrefix`: take whatever absolute path
 * `icebird` synthesized (table URL + suffix) and project it onto a
 * BlobStore key. Accepts both the full `blob://...` URL form and bare
 * relative paths (the latter never appears in practice but keeps the
 * adapter defensive).
 *
 * @param {string} url
 * @returns {string}
 */
export function pathToKey(url: string): string;
/**
 * Adapt a `BlobStore` into the `Resolver` / `Lister` pair `icebird`
 * speaks. The adapter lets the table-format sink write metadata + data
 * files through any blob destination (local-fs in V1, S3 next) without
 * forking icebird IO per backend.
 *
 * Behavior:
 * - `reader(url)` issues `getObject`, materializes the body, and returns
 *   an `AsyncBuffer` over the bytes. Missing objects throw with
 *   `iceberg_metadata_read_failed` and `code='ENOENT'` so icebird's
 *   metadata-discovery probes can fall through.
 * - `writer(url, options)` collects bytes into a fresh `ByteWriter`
 *   (the same in-memory writer the local-fs resolver uses) and flushes
 *   via `putObject` on `finish()`. When `options.ifNoneMatch === '*'`
 *   the writer surfaces a 412 on collision so icebird's
 *   `fileCatalogCommit` retry path triggers.
 * - `deleter(url)` issues `deleteObject` and tolerates ENOENT-style
 *   misses silently.
 * - `lister(url)` walks `listObjects` for the directory prefix and
 *   returns the *basenames* (icebird wants bare filenames, not paths).
 *
 * The optional `onWrite` observer is invoked after every successful
 * metadata/data write. The caller uses it to stash S3-specific telemetry
 * (e.g. the ETag of the most recent metadata commit) without coupling
 * the icebird writer surface to the sink's span attributes.
 *
 * @param {BlobStore} blobStore
 * @param {{ onWrite?: BlobIOWriteObserver }} [options]
 * @returns {Promise<{
 *   resolver: Resolver,
 *   lister: Lister
 * }>}
 */
export function createBlobStoreIO(blobStore: BlobStore, options?: {
    onWrite?: BlobIOWriteObserver;
}): Promise<{
    resolver: Resolver;
    lister: Lister;
}>;
/**
 * Drain a `GetObjectResult.body` (Uint8Array or Node stream) into a
 * single contiguous `Uint8Array`. Tolerant of both shapes because the
 * BlobStore contract returns a Node stream from `getObject`, but tests
 * sometimes hand back raw bytes.
 *
 * @param {NodeJS.ReadableStream | Uint8Array | undefined} body
 * @returns {Promise<Uint8Array>}
 */
export function collectStream(body: NodeJS.ReadableStream | Uint8Array | undefined): Promise<Uint8Array>;
import type { BlobStore } from '../../../../collectivus-plugin-kernel-types.d.ts';
import type { BlobIOWriteObserver } from './types.d.ts';
import type { Resolver } from 'icebird/src/types.js';
import type { Lister } from 'icebird/src/types.js';
