import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readCursor, writeCursor } from '../../src/gascity/cursor.js'

describe('readCursor / writeCursor', () => {
  /** @type {string} */
  let dir
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-cursor-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns undefined when the cursor file does not exist', async () => {
    const out = await readCursor(path.join(dir, 'missing.json'))
    expect(out).toBeUndefined()
  })

  it('round-trips a cursor object through write + read', async () => {
    const file = path.join(dir, 'sub', 'cursor.json')
    await writeCursor(file, { last_uuid: 'abc', flushed: 12 })
    const out = await readCursor(file)
    expect(out).toEqual({ last_uuid: 'abc', flushed: 12 })
  })

  it('creates parent directories on demand', async () => {
    const file = path.join(dir, 'a', 'b', 'c', 'cursor.json')
    await writeCursor(file, { last_event_id: 'evt-9' })
    expect((await fs.stat(file)).isFile()).toBe(true)
  })

  it('treats malformed JSON as missing and surfaces a one-line warning', async () => {
    const file = path.join(dir, 'broken.json')
    await fs.writeFile(file, 'not json', 'utf8')
    /** @type {string[]} */
    const errs = []
    const out = await readCursor(file, { onError: (m) => errs.push(m) })
    expect(out).toBeUndefined()
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatch(/cursor .* is not valid JSON/)
  })

  it('treats a non-object JSON as missing', async () => {
    const file = path.join(dir, 'array.json')
    await fs.writeFile(file, '[1,2,3]', 'utf8')
    /** @type {string[]} */
    const errs = []
    const out = await readCursor(file, { onError: (m) => errs.push(m) })
    expect(out).toBeUndefined()
    expect(errs[0]).toMatch(/not a JSON object/)
  })

  it('overwrites an existing cursor atomically (no .tmp left behind)', async () => {
    const file = path.join(dir, 'cursor.json')
    await writeCursor(file, { last_uuid: 'first' })
    await writeCursor(file, { last_uuid: 'second' })
    const out = await readCursor(file)
    expect(out).toEqual({ last_uuid: 'second' })
    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['cursor.json'])
  })
})
