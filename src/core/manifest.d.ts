import type { PluginManifest } from '../../collectivus-plugin-kernel-types.d.ts'
import type {
  FailedManifest,
  LoadedManifest,
  ManifestErrorKind,
  ManifestLoadResult,
} from './types.d.ts'

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
