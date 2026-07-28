import type { PluginName } from '../../../hypaware-plugin-kernel-types.d.ts'

/**
 * The client that owns a transcript `entrypoint` value, plus whether its
 * plugin is active in the effective config. `configured: false` is what
 * closes the backfill gate: the entrypoint belongs to a client the user has
 * not opted into, so importing its sessions would capture content with no
 * consent.
 */
export interface EntrypointOwner {
  client: string
  plugin: PluginName
  configured: boolean
}

/** Transcript `entrypoint` value to its owning client. */
export type EntrypointOwners = Map<string, EntrypointOwner>
