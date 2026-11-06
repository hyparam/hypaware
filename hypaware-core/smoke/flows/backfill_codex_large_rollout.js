// @ts-check

import { run as runFixture } from './backfill_codex_fixture.js'

/**
 * @ref LLP 0583#verification [tests]: real backfill, query and rerun of a 743 MiB rollout and bounded message batches
 * @param {{ harness: any, expect: any }} args
 */
export async function run(args) {
  await runFixture({ ...args, largeRollout: true })
}
