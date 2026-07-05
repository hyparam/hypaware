import type * as fsp from 'node:fs/promises'

/**
 * Options for {@link atomicWriteFile} and its JSON variant.
 */
export interface AtomicWriteOptions {
  /** file mode for the temp file (carried over by rename) */
  mode?: number
  /** mode for parent directories created on demand */
  dirMode?: number
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
