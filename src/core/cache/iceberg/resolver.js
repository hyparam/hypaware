// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { Writer } from 'hyparquet-writer/src/types.js'
 * @import { Lister, Resolver, WriterOptions } from 'icebird/src/types.js'
 * @import { AbortableWriter } from '../../../../src/core/cache/types.js'
 */

/**
 * Build a Resolver/Lister pair that drives `icebird` against the local
 * filesystem. The kernel's intrinsic cache lives under
 * `<HYP_HOME>/hypaware/cache`; this is the only IO surface the cache
 * uses to read and write Iceberg tables.
 *
 * @returns {Promise<{ resolver: Resolver, lister: Lister }>}
 */
export async function createLocalIcebergIO() {
  const { ByteWriter } = await import('hyparquet-writer')
  return {
    resolver: {
      reader(url) {
        const bytes = fs.readFileSync(urlToPath(url))
        return asyncBufferFromBytes(bytes)
      },
      writer(url, options) {
        return localWriter(ByteWriter, urlToPath(url), options)
      },
      async deleter(url) {
        fs.rmSync(urlToPath(url), { force: true })
      },
    },
    async lister(url) {
      const dir = urlToPath(url)
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort()
      } catch {
        return []
      }
    },
  }
}

/**
 * Convert a filesystem directory into the `file://` URL that
 * `icebird` uses as a table identifier.
 *
 * @param {string} dir
 * @returns {string}
 */
export function tableUrlForDir(dir) {
  return pathToFileURL(dir).href.replace(/\/$/, '')
}

/**
 * Inverse of `tableUrlForDir` - resolves a `file://` URL or a relative
 * path back into an absolute filesystem path.
 *
 * @param {string} url
 * @returns {string}
 */
export function urlToPath(url) {
  if (url.startsWith('file://')) return fileURLToPath(url)
  return path.resolve(url)
}

/**
 * The name {@link localWriter} stages a write under before it publishes:
 * `<final name>.tmp.<pid>.<epoch ms>.<random>`. Unique per attempt, so two
 * writers racing the same destination never share a staging file.
 *
 * @param {string} filePath
 * @returns {string}
 */
