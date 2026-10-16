// @ts-check

// Each `<!-- agent: ... -->` marker in docs/ is a prompt the site shows above a
// command. An agent connected over MCP has no `hyp`, so every prompt must also
// say which MCP tool does the same read or act, or that there is none. Tool
// names come from docs/MCP_REFERENCE.md, which is generated from the real
// registrations, so a renamed tool fails here instead of leaving a dead name.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS_DIR = path.join(REPO_ROOT, 'docs')
const MARKER = /<!-- agent: ([\s\S]*?) -->/g

/** Tool names from MCP_REFERENCE.md: every `### name` heading before `## Prompts`. */
function referenceTools() {
  const page = readFileSync(path.join(DOCS_DIR, 'MCP_REFERENCE.md'), 'utf8')
  const tools = page.split(/^## Prompts$/m)[0]
  return [...tools.matchAll(/^### `([a-z_]+)`$/gm)].map((m) => m[1])
}

/** @returns {Promise<{ page: string, text: string }[]>} */
async function docsPages() {
  const pages = []
  for (const name of (await fs.readdir(DOCS_DIR)).sort()) {
    if (!name.endsWith('.md')) continue
    pages.push({ page: name, text: await fs.readFile(path.join(DOCS_DIR, name), 'utf8') })
  }
  return pages
}

// @ref LLP 0494#docs-paths [tests]: every agent prompt names its MCP tool or says there is no MCP path
test('every agent marker names an MCP tool or says there is no MCP path', async () => {
  const tools = referenceTools()
  assert.ok(tools.includes('query_sql') && tools.includes('set_recommendation_status'), `MCP_REFERENCE.md tools: ${tools.join(', ')}`)
  let count = 0
  for (const { page, text } of await docsPages()) {
    for (const [, prompt] of text.matchAll(MARKER)) {
      count++
      const named = tools.some((tool) => new RegExp(`\\b${tool}\\b`).test(prompt))
      assert.ok(named || /no MCP path/.test(prompt), `docs/${page} marker names no MCP path: ${prompt}`)
    }
  }
  assert.ok(count > 0, 'no agent markers found in docs/')
})

// @ref LLP 0494#docs-paths [tests]: hyp report list gets its own prompt in Reports
test('Reports has an agent marker for hyp report list', () => {
  const text = readFileSync(path.join(DOCS_DIR, 'REPORTS.md'), 'utf8')
  const block = /<!-- agent: ([^\n]*?) -->\n```sh\n([\s\S]*?)```/g
  const listing = [...text.matchAll(block)].filter(([, , sh]) => sh.startsWith('hyp report list'))
  assert.equal(listing.length, 1, 'REPORTS.md needs one agent marker above a block that is hyp report list')
  assert.match(listing[0][1], /\blist_recommendations\b/)
})

// @ref LLP 0494#docs-paths [tests]: the MCP lines stand alone; no page links the MCP pages
test('no docs page links MCP.md or MCP_REFERENCE.md', async () => {
  for (const { page, text } of await docsPages()) {
    if (page === 'MCP.md' || page === 'MCP_REFERENCE.md') continue
    assert.ok(!/\(\.?\/?MCP(_REFERENCE)?\.md[)#]/.test(text), `docs/${page} links an MCP page`)
  }
})
