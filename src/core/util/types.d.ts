import type * as fsp from 'node:fs/promises'

/**
 * Options for {@link atomicWriteFile} and its JSON variant.
 */
export interface AtomicWriteOptions {
  /** file mode for the temp file (carried over by rename) */
  mode?: number
  /** mode for parent directories created on demand */
  dirMode?: number
  /**
   * create parent directories on demand (default `true`); pass `false`
   * when the directory is already guaranteed to exist to skip the
   * per-write `mkdir` syscall on hot paths
   */
  mkdir?: boolean
  /** fsync the temp file before the rename */
  fsync?: boolean
  /**
   * reject with `ConcurrentEditError` unless the target's mtime still
   * matches (optimistic concurrency)
   */
  expectedMtimeMs?: number
  /** promises-API override, for tests */
  fs?: typeof fsp
}
