// @ts-check

// The server contract fixtures HYP-111 builds against are pinned copies
// (LLP 0481 T1). These tests hold each pinned directory to its SOURCE.md
// (server commit, contract version, SHA-256 per file), so a refresh is a
// deliberate commit, and run the graph fixtures through the ported verifier,
// which must accept them and refuse a one-byte change.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

import {
  EDGE_COLUMNS,
  NODE_COLUMNS,
  createSetDigest,
  dataFileEtag,
  encodeLine,
  manifestEtag,
  measureFile,
  verifyManifest,
} from '../../hypaware-core/plugins-workspace/fastask/src/contract.js'

const CONTRACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'contracts')
const GRAPH = path.join(CONTRACTS, 'graph-snapshot', 'v1')
const EVIDENCE = path.join(CONTRACTS, 'session-evidence', 'v1')

/** @param {string} dir */
function filesIn(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

/** @param {string} dir */
function readSource(dir) {
  const text = fs.readFileSync(path.join(dir, 'SOURCE.md'), 'utf8')
  /** @param {string} label */
  const field = (label) => text.match(new RegExp(`^- ${label}: \`([^\`]+)\``, 'm'))?.[1]
  const block = text.match(/```text\n([\s\S]*?)```/)?.[1] ?? ''
  const hashes = new Map(block.trim().split('\n').map((line) => {
    const [sha, name] = line.split(/ {2}/)
    return [name, sha]
  }))
  return { repository: field('Repository'), commit: field('Commit'), contract: field('Contract version'), hashes }
}

for (const [dir, contract] of /** @type {const} */ ([[GRAPH, 'hypaware.graph-snapshot/1'], [EVIDENCE, 'hypaware.session-evidence/1']])) {
  test(`${contract} pin records its server commit and contract version`, () => {
    const source = readSource(dir)
    assert.equal(source.repository, 'hyparam/hypaware-server')
    assert.match(source.commit ?? '', /^[0-9a-f]{40}$/)
    assert.equal(source.contract, contract)
  })

  test(`${contract} pinned files match the recorded SHA-256 list exactly`, () => {
    const { hashes } = readSource(dir)
    const present = filesIn(dir).filter((name) => name !== 'SOURCE.md')
    assert.deepEqual(present, [...hashes.keys()].sort(), 'the directory holds exactly the listed files')
    for (const name of present) {
      const sha = createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
      assert.equal(sha, hashes.get(name), `${name} differs from the pinned copy`)
    }
  })
}

/** @param {string} name */
const graphFile = (name) => fs.readFileSync(path.join(GRAPH, name))
/** @param {string} name */
const graphJson = (name) => JSON.parse(graphFile(name).toString('utf8'))
const gz = { nodes: graphFile('nodes.ndjson.gz'), edges: graphFile('edges.ndjson.gz') }

test('the pinned graph generation passes the ported verifier', async () => {
  const result = await verifyManifest({ manifest: graphJson('manifest.json'), ...gz })
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
})

test('the verifier accepts the files streamed in small chunks', async () => {
  /** @param {Uint8Array} bytes */
  async function* chunked(bytes) {
    for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7)
  }
  const result = await verifyManifest({ manifest: graphJson('manifest.json'), nodes: chunked(gz.nodes), edges: chunked(gz.edges) })
  assert.deepEqual(result.problems, [])
})

test('one changed compressed byte fails verification', async () => {
  const flipped = Buffer.from(gz.nodes)
  flipped[Math.floor(flipped.length / 2)] ^= 0x01
  const result = await verifyManifest({ manifest: graphJson('manifest.json'), nodes: flipped, edges: gz.edges })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.startsWith('nodes: sha256')), result.problems.join('; '))
})

test('one changed decompressed byte fails by set digest even when sha256 and bytes agree', async () => {
  const plain = graphFile('edges.ndjson')
  const tampered = Buffer.from(plain)
  tampered[plain.indexOf('"READ"') + 2] = 'X'.charCodeAt(0)
  const tamperedGz = gzipSync(tampered)
  const manifest = graphJson('manifest.json')
  manifest.files.edges.sha256 = createHash('sha256').update(tamperedGz).digest('hex')
  manifest.files.edges.bytes = tamperedGz.length
  const result = await verifyManifest({ manifest, nodes: gz.nodes, edges: tamperedGz })
  assert.equal(result.problems.length, 1, result.problems.join('; '))
  assert.match(result.problems[0], /^edges: set_digest/)
})

