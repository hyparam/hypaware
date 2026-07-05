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
