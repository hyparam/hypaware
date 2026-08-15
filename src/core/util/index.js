// @ts-check

// Shared utility surface for core and plugins (resolved as
// `hypaware/core/util`).

export {
  ConcurrentEditError,
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
  atomicWriteJsonSync,
  readFileIfExists,
  readFileIfExistsSync,
  readJsonIfExists,
  readJsonIfExistsSync,
} from './fs_atomic.js'
export { copyDir } from './fs_copy.js'
export {
  MAX_LABEL_CHARS,
  VOLATILE_BLOCK_FIELDS,
  canonicalJson,
  errCode,
  escapeForDisplay,
  isPlainObject,
  parseMaybeJson,
  redactUrlUserinfo,
  sanitizeLabel,
  sha256Hex,
  sortKeys,
  stringValue,
  stripVolatileBlockFields,
} from './json_util.js'
