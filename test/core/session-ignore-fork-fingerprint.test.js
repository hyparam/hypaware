// @ts-check

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  claudeSessionContextFile,
  claudeTranscriptPathForSession,
  readTranscriptHeadUuids,
} from '../../src/core/claude/transcript_fingerprint.js'
import {
  FORK_FINGERPRINT_UUIDS,
  SessionIgnoreSet,
  hasSessionForkFingerprint,
  hasSessionIgnoreMarker,
  sessionForkFingerprintMatches,
  sessionIgnoreLoadError,
  writeSessionForkFingerprint,
} from '../../src/core/control/session_ignore_store.js'

/**
 * The store half of issue #1891. `hyp session ignore` holds one key per
 * opt-out - the raw session id - and a fork mints a new one, so the copied
 * conversation is recorded in full under the fork's id. The fingerprint is the
 * second file that lets a fork be recognised, and it lives in the directory a
 * corrupt entry of which disables capture everywhere, so what the loader
 * accepts and refuses is the load-bearing part.
 *
 * @ref LLP 0419#fingerprint [tests]: sibling file, shared byte ceiling,
 * removed with the marker, and any-match down a fork chain.
 */

test('markers and fingerprints load together, and any other filename is still corruption', () => {
  const root = tempRoot()
  try {
    const set = new SessionIgnoreSet(root)
    set.add('session-A')
    assert.equal(writeSessionForkFingerprint(root, 'session-A', [uuidAt(1), uuidAt(2)]), true)

    // A fresh reader loads the exclusion and is not tripped by the sibling.
    const reader = new SessionIgnoreSet(root)
    assert.equal(sessionIgnoreLoadError(reader), undefined)
    assert.deepEqual([...reader], ['session-A'])

    // Fingerprint bytes count toward the same ceiling as the markers.
    const onDisk = fs.readdirSync(reader.directory)
      .reduce((sum, name) => sum + fs.statSync(path.join(reader.directory, name)).size, 0)
    assert.equal(reader.bytes, onDisk)
    assert.ok(onDisk > Buffer.byteLength(JSON.stringify('session-A')), 'the fingerprint contributed bytes')

    // Anything that is neither shape is still refused as corruption.
    const stray = path.join(reader.directory, 'notes.txt')
    fs.writeFileSync(stray, 'hello')
    assert.match(sessionIgnoreLoadError(new SessionIgnoreSet(root)) ?? '', /capture is disabled/)
    fs.rmSync(stray)
    assert.equal(sessionIgnoreLoadError(new SessionIgnoreSet(root)), undefined)

    // And a fingerprint whose content is not a uuid list is corruption too: a
    // fingerprint that cannot be read is a fork that would be recorded.
    const fingerprint = path.join(reader.directory, fingerprintNameFor('session-A'))
    fs.writeFileSync(fingerprint, '{"not":"a list"}')
    assert.match(sessionIgnoreLoadError(new SessionIgnoreSet(root)) ?? '', /capture is disabled/)
  } finally { cleanup(root) }
})

test('unignore removes the marker and the fingerprint', () => {
  const root = tempRoot()
  try {
    const set = new SessionIgnoreSet(root)
    set.add('session-A')
    writeSessionForkFingerprint(root, 'session-A', [uuidAt(1)])
    assert.equal(hasSessionIgnoreMarker(root, 'session-A'), true)
    assert.equal(hasSessionForkFingerprint(root), true)

    assert.equal(set.delete('session-A'), true)

    assert.equal(hasSessionIgnoreMarker(root, 'session-A'), false)
    assert.equal(hasSessionForkFingerprint(root), false)
    assert.deepEqual(fs.readdirSync(set.directory), [])
    assert.equal(set.bytes, 0, 'the removed fingerprint gave its bytes back to the ceiling')
    assert.equal(sessionForkFingerprintMatches(root, [uuidAt(1)]), false)
  } finally { cleanup(root) }
})

test('any one shared uuid matches, an unrelated transcript does not, and a fork of a fork still matches', () => {
  const root = tempRoot()
  try {
    new SessionIgnoreSet(root).add('session-A')
    const parentHead = [uuidAt(1), uuidAt(2), uuidAt(3), uuidAt(4)]
    writeSessionForkFingerprint(root, 'session-A', parentHead)

    // The fork copies the parent's lines verbatim, so every head uuid matches.
    assert.equal(sessionForkFingerprintMatches(root, parentHead), true)
    // One survivor is enough: a build that prepends a line to the copy, or a
    // head that drifted, still matches on whatever it kept.
    assert.equal(sessionForkFingerprintMatches(root, [uuidAt(91), uuidAt(92), uuidAt(3)]), true)
    // A fork of the fork inherits the same heads, with no record of its own.
    assert.equal(sessionForkFingerprintMatches(root, [uuidAt(1), uuidAt(2), uuidAt(93)]), true)

    // The direction that must never fire: an unrelated session. Wrongly
    // ignoring one destroys capture silently.
    assert.equal(sessionForkFingerprintMatches(root, [uuidAt(81), uuidAt(82)]), false)
    assert.equal(sessionForkFingerprintMatches(root, []), false)
  } finally { cleanup(root) }
})

