// @ts-check

// Public API for the `.hypignore` folder-scoped usage policy (LLP 0049/0050/0052).
// The shared, cwd-agnostic matcher lives in core; the Claude/Codex adapters
// import it exactly as they import `src/core/observability`.
export { parseHypignore } from './format.js'
export {
  CLASS_RANK,
  createUsagePolicyResolver,
  governingListEntry,
  isEqualOrDescendant,
  sameDirectory,
  scopeGovernance,
  scopeGoverns,
} from './matcher.js'
// The two mechanisms by which one directory has several spellings, and the gate
// folds both. Symlink canonicalization (LLP 0050 #canonicalization): a directory
// is matched over the set of spellings that denote it, so a `.hypignore` or a
// machine-local entry cannot be escaped (or lost) by reaching the same directory
// through a symlink.
export { canonicalizeDirSync, canonicalSpellings, PATH_CANONICALIZE_ERROR_KIND } from './canonical.js'
// And the spelling fold applied to each of those (LLP 0050 #normalization):
// Unicode-NFC always, case only on a volume probed case-insensitive. Exported so
// a caller that has to agree with the gate's verdict folds by the same rule
// instead of growing a second one.
export {
  createVolumeCaseProbe,
  foldPath,
  sameDirectoryOnDisk,
  PATH_ALIAS_PROBE_ERROR_KIND,
  PATH_CASE_PROBE_ERROR_KIND,
} from './fold.js'
// The terminal capture-seam drop sentinel (LLP 0050): an adapter projector
// returns it for an `.hypignore`-ignored exchange, and the gateway dispatcher
// stops on it (never falls through to a later projector) and logs it as a drop.
export { USAGE_POLICY_DROP, isUsagePolicyDrop } from './drop.js'
// Repo-root resolution for the `hyp ignore` CLI (LLP 0049 #cli): place a
// single repo-wide `.hypignore` at the git toplevel.
export { findRepoRoot } from './repo_root.js'
// The machine-local `local-only` list (LLP 0071/0103): a single `HYP_HOME`-
// state JSON file, distinct from the committable `.hypignore` dotfile. Read
// by the export-seam resolver and `hyp status`, written by the login picker
// and the `hyp ignore` / `hyp unignore` machine-local marking verbs
// (`--private`, `--local-only`, `--sync`). `readLocalOnlyEntries` /
// `writeLocalOnlyEntries` see the full class-per-entry store (LLP 0103);
// `readLocalOnlyDirs` / `writeLocalOnlyDirs` are the `local-only`-class-only
// back-compat view the enrollment picker and `hyp status` use.
export {
  localOnlyListPath,
  readLocalOnlyEntries,
  writeLocalOnlyEntries,
  readLocalOnlyDirs,
  writeLocalOnlyDirs,
  LocalOnlyListUnreadableError,
  LOCAL_ONLY_LIST_UNREADABLE_ERROR_KIND,
} from './local_only.js'
// The machine-local per-client sync opt-out list (LLP 0188): on an enrolled
// machine every configured source syncs by default, and this store lists the
// sources the user keeps local. Absence of the file is the upgrade-migration
// marker (read returns null, never []); the export-seam resolver reads it
// lazily, `hyp status` and `hyp sync` narrate it, and the wizard sync-scope
// step and `hyp policy client` write it.
// The machine-local folder-ask preference (LLP 0200): whether a session
// opened in an unclassified folder is asked to classify it (LLP 0106) or
// left alone under the implicit sync default. Absence reads as `ask`, so a
// machine that never set it behaves exactly as before. Written by the
// wizard's sync lane and `hyp policy folders`, read by the classification
// hook and `hyp policy list`.
export {
  folderAskPath,
  readFolderAskMode,
  readFolderAskModeSafe,
  writeFolderAskMode,
  isFolderAskMode,
  DEFAULT_FOLDER_ASK_MODE,
  FOLDER_ASK_MODES,
  FOLDER_ASK_VERSION,
  FolderAskUnreadableError,
  FOLDER_ASK_UNREADABLE_ERROR_KIND,
} from './folder_ask.js'
export {
  clientSyncListPath,
  readClientSyncEntries,
  writeClientSyncEntries,
  optedOutClientSourceIds,
  seedClientSyncStoreIfAbsent,
  ClientSyncListUnreadableError,
  CLIENT_SYNC_LIST_UNREADABLE_ERROR_KIND,
  CLIENT_SYNC_LIST_VERSION,
} from './client_sync.js'
