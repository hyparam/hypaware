// @ts-check

/**
 * Regenerate test/fixtures/skill-host-divergence.json.
 *
 * @ref LLP 0194#t2-premise-corrected [implements]: the codex tree is not derivable from
 * the claude tree, so the guard records the host-specific surface instead of removing it
 *
 * Run this ONLY after deliberately adding or changing host-specific content in a skill
 * that ships to both hosts, and review the resulting fixture change: a growing
 * divergence count is the signal that something host-specific was added, which is
 * exactly what a reviewer needs to see.
 *
 *   node scripts/record-skill-host-divergence.js
 */

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { FIXTURE_PATH, divergenceReport } from '../test/helpers/skill_host_divergence.js'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')

const report = divergenceReport(repoRoot)
fs.writeFileSync(path.join(repoRoot, FIXTURE_PATH), `${JSON.stringify(report, null, 2)}\n`)

console.log(`wrote ${FIXTURE_PATH}`)
for (const [skill, record] of Object.entries(report)) {
  console.log(`  ${skill}: claude-only ${record.claudeOnly}, codex-only ${record.codexOnly}`)
}
