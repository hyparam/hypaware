// Public type and value surface for `hypaware/core` (and the `.` entry).
// This is the curated declaration the `exports` map points at. Re-exporting
// here is the sanctioned exception to the no-re-export rule because this is a
// public package entry (see `./integration`). The canonical source of truth
// for the design types remains `hypaware-plugin-kernel-types.d.ts` at the
// repo root.

// Runtime value exports (mirror src/core/index.js).
export * from './observability/index.js'
export {
  createConfigRegistry,
  defaultConfigPath,
  loadConfigFile,
  parseConfigShape,
  CONFIG_BASENAME,
} from './config/schema.js'
export {
  validateConfig,
  firstPartyPluginMetadata,
  mergeInstalledManifestsIntoKnown,
  isCronExpression,
  CAP_ENCODER,
  CAP_BLOB_STORE,
  CAP_HTTP_ENDPOINT,
} from './config/validate.js'
export { buildPluginCatalog } from './plugin_catalog.js'
export {
  partitionSpecForDeclaration,
  validatePartitionSpecStability,
} from './iceberg/partition-spec.js'

// Design types consumed across the public API.
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
  PluginActivationContext,
  BlobStore,
  QueryRegistry,
  QueryStorageService,
  QueryPartition,
  DatasetRegistration,
  DatasetDataSourceContext,
  DatasetSchema,
  ColumnSpec,
} from '../../hypaware-plugin-kernel-types.d.ts'

// Iceberg partitioning declaration - core surface consumed by the cache and the
// @hypaware/format-iceberg export (LLP 0003 / LLP 0022#shared-core-helpers).
export type { CachePartitioningDeclaration, CachePartitionField } from './iceberg/types.d.ts'
