// @ts-check

/**
 * The renderer's assets live in exactly one place.
 *
 * @ref LLP 0193#mechanics-as-code [tests]: the renderer is repo-owned code, and so are
 * the assets it installs
 *
 * They used to ship three times: the canonical copy under `src/core/reports/assets/`
 * and one inside each host's bundled report skill, because the skill copied the
 * stylesheet into the reports tree itself. That copy step is gone. `hyp report render`
 * installs assets from its own directory, so the skill needs none of them, and the two
 * bundled copies were 64 KB of dead weight in the published package.
 *
 * Three copies of the same bytes is also the shape that drifts, and this set did: on
 * 2026-08-06 the canonical stylesheet and the one in a user's live reports tree had
 * diverged, and the skill's own "is this an older sheet?" heuristic could not tell a
 * customization from rot. One copy makes the question unanswerable-by-construction.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')

const CANONICAL_DIR = path.join(repoRoot, 'src/core/reports/assets')

/** Every asset the renderer installs into a reports tree. */
const ASSETS = ['style.css', 'copy-md.js', 'head.html', 'favicon.svg', 'favicon.png']

test('the canonical asset set is complete and lives with the renderer', () => {
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

test('no bundled skill ships its own copy of the renderer assets', () => {
  // The copy step that justified them is gone. A reappearing skill-side copy is a
  // second source of truth for the stylesheet, and the drift it causes is invisible
  // until someone compares a rendered page against another machine's.
  const workspace = path.join(repoRoot, 'hypaware-core/plugins-workspace')
  for (const client of fs.readdirSync(workspace, { withFileTypes: true })) {
    if (!client.isDirectory()) continue
    const skillsDir = path.join(workspace, client.name, 'skills')
    if (!fs.existsSync(skillsDir)) continue

    for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue
      const assetsDir = path.join(skillsDir, skill.name, 'assets')
      if (!fs.existsSync(assetsDir)) continue

      const duplicated = fs.readdirSync(assetsDir).filter((name) => ASSETS.includes(name))
      assert.deepEqual(
        duplicated,
        [],
        `${client.name}/skills/${skill.name}/assets/ duplicates renderer assets (${duplicated.join(', ')}). ` +
          'The renderer installs them from src/core/reports/assets/; a skill-side copy is dead weight and drifts.',
      )
    }
  }
})