test('an unsupported schema version or column order is refused', async () => {
  const newer = graphJson('manifest.json')
  newer.schema.schema_version = 2
  assert.ok((await verifyManifest({ manifest: newer, ...gz })).problems.some((p) => p.startsWith('schema.schema_version')))
  const reordered = graphJson('manifest.json')
  reordered.schema.node_columns.reverse()
  assert.ok((await verifyManifest({ manifest: reordered, ...gz })).problems.some((p) => p.startsWith('schema.node_columns')))
})

test('framing faults are reported', async () => {
  const lines = graphFile('edges.ndjson').toString('utf8').split('\n').slice(0, -1)
  assert.ok((await measureFile(gzipSync(lines.join('\n')))).problems.includes('last line has no trailing newline'))
  assert.ok((await measureFile(gzipSync(`${lines[0]}\n\n`))).problems.includes('1 empty line(s)'))
  assert.ok((await measureFile(graphFile('edges.ndjson'))).problems.some((p) => p.startsWith('not a readable gzip stream')))
})

test('a line hashed across many decompressed chunks digests the same as the whole line', async () => {
  // Each line is far longer than one gunzip output chunk (16 KiB).
  const lines = ['a', 'b', 'c'].map((ch, i) => ch.repeat(300 * 1024 + i))
  const reference = createSetDigest()
  for (const line of lines) reference.add(line)
  const { facts, problems, refused } = await measureFile(gzipSync(lines.map((l) => `${l}\n`).join('')))
  assert.deepEqual(problems, [])
  assert.equal(refused, null)
  assert.equal(facts.rows, 3)
  assert.equal(facts.set_digest, reference.hex())
  const unterminated = await measureFile(gzipSync(`${lines[0]}\n${lines[1]}`))
  assert.ok(unterminated.problems.includes('last line has no trailing newline'))
  assert.equal(unterminated.facts.set_digest, (() => { const d = createSetDigest(); d.add(lines[0]); d.add(lines[1]); return d.hex() })())
})

test('a line past maxLineBytes is refused while it is read, and the other file is not read (review r1 F6)', async () => {
  const ceiling = 1024 * 1024
  const big = gzipSync(`${'{"a":1}\n'.repeat(4)}${'x'.repeat(8 * ceiling)}\n`)
  const measured = await measureFile(big, { maxLineBytes: ceiling })
  assert.equal(measured.refused, 'line_too_large')
  assert.deepEqual(measured.problems, [`line 5 is longer than the ${ceiling}-byte line ceiling`])
  assert.equal(measured.facts.rows, 4)
  // Decompression stopped within one output chunk of the ceiling, not at 8 MiB.
  assert.ok(measured.facts.uncompressed_bytes <= ceiling + 64 * 1024, `read ${measured.facts.uncompressed_bytes} bytes`)

  const exact = await measureFile(gzipSync(`${'x'.repeat(ceiling)}\n`), { maxLineBytes: ceiling })
  assert.equal(exact.refused, null, 'a line exactly at the ceiling is accepted')
  assert.deepEqual(exact.problems, [])

  const manifest = graphJson('manifest.json')
  let edgesRead = false
  async function* edges() { edgesRead = true; yield gz.edges }
  const verified = await verifyManifest({ manifest, nodes: big, edges: edges() }, { maxLineBytes: ceiling })
  assert.equal(verified.ok, false)
  assert.equal(verified.refused, 'line_too_large')
  assert.equal(edgesRead, false)
  assert.equal(verified.observed.edges, undefined)
  // Without options the verifier is unchanged.
  assert.equal((await verifyManifest({ manifest, ...gz })).refused, null)
})

test('the work budget and abort reach the decompressed work, not only the compressed reads (review r1 F6)', async () => {
  // One compressed chunk that inflates to 50,000 lines.
  const many = gzipSync('{"a":1}\n'.repeat(50_000))
  let ticks = 0
  const { facts } = await measureFile([many], { tick: () => { ticks++; return undefined } })
  assert.equal(facts.rows, 50_000)
  assert.ok(ticks >= 50_000, `ticked ${ticks} times for one compressed chunk`)

  const stop = new AbortController()
  const reason = new Error('shutting down')
  let seen = 0
  await assert.rejects(measureFile([many], {
    signal: stop.signal,
    tick: () => {
      if (++seen === 1000) stop.abort(reason)
      return seen >= 1000 ? Promise.reject(stop.signal.reason) : undefined
    },
  }), (err) => err === reason)
  assert.equal(seen, 1000, 'no line was read after the abort')

  // An abort that surfaces only through the budget is still an abort, not a format problem.
  const budgetStop = new Error('budget aborted')
  await assert.rejects(measureFile([many], { tick: () => Promise.reject(budgetStop) }), (err) => err === budgetStop)
})

