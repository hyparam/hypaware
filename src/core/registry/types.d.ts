import type {
  ActivePlugin,
  BlobStore,
  PluginActivationContext,
  PluginLogger,
  PluginPaths,
  QueryRegistry,
  QueryStorageService,
  SinkContribution,
  SinkEncoder,
  SinkHandle,
  SinkInstanceConfig,
  SinkRegistry,
  SourceRegistry,
  StartedSource,
  SourceStatus,
  TableFormatProvider,
} from '../../../collectivus-plugin-kernel-types.d.ts'

export interface InternalRegistration {
  provider: string
  name: string
  version: string
  value: unknown
}

export interface InstantiateBlobArgs {
  kind: 'blob'
  instanceName: string
  /** Sink contribution providing the destination (e.g. `local-fs`). */
  destination: SinkContribution
  /** Writer plugin name (e.g. `@hypaware/format-parquet`). */
  writerPlugin: string
  /** Encoder resolved from the writer plugin's `hypaware.encoder` capability. */
  encoder: SinkEncoder
  /** Validated instance config (with `schedule`). */
  config: SinkInstanceConfig
  /** The destination's active plugin record. */
  plugin: ActivePlugin
  /** Per-plugin paths for the destination. */
  paths: PluginPaths
  /** Per-plugin logger for the destination. */
  log: PluginLogger
}

export interface InstantiateTableFormatArgs {
  kind: 'table-format'
  instanceName: string
  /** Capability value from the writer plugin's `hypaware.table-format`. */
  tableFormat: TableFormatProvider
  /** Writer plugin name (e.g. `@hypaware/format-iceberg`). */
  writerPlugin: string
  /** Destination plugin name (e.g. `@hypaware/local-fs`). */
  destinationPlugin: string
  /** BlobStore from the destination plugin's `hypaware.blob-store`. */
  blobStore: BlobStore
  /** Inner encoder; defaults to format-parquet when no `config.encoder` pin. */
  encoder: SinkEncoder
  /** Validated instance config (with `schedule`). */
  config: SinkInstanceConfig
  /** The writer plugin's active plugin record. */
  plugin: ActivePlugin
  /** Per-plugin paths for the writer. */
  paths: PluginPaths
  /** Per-plugin logger for the writer. */
  log: PluginLogger
  /** Kernel query registry. */
  query: QueryRegistry
  /** Kernel storage service. */
  storage: QueryStorageService
}

export interface InstantiateRequestArgs {
  kind: 'request'
  instanceName: string
  /** Sink contribution for the request destination. */
  contribution: SinkContribution
  config: SinkInstanceConfig
  plugin: ActivePlugin
  paths: PluginPaths
  log: PluginLogger
}

export type InstantiateArgs = InstantiateBlobArgs | InstantiateTableFormatArgs | InstantiateRequestArgs

export type ExtendedSinkHandle = SinkHandle & {
  kind: 'blob' | 'request' | 'table-format'
  instanceName: string
  writer?: string
  destination?: string
  config: SinkInstanceConfig
  encoder?: SinkEncoder
  tableFormat?: string
}

export type ExtendedSinkRegistry = SinkRegistry & {
  instantiate(args: InstantiateArgs): Promise<ExtendedSinkHandle>
  getContribution(plugin: string, sinkName: string): SinkContribution | undefined
  listContributions(): Array<{ plugin: string; contribution: SinkContribution }>
  listHandles(): ExtendedSinkHandle[]
  closeAll(): Promise<void>
}

export type ExtendedSourceRegistry = SourceRegistry & {
  start(name: string, ctx: PluginActivationContext): Promise<StartedSource>
  stop(name: string): Promise<void>
  reload(name: string, ctx: PluginActivationContext): Promise<void>
  status(name: string): Promise<SourceStatus | undefined>
  started(name: string): StartedSource | undefined
  listStarted(): Array<{ name: string; started: StartedSource }>
  stopAll(): Promise<void>
}
