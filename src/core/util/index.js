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
  canonicalJson,
  errCode,
  isPlainObject,
  parseMaybeJson,
  sha256Hex,
  sortKeys,
  stringValue,
} from './json_util.js'
