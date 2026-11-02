/**
 * Shared shapes for the `@hypaware/goose` adapter. The reader, projector
 * and watermark shapes arrive with their tasks (LLP 0571 T3, T4).
 */

/** `GooseSessionsDbError.code`, also the `error_kind` the source reports (LLP 0570#status). */
export type GooseSessionsDbErrorCode =
  | 'sqlite_unavailable'
  | 'missing'
  | 'permission_denied'
  | 'open_failed'
  | 'sqlite_busy'
  | 'schema_unsupported'
