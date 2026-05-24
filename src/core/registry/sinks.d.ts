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
} from '../../../collectivus-plugin-kernel-types.d.ts'

export function createSinkRegistry(): import('./types.d.ts').ExtendedSinkRegistry
