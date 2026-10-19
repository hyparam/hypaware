// @ts-check
import path from 'node:path'
import { validateAttachSection, validateBackfillSection } from '../../codex/src/config.js'

/** @import { ValidationResult } from '../../../../hypaware-plugin-kernel-types.js' */
/** @param {unknown} value @returns {ValidationResult} */
export function validateCopilotConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: [{ pointer: '', message: 'copilot config must be an object' }] }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const errors = [...validateAttachSection(raw.attach, '/attach'), ...validateBackfillSection(raw.backfill, '/backfill', true)]
  if (raw.user_data_dirs !== undefined && (!Array.isArray(raw.user_data_dirs) || !raw.user_data_dirs.length || raw.user_data_dirs.length > 8 || raw.user_data_dirs.some(v => typeof v !== 'string' || !path.isAbsolute(v)))) errors.push({ pointer: '/user_data_dirs', message: 'user_data_dirs must contain 1 to 8 absolute VS Code user-data directories' })
  for (const key of Object.keys(raw)) if (!['attach', 'backfill', 'user_data_dirs'].includes(key)) errors.push({ pointer: `/${key}`, message: `unknown copilot key '${key}'` })
  return errors.length ? { ok: false, errors } : { ok: true }
}
