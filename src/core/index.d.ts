// Phase 0 skeleton: re-export the design types so future phases can
// `import type { ... } from '@hypaware/core'`. The canonical source of
// truth remains `collectivus-plugin-kernel-types.d.ts` at the repo root
// until the file is renamed in a later phase.

export type {
  JsonPrimitive,
  JsonValue,
  JsonObject,
  PluginName,
  CapabilityName,
  SemverRange,
  SemverVersion,
  WriteStream,
  PluginPermission,
  PluginRuntime,
} from '../../collectivus-plugin-kernel-types.d.ts'

// Iceberg partitioning declaration — core surface consumed by the cache and the
// @hypaware/format-iceberg export (LLP 0003 / LLP 0022#shared-core-helpers).
export type { CachePartitioningDeclaration, CachePartitionField } from './iceberg/types.d.ts'
