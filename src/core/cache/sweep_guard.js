// @ts-check

import { Attr, getLogger } from '../observability/index.js'

/**
 * Say that a sweep refused a path, and say it out loud. The symptom is
 * otherwise a partition that quietly never reclaims anything; `ls -l` at the
 * logged component answers why in one line.
 *
 * Every refusing pass on a cache path reports through here, and the operation
 * says which one stood down. They reclaim different leaks, so "nothing is
 * being reclaimed" is several different reports, and a refusal that said
 * nothing at all would be the silent half of exactly the symptom this line
 * exists to name.
 *
 * It lives in its own module rather than beside any one pass because the
 * passes that need it are on both sides of an existing import edge: cache
 * maintenance already imports the sidecar builder, so the builder cannot
 * reach back for it. A refusal message copied into the second caller is a
 * message that drifts, and two spellings of "nothing is being reclaimed here"
 * is the state an operator resolves by grepping for the one they remember.
 *
 * The logger is a parameter with the global as its default, so a pass that
 * already takes an injectable log reports its refusal through the same one it
 * reports everything else through. That is also the only way a test can see a
 * refusal at all: on a default install the global provider is null and the
 * record is dropped (#1108), which is why no existing containment guard has a
 * regression control on the fact that it SPOKE rather than on the fact that it
 * deleted nothing.
 *
 * @ref LLP 0331#guard-travels-with-the-delete [implements]: the report travels
 *   with the check, so a pass that moves its guard inward keeps its voice
 * @param {string} tableDir
 * @param {string} operation
 * @param {string} plantedComponent
 * @param {{ warn(msg: string, fields?: object): void }} [log]
 */
export function reportPlantedSweepPath(tableDir, operation, plantedComponent, log) {
  try {
    (log ?? getLogger('cache')).warn('a symlink stands on the sweep path; reclaiming nothing in this generation', {
      [Attr.OPERATION]: operation,
      [Attr.ERROR_KIND]: 'sweep_path_is_symlink',
      table_dir: tableDir,
      planted_component: plantedComponent,
    })
  } catch { /* a sweep must not fail on a logger provider that is not installed */ }
}
