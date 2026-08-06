// @ts-check

/**
 * Drift guard for the vendored report renderer.
 *
 * @ref LLP 0193#mechanics-as-code [tests]: "canonical" is only meaningful if a copy
 * cannot silently drift from it, and this set already drifted once.
 *
 * The renderer's assets ship three times: once as the repo-owned canonical copy under
 * src/core/reports/assets/, and once inside each host's bundled
 * hypaware-report-to-html skill (claude and codex), because an installed skill is
 * self-contained and cannot reach back into this repo at runtime. That is three copies
 * of the same bytes, which is exactly the shape that drifted before: on 2026-08-06 the
 * canonical stylesheet and the one in the user's live reports tree had diverged, and
 * the skill's own "is this an older sheet?" heuristic could not tell a customization
 * from rot.
 *
 * LLP 0194 T7 removes the reason for the skill copies (the theme layer makes the base
 * sheet command-owned and always refreshed). Until then, this test holds the three
 * copies together.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')

const CANONICAL_DIR = path.join(repoRoot, 'src/core/reports/assets')

const SKILL_ASSET_DIRS = [
  'hypaware-core/plugins-workspace/claude/skills/hypaware-report-to-html/assets',
  'hypaware-core/plugins-workspace/codex/skills/hypaware-report-to-html/assets',
]

/** Every asset the renderer installs into a built page. */
const ASSETS = ['style.css', 'copy-md.js', 'head.html', 'favicon.svg', 'favicon.png']

test('the canonical asset set is complete', () => {
  const present = fs.readdirSync(CANONICAL_DIR).sort()
  assert.deepEqual(present, [...ASSETS].sort(), 'src/core/reports/assets/ must hold exactly the renderer asset set')
})

test('the renderer is repo-owned code, not a script in a user working tree', () => {
  const renderer = path.join(repoRoot, 'src/core/reports/render.js')
  assert.ok(fs.existsSync(renderer), 'src/core/reports/render.js must exist: the repo owns the renderer')

  // The shell original was deleted once `hyp report render` replaced it (LLP 0194 T5).
  // A reappearing build.sh means someone restored the macOS-only, untested path that
  // CI cannot run at all.
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'src/core/reports/build.sh')),
    'build.sh was superseded by render.js and must not come back',
  )
})

for (const skillDir of SKILL_ASSET_DIRS) {
  for (const asset of ASSETS) {
    test(`${skillDir}/${asset} matches the canonical copy`, () => {
      const canonical = fs.readFileSync(path.join(CANONICAL_DIR, asset))
      const bundled = fs.readFileSync(path.join(repoRoot, skillDir, asset))
      assert.ok(
        canonical.equals(bundled),
        `${asset} has drifted from src/core/reports/assets/${asset}. ` +
          'Edit the canonical copy and re-sync the bundled ones; never edit a bundled copy directly.',
      )
    })
  }
}
