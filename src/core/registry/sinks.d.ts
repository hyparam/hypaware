import type { SinkInstanceConfig } from '../../../hypaware-plugin-kernel-types.d.ts'

export type {
  SinkRegistry,
  SinkContribution,
  SinkCreateContext,
  SinkEncoder,
  SinkEncodeContext,
  SinkEncodedBlob,
  SinkHandle,
  Sink,
  ExportBatch,
  ExportOptions,
  ExportResult,
  SinkQueryReader,
} from '../../../hypaware-plugin-kernel-types.d.ts'

export function createSinkRegistry(): import('./types.d.ts').ExtendedSinkRegistry

/**
 * The instance name the registry keyed `handle` under, out of the kernel's
 * own record rather than off the handle, whose `instanceName` the owning
 * plugin is free to replace. A handle this module did not build is read the
 * way it always was, guarded: an unreadable or non-string name answers `''`.
 */
export function sinkInstanceName(handle: import('./types.d.ts').ExtendedSinkHandle): string

/**
 * The instance config the registry materialized `handle` from, out of the
 * kernel's own record rather than off the handle, whose `config` the owning
 * plugin is free to replace. A handle this module did not build is read the
 * way it always was, guarded: an unreadable or non-object config answers an
 * empty config.
 */
export function sinkInstanceConfig(handle: import('./types.d.ts').ExtendedSinkHandle): SinkInstanceConfig
