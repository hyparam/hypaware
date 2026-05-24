import type {
  PluginManifest,
  PluginRequirements,
  PluginProvides,
  PluginContributionManifest,
  PluginCommandManifest,
  PluginConfigSectionManifest,
  PluginSourceManifest,
  PluginSinkManifest,
  PluginDatasetManifest,
  PluginSkillManifest,
  PluginInitPresetManifest,
  PluginSkillClient,
  PluginSourceKind,
  PluginSourceSpec,
  PluginLockFile,
  PluginLockEntry,
  PluginUpdateState,
  SinkSupportTag,
} from '../../collectivus-plugin-kernel-types.d.ts'

export type {
  PluginManifest,
  PluginRequirements,
  PluginProvides,
  PluginContributionManifest,
  PluginCommandManifest,
  PluginConfigSectionManifest,
  PluginSourceManifest,
  PluginSinkManifest,
  PluginDatasetManifest,
  PluginSkillManifest,
  PluginInitPresetManifest,
  PluginSkillClient,
  PluginSourceKind,
  PluginSourceSpec,
  PluginLockFile,
  PluginLockEntry,
  PluginUpdateState,
  SinkSupportTag,
}

export type ManifestErrorKind = 'manifest_invalid'

export interface LoadedManifest {
  ok: true
  manifest: PluginManifest
  manifestPath: string
  rootDir: string
}

export interface FailedManifest {
  ok: false
  errorKind: ManifestErrorKind
  message: string
  manifestPath: string
  rootDir: string
}

export type ManifestLoadResult = LoadedManifest | FailedManifest

/** Validate a parsed JSON value against the V1 `PluginManifest` shape. */
export function validateManifest(
  value: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; errorKind: ManifestErrorKind; message: string }

/** Read and validate `hypaware.plugin.json` from `rootDir`. */
export function loadManifest(rootDir: string): Promise<ManifestLoadResult>

/** Load several manifests in parallel; split results into loaded vs failed. */
export function loadManifests(
  rootDirs: string[],
): Promise<{ loaded: LoadedManifest[]; failed: FailedManifest[] }>
