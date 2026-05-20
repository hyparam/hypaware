/**
 * @import { NormalizerDispatcher } from '../normalizer_dispatcher.js'
 */

import { claudeNormalize } from './claude.js'
import { codexNormalize } from './codex.js'

/**
 * Wire production normalizers onto a dispatcher. Beads 2 + 4 ship `claude`
 * and `codex`; the unknown-provider passthrough stays the dispatcher's own
 * default (bead 3's `raw_frame`-only row).
 *
 * Exposed as a function (rather than registered at module load) so test
 * doubles can build a dispatcher with hand-rolled stubs and bypass real
 * registration.
 *
 * @param {NormalizerDispatcher} dispatcher
 * @returns {void}
 */
export function registerProductionNormalizers(dispatcher) {
  dispatcher.register('claude', claudeNormalize)
  dispatcher.register('codex', codexNormalize)
}

export { claudeNormalize } from './claude.js'
export { codexNormalize } from './codex.js'
