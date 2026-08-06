// @ts-check

/**
 * End-to-end contract for the report renderer, built in a temp tree.
 *
 * @ref LLP 0193#mechanics-as-code [tests]: the verification the skill used to perform as
 * a list of greps is now the renderer's own contract, so it runs every time
 *
 * The shell original could not be covered at all: it is macOS-only and CI is
 * `ubuntu-latest`. These assertions are the skill's step-6 checklist, promoted to code.
 *
 * pandoc is a hard dependency (LLP 0193 open question 1). CI installs it, so these run
 * there; a contributor without it gets a skip rather than a failure.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hasPandoc, renderReports } from '../../src/core/reports/render.js'

const skip = hasPandoc() ? false : 'pandoc not installed'

const SLUG = '2026-08-02-usage-review'
const OTHER = '2026-07-21-usage-review'

/** A reports tree with one sectioned report, one flat report, and cross-report links. */
function fixtureTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-render-'))
  fs.writeFileSync(
    path.join(dir, `${SLUG}.md`),
    [
      '# Team AI Usage Review',
      '',
      '**One sentence thesis.**',
      '',
      `See [trends](${SLUG}/trends.md) and [changes](${SLUG}/proposed-changes.md#top).`,
      `Compare with the [previous review](${OTHER}.md).`,
      '',
      `<a class="rec" href="${SLUG}/proposed-changes.md"><h3>Proposed changes</h3></a>`,
      '',
      '[upstream](https://example.com/docs/readme.md)',
      '',
    ].join('\n'),
  )
  fs.mkdirSync(path.join(dir, SLUG))
  fs.writeFileSync(
    path.join(dir, SLUG, 'trends.md'),
    `# Trends\n\n**Thesis.**\n\nBack to [the report](../${SLUG}.md), or [changes](proposed-changes.md).\n`,
  )
  fs.writeFileSync(
    path.join(dir, SLUG, 'proposed-changes.md'),
    `# Proposed changes\n\n**Thesis.**\n\nSee [their trends](../${OTHER}/trends.md).\n`,
  )
  // A flat report: no sibling section directory.
  fs.writeFileSync(path.join(dir, `${OTHER}.md`), '# Previous Review\n\n**Thesis.**\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# Not a report\n')
  return dir
}

test('renderReports builds every report and no stale output', { skip }, () => {
  const dir = fixtureTree()
  const result = renderReports({ dir })

  assert.equal(result.reports, 2, 'README.md must not be treated as a report')
  assert.deepEqual(result.slugs.sort(), [OTHER, SLUG].sort())

  assert.ok(fs.existsSync(path.join(dir, 'html', SLUG, 'index.html')))
  assert.ok(fs.existsSync(path.join(dir, 'html', SLUG, 'trends.html')))
  assert.ok(fs.existsSync(path.join(dir, 'html', OTHER, 'index.html')))
  assert.ok(!fs.existsSync(path.join(dir, 'html', 'README')), 'README must not build')

  // html/ is wiped each run, so a removed report leaves nothing behind.
  fs.rmSync(path.join(dir, `${OTHER}.md`))
  renderReports({ dir })
  assert.ok(!fs.existsSync(path.join(dir, 'html', OTHER)), 'a deleted report must leave no stale HTML')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('no built page keeps a .md href', { skip }, () => {
  const dir = fixtureTree()
  renderReports({ dir })

  for (const file of builtPages(path.join(dir, 'html'))) {
    const html = fs.readFileSync(file, 'utf8')
    const leftover = [...html.matchAll(/href="([^"]*\.md(?:#[^"]*)?)"/g)]
      .map((m) => m[1])
      // Absolute URLs are deliberately untouched.
      .filter((href) => !href.includes('://'))
    assert.deepEqual(leftover, [], `${path.basename(file)} has unrewritten .md links: ${leftover}`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
})

test('every page carries a copy action, and every report a full.md payload', { skip }, () => {
  const dir = fixtureTree()
  renderReports({ dir })

  for (const file of builtPages(path.join(dir, 'html'))) {
    const html = fs.readFileSync(file, 'utf8')
    assert.match(html, /class="copy-md"/, `${file} is missing its copy action`)
    // The copy button must keep a raw .md target: data-src is not href.
    assert.match(html, /data-src="[^"]+\.md"/, `${file} lost its data-src payload`)
  }

  assert.ok(fs.existsSync(path.join(dir, 'html', SLUG, 'full.md')))
  const full = fs.readFileSync(path.join(dir, 'html', SLUG, 'full.md'), 'utf8')
  assert.match(full, /# Team AI Usage Review/)
  assert.match(full, /# Trends/, 'full.md must concatenate the sections')
  assert.match(full, /\.md\)/, 'the raw payload keeps its .md links on purpose')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('one-pagers link back to the landing page, sections back to their report', { skip }, () => {
  const dir = fixtureTree()
  renderReports({ dir })

  const index = fs.readFileSync(path.join(dir, 'html', SLUG, 'index.html'), 'utf8')
  assert.match(index, /All reports/)
  assert.match(index, /href="\.\.\/\.\.\/index\.html"/)

  const section = fs.readFileSync(path.join(dir, 'html', SLUG, 'trends.html'), 'utf8')
  assert.match(section, /Back to the report/)
  // The back-reference to its own one-pager flattens to index.html.
  assert.match(section, /href="index\.html"/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a user theme.css is copied beside pages and never overwritten', { skip }, () => {
  const dir = fixtureTree()
  renderReports({ dir })

  const theme = path.join(dir, 'assets', 'theme.css')
  fs.writeFileSync(theme, ':root { --accent: #ff0000 }')
  renderReports({ dir })

  assert.equal(fs.readFileSync(theme, 'utf8'), ':root { --accent: #ff0000 }', 'theme.css is the user\'s')
  assert.ok(
    fs.existsSync(path.join(dir, 'html', SLUG, 'assets', 'theme.css')),
    'theme.css must ship beside the built pages',
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

/** @param {string} htmlDir @returns {string[]} */
function builtPages(htmlDir) {
  /** @type {string[]} */
  const out = []
  for (const entry of fs.readdirSync(htmlDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of fs.readdirSync(path.join(htmlDir, entry.name))) {
      if (file.endsWith('.html')) out.push(path.join(htmlDir, entry.name, file))
    }
  }
  return out
}