function stagedNameFor(filePath) {
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Anchored to the end because the staged name is a SUFFIX on the final one,
 * so `v3.metadata.json.tmp.1.2.ab` is staged and `v3.metadata.json` is not.
 * The random tail is base-36 and can come out short, or empty when
 * `Math.random()` returns a value with no fractional digits to spare, so it
 * is `*` and not `+`.
 */
const STAGED_NAME_RE = /\.tmp\.\d+\.\d+\.[a-z0-9]*$/

/**
 * Is `name` a staged write {@link localWriter} left behind?
 *
 * A crash between staging and publish, or between the publishing `link` and
 * the `rm` that drops the staged name, leaves one of these in the table
 * directory. Nothing reads it, but nothing reclaims it either unless a sweep
 * can recognize it, which is why the maintenance sweep imports this instead
 * of carrying its own copy of the pattern.
 *
 * @ref LLP 0316#staged-writes-are-reclaimed [implements]: the writer that mints the name owns the pattern that recognizes it.
 * @param {string} name  a basename, or a full path
 * @returns {boolean}
 */
export function isStagedWriteName(name) {
  return STAGED_NAME_RE.test(name)
}

/**
 * @param {Uint8Array} bytes
 * @returns {AsyncBuffer}
 */
function asyncBufferFromBytes(bytes) {
  return {
    byteLength: bytes.byteLength,
    slice(start, end) {
      const sliced = bytes.subarray(start, end)
      const out = new ArrayBuffer(sliced.byteLength)
      new Uint8Array(out).set(sliced)
      return out
    },
  }
}

/**
 * Build a `hyparquet-writer` Writer that publishes onto the local
 * filesystem in one syscall. `ifNoneMatch === '*'` is honored to surface
 * `412` collisions on concurrent commits, matching the conditional-write
 * semantics `icebird`'s file catalog expects.
 *
 * The writer implements the optional `flush()` hook, which
 * `hyparquet-writer` calls after every row group: buffered bytes are
 * appended to the temp file and the in-memory buffer index resets to
 * zero. Without it a data file is fully materialized in memory before it
 * lands, which caps how large a file a streaming writer may build. With
 * it, peak buffer is one row group regardless of final file size.
 * `ByteWriter.offset` stays the cumulative byte count, so every parquet
 * offset recorded in the footer remains file-absolute.
 *
 * It also implements `abort()`, which `finish()` is not: a streaming
 * append may hold this writer open across many row groups, and if the
 * append fails part-way there is no `finish()` coming to close the
 * descriptor or unlink the temp file. Without it a repeatedly failing
 * compaction leaks one fd and one `.tmp.*` file per attempt.
 *
 * And it implements `park()`: flush, give the descriptor back, and drop
 * the auto-expanding buffer to nothing, while keeping the temp file and
 * the byte offset so a later write reopens it in append mode. A parked
 * writer costs a directory entry and a few small objects, not a
 * descriptor and not a row group's worth of buffer, which is what lets a
 * streaming append keep one output file per partition tuple open across
 * a whole rewrite without one descriptor per tuple.
 *
 * @ref LLP 0209#row-groups [implements]: flush-per-row-group is what keeps
 *   a large output file from becoming a large allocation.
 * @ref LLP 0209#descriptor-parking [implements]: the descriptor is
 *   reclaimable; the open file is not the thing being capped.
 * @param {new (initialSize?: number) => Writer} ByteWriter
 * @param {string} filePath
 * @param {WriterOptions | undefined} options
 * @returns {AbortableWriter}
 */
function localWriter(ByteWriter, filePath, options) {
  /** @type {AbortableWriter & { index?: number, buffer?: ArrayBuffer, view?: DataView }} */
  const writer = new ByteWriter()
  /** @type {number | null} */
  let fd = null
  /** @type {string | null} */
  let tmp = null

  const openTmp = () => {
    if (fd !== null) return
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    if (tmp === null) {
      tmp = stagedNameFor(filePath)
      fd = fs.openSync(tmp, 'w')
      return
    }
    // Reopening a parked writer: append, never truncate. Every parquet
    // offset already recorded in the footer is file-absolute, so the
    // bytes have to continue exactly where the park left them.
    fd = fs.openSync(tmp, 'a')
  }

  /** @param {string} label */
  const collision = (label) => {
    const err = /** @type {Error & { status?: number, statusCode?: number }} */ (
      new Error(`local iceberg write collision: ${label}`)
    )
    err.status = 412
    err.statusCode = 412
    return err
  }

  writer.abort = function () {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed; the temp file still needs to go.
      }
      fd = null
    }
    if (tmp !== null) {
      fs.rmSync(tmp, { force: true })
      tmp = null
    }
    writer.index = 0
  }

  writer.flush = function () {
    if (!writer.index) return
    openTmp()
    fs.writeSync(/** @type {number} */ (fd), writer.getBytes())
    writer.index = 0
  }

  writer.park = function () {
    if (fd === null && !writer.index) return
    writer.flush?.()
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed: the temp file and the offset are what matter.
      }
      fd = null
    }
    // `ByteWriter`'s buffer auto-expands to the largest row group it ever
    // held and never shrinks, so a parked writer would otherwise retain
    // that allocation for the rest of the rewrite - once per open file,
    // which is the term that would make holding many files open costly.
    // `index` is zero after the flush, so nothing live is discarded.
    writer.buffer = new ArrayBuffer(1024)
    writer.view = new DataView(writer.buffer)
    writer.index = 0
  }

  // @ref LLP 0316#link-is-the-commit-point [implements]: the create-only publish is one `link`, and that call is the whole of the cache's concurrency control.
  writer.finish = async function () {
    openTmp()
    if (writer.index) fs.writeSync(/** @type {number} */ (fd), writer.getBytes())
    fs.closeSync(/** @type {number} */ (fd))
    fd = null
    writer.index = 0
    const staged = /** @type {string} */ (tmp)
    if (options?.ifNoneMatch !== '*') {
      fs.renameSync(staged, filePath)
      tmp = null
      return
    }
    // `ifNoneMatch: '*'` is a create-only precondition, so the publish
    // itself has to be the thing that refuses to overwrite. `rename`
    // cannot be: POSIX rename replaces the destination silently, so an
    // `existsSync` in front of it is check-then-act and two committers
    // racing the same `v(N+1).metadata.json` can both find it absent,
    // both publish, and the loser's snapshot is lost with no error for
    // the retry loop to catch. `link` fails with EEXIST when the
    // destination exists, atomically and with no window, which is
    // exactly the guarantee the precondition promises. The cache has no
    // external catalog to arbitrate for it, so this one call is the whole
    // of its concurrency control.
    try {
      fs.linkSync(staged, filePath)
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code
      // The link did not land, so the staged name is dead weight. Reclaiming
      // it is best-effort for the same reason it is on the success path: an
      // `rmSync` that throws here would replace the reason the publish
      // failed, and an `EEXIST` that reaches `commitWithRetry` as anything
      // other than a 412 is rethrown rather than reloaded, turning the
      // retryable race this call exists to expose back into a hard failure.
      try {
        fs.rmSync(staged, { force: true })
      } catch {
        // The publish already failed; a leftover temp name is the lesser
        // problem, and clearing `tmp` stops `abort()` retrying the same rm.
      }
      tmp = null
      if (code === 'EEXIST') throw collision(filePath)
      // `staged` is a sibling of `filePath`, so this can never be EXDEV.
      // What it can be is a filesystem with no hard links at all (FAT and
      // exFAT volumes, and some FUSE or cloud-sync mounts), which answers
      // every `link` with EPERM/ENOSYS/ENOTSUP. libuv has no name for POSIX
      // `EOPNOTSUPP`, so that spelling never reaches JS on the platforms
      // Node maps - `util.getSystemErrorMap()` carries `ENOTSUP` and not
      // `EOPNOTSUPP` - and it stays listed only for a runtime that passes it
      // through. Any of them wedges every conditional commit, and a bare
      // errno does not say why, so name the cause. Falling back to a
      // check-then-act `rename` is not on the table: that is the defect this
      // call exists to remove. Supporting such a filesystem would mean
      // publishing through `open(filePath, 'wx')` instead, trading atomic
      // content for atomic creation, which is the trade the `local-fs` blob
      // store makes.
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
        const unsupported = /** @type {Error & { code?: string }} */ (
          new Error(
            `local iceberg conditional commit needs hard links: link() failed with ${code} on ` +
              `${filePath}. The cache directory must be on a filesystem that supports link(2).`,
            { cause: err }
          )
        )
        unsupported.code = code
        throw unsupported
      }
      throw err
    }
    // The link is the commit point: the file is published, and `staged` is
    // now just a second name for the same inode that nothing reads.
    // Dropping that name is cleanup, so a failure here must not be reported
    // as a failed commit - the caller would be told its snapshot did not
    // land when it did, and `commitWithRetry` does not retry a non-412.
    // The leftover is unreadable rather than free: `v<N>.metadata.json.tmp.*`
    // matches neither icebird's anchored version regex nor any path the
    // table's own metadata carries, so nothing resolves it - but
    // `measureMetadataDir` sizes the WHOLE metadata directory, so its bytes
    // are counted by the metadata figure `hyp query status` reports and by
    // the epoch layout's metadata-size compaction trigger. The
    // unreferenced-file sweep recognizes the staged suffix
    // ({@link isStagedWriteName}) and reclaims it once it is past the orphan
    // grace window.
    try {
      fs.rmSync(staged, { force: true })
    } catch {
      // Already published; the temp name is the only thing left behind.
    }
    tmp = null
  }
  return writer
}
