// @ts-check
import path from 'node:path'
import { validateBackfillSection } from '../../claude/src/config.js'

/** @import { ValidationResult } from '../../../../hypaware-plugin-kernel-types.js' */

/** @param {unknown} value @returns {ValidationResult} */
export function validateNanoclawConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: [{ pointer: '', message: 'nanoclaw config requires an absolute installation root' }] }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const errors = [...validateBackfillSection(raw.backfill, '/backfill')]
  if (typeof raw.root !== 'string' || !path.isAbsolute(raw.root) || raw.root.includes('\0')) errors.push({ pointer: '/root', message: 'root must be an absolute NanoClaw installation directory' })
  for (const key of Object.keys(raw)) if (!['root', 'backfill'].includes(key)) errors.push({ pointer: `/${key}`, message: `unknown nanoclaw key '${key}'` })
  return errors.length ? { ok: false, errors } : { ok: true }
}
