// @ts-check

/**
 * @import { PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ClientDescriptor } from '../../../src/core/types.js'
 * @import { EntrypointOwner, EntrypointOwners } from '../../../src/core/backfill/types.js'
 */

/**
 * Build the transcript-`entrypoint` to owning-client map from the plugin
 * catalog's client descriptors.
 *
 * A client that writes its history into another client's transcript tree
 * declares the entrypoint values it owns
 * (`contributes.client.transcript_entrypoints`). Claude Desktop is the
 * motivating case: its sessions land in `~/.claude/projects` beside Claude
 * Code's, so the `@hypaware/claude` backfill would otherwise import them as
 * its own.
 *
 * The map is built from the catalog rather than a table here so that adding
 * a client gates and attributes its entrypoints without a core edit. Three
 * hardcoded lists in this area have already drifted from the manifests.
 *
 * @ref LLP 0140#manifest-declares-ownership [implements]: entrypoint ownership is a manifest contribution, not a core table
 * @param {Iterable<ClientDescriptor>} descriptors
 * @param {(pluginName: PluginName) => boolean} isConfigured
 * @returns {EntrypointOwners}
 */
export function resolveEntrypointOwners(descriptors, isConfigured) {
  /** @type {Map<string, EntrypointOwner>} */
  const owners = new Map()
  for (const descriptor of descriptors) {
    for (const entrypoint of descriptor.transcriptEntrypoints ?? []) {
      // First declaration wins, matching the catalog's own first-wins rule for
      // client and picker contributions. Two plugins claiming one entrypoint is
      // a packaging mistake, not a runtime choice to arbitrate here.
      if (owners.has(entrypoint)) continue
      owners.set(entrypoint, {
        client: descriptor.name,
        plugin: descriptor.plugin,
        configured: isConfigured(descriptor.plugin),
      })
    }
  }
  return owners
}

/**
 * Decide whether a transcript session may be imported, and which client it
 * should be attributed to.
 *
 * Unknown entrypoints fail OPEN: they are imported and attributed to the
 * scanning client. Failing closed would silently drop legitimate history
 * whenever a client ships a new entrypoint value or an old transcript
 * predates the field, and a backfill that quietly imports less than it
 * should is worse than one that imports a row under a slightly wrong
 * client. The gate therefore closes only on an entrypoint some installed
 * plugin explicitly claims while not being configured, which is the case
 * that actually breaks consent.
 *
 * @ref LLP 0140#fail-open-on-unknown [implements]: only a claimed-but-unconfigured entrypoint is skipped; unknown values import and are logged
 * @param {string | undefined} entrypoint
 * @param {EntrypointOwners} owners
 * @param {string} scanningClient
 * @returns {{ import: boolean, clientName: string, owner?: EntrypointOwner }}
 */
export function classifyTranscriptEntrypoint(entrypoint, owners, scanningClient) {
  if (!entrypoint) return { import: true, clientName: scanningClient }
  const owner = owners.get(entrypoint)
  if (!owner) return { import: true, clientName: scanningClient }
  if (!owner.configured) return { import: false, clientName: owner.client, owner }
  // Owned and configured: attribute to the owner, not to the plugin whose
  // transcript tree the session happened to live in. Without this, Desktop
  // rows land under `client_name: "claude"` and are queryable only by
  // entrypoint.
  return { import: true, clientName: owner.client, owner }
}

/**
 * Read a session's entrypoint from its transcript entries.
 *
 * Every transcript observed carries the field on most lines and exactly one
 * distinct value per file, so the first non-empty value identifies the
 * session. Scanning rather than trusting a fixed line index because the
 * lines that carry it vary by record type (`attachment` and summary records
 * omit it).
 *
 * @param {Iterable<{ entrypoint?: string | undefined }>} entries
 * @returns {string | undefined}
 */
export function sessionEntrypoint(entries) {
  for (const entry of entries) {
    if (typeof entry.entrypoint === 'string' && entry.entrypoint.length > 0) return entry.entrypoint
  }
  return undefined
}