test('the ported line encoding reproduces every pinned line', () => {
  for (const [name, columns] of /** @type {const} */ ([['nodes', NODE_COLUMNS], ['edges', EDGE_COLUMNS]])) {
    const text = graphFile(`${name}.ndjson`).toString('utf8')
    assert.ok(gunzipSync(gz[name]).equals(graphFile(`${name}.ndjson`)), `${name}.ndjson.gz decompresses to ${name}.ndjson`)
    for (const line of text.split('\n').slice(0, -1)) {
      const row = JSON.parse(line)
      assert.deepEqual(Object.keys(row), [...columns])
      assert.equal(encodeLine(row, columns), line)
    }
  }
})

test('the set digest is order-independent and is the sum mod 2^256 of per-line SHA-256', () => {
  const lines = [graphFile('nodes.ndjson'), graphFile('edges.ndjson')]
    .flatMap((bytes) => bytes.toString('utf8').split('\n').slice(0, -1))
  /** @param {string[]} input */
  const digestOf = (input) => {
    const digest = createSetDigest()
    for (const line of input) digest.add(line)
    return digest.hex()
  }
  let reference = 0n
  for (const line of lines) reference = (reference + BigInt(`0x${createHash('sha256').update(line).digest('hex')}`)) % (1n << 256n)
  assert.equal(digestOf(lines), reference.toString(16).padStart(64, '0'))
  assert.equal(digestOf([...lines].reverse()), digestOf(lines))
  assert.equal(digestOf([]), '0'.repeat(64))
})

test('the pinned headers agree with the manifest through the ported ETag helpers', () => {
  const manifest = graphJson('manifest.json')
  const headers = graphJson('headers.json')
  assert.equal(headers.manifest_200.etag, manifestEtag(manifest.generation))
  assert.equal(headers.not_modified_304.etag, manifestEtag(manifest.generation))
  assert.equal(headers.nodes_200.etag, dataFileEtag(manifest.files.nodes.sha256))
  assert.equal(headers.edges_200.etag, dataFileEtag(manifest.files.edges.sha256))
})

test('every pinned graph response names its status and code', () => {
  for (const name of filesIn(path.join(GRAPH, 'responses'))) {
    const [status, code] = name.slice(0, -'.json'.length).split('-')
    const fixture = graphJson(`responses/${name}`)
    assert.equal(fixture.status, Number(status), name)
    if (fixture.status === 304) assert.equal(fixture.body, null)
    else assert.equal(fixture.body.error, code, name)
  }
})

// The evidence fixtures' full rules are checked by the server's own checker;
// here each case only has to keep the outer shape the client dispatches on.
test('every pinned session-evidence case keeps its outer shape', () => {
  const names = filesIn(EVIDENCE).filter((name) => name.endsWith('.json'))
  assert.equal(names.length, 13)
  for (const name of names) {
    const fixture = JSON.parse(fs.readFileSync(path.join(EVIDENCE, name), 'utf8'))
    const outcomes = ['response', 'tool_error', 'jsonrpc_error'].filter((key) => Object.hasOwn(fixture, key))
    assert.equal(outcomes.length, 1, `${name} has exactly one outcome`)
    assert.equal(typeof fixture.case, 'string', name)
    assert.ok(Array.isArray(fixture.request.sessions) && fixture.request.sessions.every((/** @type {unknown} */ s) => typeof s === 'string'), `${name}: sessions entries travel as strings`)
    if (fixture.response) assert.equal(fixture.response.contract, 'hypaware.session-evidence/1', name)
    if (fixture.tool_error) assert.ok(fixture.tool_error.isError && /^[a-z_]+: /.test(fixture.tool_error.content[0].text), name)
    if (fixture.jsonrpc_error) assert.equal(fixture.jsonrpc_error.error.code, -32602, name)
  }
})
