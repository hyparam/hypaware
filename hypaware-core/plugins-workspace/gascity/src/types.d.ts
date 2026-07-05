import type { ExtendedSourceRegistry } from '../../../../src/core/registry/types.d.ts'
import type { PluginActivationContext, PluginLogger } from '../../../../collectivus-plugin-kernel-types.d.ts'

export interface GascityFrame {
  city: string
  provider_session_id: string
  event_kind: string
  event_time: string
  template?: string
  content_text?: string
  metadata?: Record<string, unknown>
}

export interface GascityCitySubscription {
  close(): Promise<void>
}

/**
 * The transport surface a fixture must implement. `subscribe` is called
 * once per attached city; the supervisor pumps frames into the supplied
 * `onFrame` callback.
 */
export interface GascityTransport {
  subscribe(opts: {
    city: string
    apiUrl?: string
    onFrame(frame: GascityFrame): Promise<void> | void
    signal: AbortSignal
  }): Promise<GascityCitySubscription>
}

export interface CityConfig {
  name: string
  api_url?: string
}

export interface GascityRuntime {
  /** Activation context shared across attach/reload. */
  ctx: PluginActivationContext
  /** Kernel source registry. */
  sources: ExtendedSourceRegistry
  /** Plugin logger pinned to `@hypaware/gascity`. */
  log: PluginLogger
  /** Whether `sources.start('gascity', ...)` has run. */
  started: boolean
}
