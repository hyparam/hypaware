// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { isLoopbackHost } from '../../src/core/util/loopback.js'
import { trackedFiles } from '../helpers/tracked_files.js'

// The one predicate behind three checks: the OTLP listener's `Host` guard,
// the self-updater's registry-override trust, and the AI gateway's CONNECT
// and absolute-form peer checks. These pin every spelling those three hand
// it, because each of them fails closed on a "no".

test('the loopback names and literals count, in the spellings the callers hand over', () => {
  assert.equal(isLoopbackHost('localhost'), true)
  // A `Host` header is caller-cased; a socket address and `URL` are not.
  assert.equal(isLoopbackHost('LocalHost'), true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('::1'), true)
  // `URL` keeps the brackets on an IPv6 literal; the other two callers do not.
  assert.equal(isLoopbackHost('[::1]'), true)
  // How a dual-stack listener reports an IPv4 peer.
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackHost('::FFFF:127.0.0.1'), true)
})

test('IPv4 loopback is the whole 127.0.0.0/8 block, mapped or not', () => {
  for (const host of ['127.0.0.0', '127.0.0.1', '127.0.0.2', '127.8.9.10', '127.255.255.255']) {
    assert.equal(isLoopbackHost(host), true, host)
    assert.equal(isLoopbackHost(`::ffff:${host}`), true, `::ffff:${host}`)
  }
})

test('a host that is not this machine is refused, including the names that only resolve here', () => {
  for (const host of [
    '192.168.1.50',
    '10.0.0.1',
    '::ffff:192.168.1.50',
    // The neighbours of the block, and a name that merely starts like one.
    '126.255.255.255',
    '128.0.0.1',
    '1270.0.0.1',
    '127.0.0.1.attacker.example',
    // RFC 6761 says a resolver must send these to loopback; glibc without
    // systemd-resolved asks DNS instead, so the name alone does not decide.
    'npm.localhost',
    'localhost.',
    'localhost.attacker.example',
    '::2',
    // The wildcard binds are not loopback: the OTLP listener answers to them
    // for its own reason, and does it beside this check rather than in it.
    '0.0.0.0',
    '::',
  ]) {
    assert.equal(isLoopbackHost(host), false, host)
  }
  assert.equal(isLoopbackHost(undefined), false)
  assert.equal(isLoopbackHost(''), false)
})

// Every caller hands over a hostname with the port already off: a `Host`
// header goes through `hostnameOfHostHeader`, `URL` exposes `hostname`, and a
// socket address never carries one. A port left on is not a loopback host,
// and reading one off here would be a second parser disagreeing with those.
test('a port left on the host is not read off it', () => {
  assert.equal(isLoopbackHost('127.0.0.1:4873'), false)
  assert.equal(isLoopbackHost('localhost:4873'), false)
  assert.equal(isLoopbackHost('[::1]:8443'), false)
})

// The one divergence the three predicates carried before they were merged.
test('the hex-serialized mapped form counts only for the caller that asks for it', () => {
  // Off a socket this form does not occur, and in a `Host` header it is a
  // literal no resolver can point elsewhere, so the default stays narrow.
  assert.equal(isLoopbackHost('::ffff:7f00:1'), false)
  assert.equal(isLoopbackHost('[::ffff:7f00:1]'), false)
  // What `URL` leaves `http://[::ffff:127.0.0.1]:4873` in, which is the only
  // form the self-updater ever sees a mapped-loopback registry written in.
  assert.equal(isLoopbackHost('[::ffff:7f00:1]', { hexMappedIpv4: true }), true)
  assert.equal(isLoopbackHost('::ffff:7f00:1', { hexMappedIpv4: true }), true)
  assert.equal(isLoopbackHost('[::ffff:7f01:203]', { hexMappedIpv4: true }), true)
  // Mapped is not a way off the machine: only 127.0.0.0/8 in a v6 coat
  // matches, and a short first group (`::ffff:7f:1` is 0.127.0.1) is not
  // 127-anything.
  for (const host of ['::ffff:808:808', '::ffff:c0a8:109', '::ffff:7eff:ffff', '::ffff:8000:1', '::ffff:7f:1', '::ffff:0:1']) {
    assert.equal(isLoopbackHost(host, { hexMappedIpv4: true }), false, host)
  }
  // The flag widens nothing else: it is an addition to the same set.
  assert.equal(isLoopbackHost('localhost', { hexMappedIpv4: true }), true)
  assert.equal(isLoopbackHost('::ffff:127.0.0.1', { hexMappedIpv4: true }), true)
  assert.equal(isLoopbackHost('192.168.1.50', { hexMappedIpv4: true }), false)
  assert.equal(isLoopbackHost(undefined, { hexMappedIpv4: true }), false)
  assert.equal(isLoopbackHost('::ffff:7f00:1', {}), false)
})

// Brackets are matched punctuation, not noise to be stripped off either end
// independently. `hostnameOfHostHeader` turns away a `Host` whose brackets are
// unbalanced *around a port*, but `Host: localhost]` has no port and no
// leading bracket, so it reaches this predicate whole. Answering it would have
// widened the OTLP guard that closed the DNS-rebinding hole: on the tree
// before this predicate existed, all four of these were refused with 421.
test('a stray bracket is part of the name, not punctuation to strip', () => {
  for (const host of ['localhost]', 'LOCALHOST]', '127.0.0.1]', '[[::1]', '[::1', '::1]', '[localhost', '[]']) {
    assert.equal(isLoopbackHost(host), false, host)
    assert.equal(isLoopbackHost(host, { hexMappedIpv4: true }), false, host)
  }
  // A matched pair still comes off, which is the form `URL` hands over.
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(isLoopbackHost('[127.0.0.1]'), true)
})

// The hex-mapped opt-in widens a check whose "no" is the whole barrier at
// three of the four call sites, and it is one argument away at each of them.
// Only the self-updater has a reason to pass it, and the reason is a `URL`
// re-serialization no socket and no `Host` header produces. A new caller is a
// decision to make on purpose, so it fails here first rather than silently.
test('only the self-updater asks for the hex-mapped form', () => {
  const root = path.resolve(import.meta.dirname, '..', '..')
  const sources = trackedFiles(root, new Set(['.js']))
    .filter(f => !f.startsWith('test/') && f !== 'src/core/util/loopback.js')
  const askers = sources.filter(f => fs.readFileSync(path.join(root, f), 'utf8').includes('hexMappedIpv4'))
  assert.deepEqual(askers, ['src/core/update/self_update.js'],
    'a new caller of the hex-mapped opt-in: read why it is off by default at src/core/util/loopback.js before adding one here')
})
