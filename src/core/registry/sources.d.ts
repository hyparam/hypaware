export type {
  SourceRegistry,
  SourceContribution,
  StartedSource,
  SourceStatus,
} from '../../../hypaware-plugin-kernel-types.d.ts'

export function createSourceRegistry(): import('./types.d.ts').ExtendedSourceRegistry
