// @ts-check

/**
 * @import { ActionRefusalError } from '../../../src/core/config/types.js'
 */

/**
 * Mark a thrown Error as a permanent refusal, so it survives the kernel's
 * throw-only `attach(): Promise<void>` seam (hypaware-plugin-kernel-types.d.ts)
 * and action_attach.js's perform() catch can tell it apart from an
 * environmental failure that might succeed on retry.
 *
 * @param {Error} err
 * @returns {ActionRefusalError}
 * @ref LLP 0186#markactionrefused--isactionrefused [implements]: mark a thrown Error as a permanent refusal that survives the throw-only attach() seam
 */
export function markActionRefused(err) {
  const marked = /** @type {ActionRefusalError} */ (err)
  marked.hypActionRefused = true
  return marked
}

/**
 * Read the refusal marker back defensively: anything that is not an Error
 * marked by `markActionRefused` (a plain Error, a non-Error throw such as a
 * string, `undefined`, ...) reads as `false`.
 *
 * @param {unknown} err
 * @returns {boolean}
 * @ref LLP 0186#markactionrefused--isactionrefused [implements]: tolerant readback so action_attach.js's perform() catch can classify any thrown value
 */
export function isActionRefused(err) {
  return err instanceof Error && /** @type {ActionRefusalError} */ (err).hypActionRefused === true
}