test('a fingerprint holds uuids only, bounded in count', () => {
  const root = tempRoot()
  try {
    new SessionIgnoreSet(root).add('session-A')
    const many = Array.from({ length: 40 }, (_, i) => uuidAt(i))
    writeSessionForkFingerprint(root, 'session-A', many)
    const stored = JSON.parse(fs.readFileSync(
      path.join(root, 'session-ignores', fingerprintNameFor('session-A')), 'utf8'
    ))
    assert.equal(stored.length, FORK_FINGERPRINT_UUIDS)
    assert.deepEqual(stored, many.slice(0, FORK_FINGERPRINT_UUIDS))

    // Anything that is not a uuid - a prompt, a path, a short or structured
    // token - is dropped rather than written into the privacy store. The last
    // two matter beyond hygiene: a value that is not 122 bits of randomness
    // would match every stored fingerprint at once, and the any-match rule
    // reads a shared value as proof of a copied conversation.
    assert.equal(
      writeSessionForkFingerprint(root, 'session-B', [
        'write me a poem about ducks', '', 'x', 'msg_01ABCDEFGH', 'session-start', '/Users/me/repo',
      ]),
      false
    )
    assert.equal(fs.existsSync(path.join(root, 'session-ignores', fingerprintNameFor('session-B'))), false)
  } finally { cleanup(root) }
})

test('a fingerprint is refused rather than pushing the store past the ceiling it loads under', () => {
  const root = tempRoot()
  try {
    const set = new SessionIgnoreSet(root)
    set.add('session-A')
    // Overshooting would not merely lose fork protection: the next load would
    // refuse the whole store, and capture stops everywhere.
    fs.writeFileSync(path.join(set.directory, 'pad'), Buffer.alloc(4 * 1024 * 1024))
    assert.equal(writeSessionForkFingerprint(root, 'session-A', [uuidAt(1)]), false)
    assert.equal(fs.existsSync(path.join(set.directory, fingerprintNameFor('session-A'))), false)
    assert.equal(set.has('session-A'), true, 'and the exclusion itself is untouched')
  } finally { cleanup(root) }
})

test('transcript head uuids are read in order, past malformed lines, and never past the file', () => {
  const root = tempRoot()
  try {
    const file = path.join(root, 'transcript.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ sessionId: 'A', uuid: uuidAt(1), message: 'private text' }),
      'not json at all',
      JSON.stringify({ sessionId: 'A', message: 'no uuid here' }),
      JSON.stringify({ sessionId: 'A', uuid: uuidAt(2) }),
    ].join('\n') + '\n')
    assert.deepEqual(readTranscriptHeadUuids(file), [uuidAt(1), uuidAt(2)])
    assert.deepEqual(readTranscriptHeadUuids(file, 1), [uuidAt(1)])
    assert.deepEqual(readTranscriptHeadUuids(path.join(root, 'missing.jsonl')), [])
    assert.deepEqual(readTranscriptHeadUuids(''), [])
  } finally { cleanup(root) }
})

test('the session-context channel names the transcript of an id, and nothing for an id it never saw', () => {
  const root = tempRoot()
  try {
    const stateRoot = path.join(root, 'hypaware')
    const channel = claudeSessionContextFile(stateRoot)
    fs.mkdirSync(path.dirname(channel), { recursive: true })
    fs.writeFileSync(channel, [
      JSON.stringify({ session_id: 'A', cwd: '/repo', transcript_path: '/t/old-A.jsonl' }),
      JSON.stringify({ session_id: 'B', cwd: '/repo', transcript_path: '/t/B.jsonl' }),
      JSON.stringify({ session_id: 'A', cwd: '/repo', transcript_path: '/t/A.jsonl' }),
    ].join('\n') + '\n')

    assert.equal(claudeTranscriptPathForSession(stateRoot, 'A'), '/t/A.jsonl', 'newest record wins')
    assert.equal(claudeTranscriptPathForSession(stateRoot, 'B'), '/t/B.jsonl')
    assert.equal(claudeTranscriptPathForSession(stateRoot, 'codex-container'), undefined)
    assert.equal(claudeTranscriptPathForSession(path.join(root, 'nowhere'), 'A'), undefined)
  } finally { cleanup(root) }
})

/** A transcript line uuid, in the shape Claude actually writes. @param {number} n */
function uuidAt(n) {
  return `0000000a-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** @param {string} id */
function fingerprintNameFor(id) {
  return `${createHash('sha256').update(JSON.stringify(id)).digest('hex')}.fingerprint.json`
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fork-fingerprint-'))
}

/** @param {string} root */
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true })
}
