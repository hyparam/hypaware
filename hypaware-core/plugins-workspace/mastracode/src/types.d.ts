/**
 * Shared shapes for the `@hypaware/mastracode` adapter.
 */

/** `MastraDbError.code`, also the `error_kind` the source reports (LLP 0586#status). */
export type MastraDbErrorCode =
  | 'sqlite_unavailable'
  | 'sqlite_unsupported'
  | 'missing'
  | 'permission_denied'
  | 'open_failed'
  | 'sqlite_busy'
  | 'schema_unsupported'
  | 'remote_store_unsupported'

/**
 * Where the source reads Mastra Code from (LLP 0586#config): a local
 * `mastra.db` path, or a remote store named by `MASTRA_DB_URL`, which is not
 * read.
 */
export type MastraDbLocation =
  | { kind: 'local', path: string }
  | { kind: 'remote' }
