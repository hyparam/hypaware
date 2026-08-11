// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { renderStatusSummary } from '../../src/core/commands/status.js'

// The default `hyp status` screen (LLP 0212): a triage summary, not an
// inventory. These drive `renderStatusSummary` directly - it is pure, and the
// collector's own behaviour is covered by the sibling status-*.test.js files.
//
// Every assertion here is about one of two things: that a conditional fact
// appears exactly when it is true, and that a fact the summary elides is
// genuinely absent rather than half-rendered.
//
// @ref LLP 0212#rows [tests]: the four rows and what each carries
// @ref LLP 0212#never-silent [tests]: a mandated fact is rendered when it is true

/**
 * A healthy, unenrolled, quiet install. Tests override the fields they are
 * about, so each one reads as its own delta from "nothing interesting".
 *
 * @param {Partial<import('../../src/core/daemon/types.js').HypAwareStatusReport>} [over]
 * @returns {import('../../src/core/daemon/types.js').HypAwareStatusReport}
 */
function makeReport(over = {}) {
  return /** @type {any} */ ({
    configPath: '/tmp/hyp/hypaware-config.json',
    configExists: true,
    configValid: true,
    activePlugins: ['@hypaware/ai-gateway', '@hypaware/claude'],
    layered: null,
    daemon: { installed: true, loaded: true, running: true, state: 'healthy', pid: 4242, mode: 'service', platform: 'darwin' },
    sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started' }],
    sinks: [{ instance: 'local', plugin: '@hypaware/local-fs', kind: 'blob' }],
    clients: [{ name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true }],
    clientSync: null,
    retention: { days: 120, source: 'default' },
    cache: { totalBytes: 847360677, oldestDate: '2026-05-01' },
    recentErrorCount: 0,
    diagnostics: [],
    overall: 'healthy',
    remoteConfig: null,
    clientActions: null,
    usagePolicy: { localOnlyDirCount: 0, folderAsk: 'sync' },
    firstSyncHoldDeadline: null,
    recentEntrypoints: [
      { entrypoint: 'cli', clientName: 'claude', lastSeen: '2026-08-11T11:58:00.000Z', rows: 1978 },
    ],
    ...over,
  })
}

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * Rendered wide enough that nothing wraps, so a content assertion is about
 * the content. Wrapping has its own tests below.
 *
 * @param {Partial<import('../../src/core/daemon/types.js').HypAwareStatusReport>} [over]
 * @param {number} [columns]
 * @returns {string}
 */
function render(over, columns = 200) {
  const stdout = /** @type {any} */ (makeBuf())
  stdout.columns = columns
  renderStatusSummary({
    report: makeReport(over),
    stdout,
    env: { NO_COLOR: '1' },
    nowMs: Date.parse('2026-08-11T12:00:00.000Z'),
  })
  return stdout.text()
}

test('the healthy screen is four rows, a frame, and a pointer to the rest', () => {
  const text = render()
  const lines = text.split('\n').filter((l) => l.trim() !== '')

  // Frame, four rows, footer. Anything more means a section crept back in.
  assert.equal(lines.length, 8, text)
  assert.match(text, /HypAware\s+healthy/)
  assert.match(text, /daemon\s+running \(service, pid 4242\)/)
  assert.match(text, /capture\s+Claude\s+│/)
  assert.match(text, /activity\s+claude\/cli 2m ago · 1,978 rows/)
  assert.match(text, /data\s+808 MB · 120-day retention · stays on this machine/)
  assert.match(text, /hyp status --full/)

  // The inventory is gone, not relocated.
  assert.doesNotMatch(text, /active plugins/)
  assert.doesNotMatch(text, /@hypaware\//)
  assert.doesNotMatch(text, /hypaware-config\.json/)
  assert.doesNotMatch(text, /847360677/)
  assert.doesNotMatch(text, /datasets/)
})

test('a healthy screen has no attention section at all', () => {
  assert.doesNotMatch(render(), /warning|error|note/)
})

test('a client that is enabled but not attached is marked once, and repaired once', () => {
  const text = render({
    clients: [
      /** @type {any} */ ({ name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true }),
      /** @type {any} */ ({ name: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: true, attached: false }),
    ],
    diagnostics: [
      /** @type {any} */ ({
        severity: 'warning',
        kind: 'client_attach_missing',
        message: "'@hypaware/claude-desktop' is enabled but claude-desktop settings show no HypAware marker",
        repair: ['hyp claude-desktop install'],
      }),
    ],
  })

  assert.match(text, /capture\s+Claude, Claude Desktop \(not attached\)/)
  assert.match(text, /warning\s+'@hypaware\/claude-desktop' is enabled but/)
  assert.match(text, /→ hyp claude-desktop install/)
  // Once as a capture mark, once as a diagnostic, and the repair command once.
  assert.equal(text.match(/claude-desktop/g)?.length, 3)
  // The kind is a --json/--full identifier, not a sentence.
  assert.doesNotMatch(text, /client_attach_missing/)
})

test('an enrolled machine says rows leave, and names a client held back', () => {
  const text = render({
    layered: /** @type {any} */ ({ hasCentral: true, centralPlugins: [], centralSinks: [], drops: [], centralQueryIgnored: false }),
    clients: [
      /** @type {any} */ ({ name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true }),
      /** @type {any} */ ({ name: 'codex', plugin: '@hypaware/codex', configured: true, attached: true }),
    ],
    clientSync: { syncing: ['claude'], localOnly: ['codex'] },
  })
  assert.match(text, /data\s+808 MB · 120-day retention · syncing to org/)
  assert.match(text, /capture\s+Claude, Codex \(local only\)/)
})

test('an unenrolled machine states the local claim rather than omitting it', () => {
  assert.match(render(), /stays on this machine/)
})

test('withheld folders and a non-default folder ask ride the data row', () => {
  const text = render({ usagePolicy: { localOnlyDirCount: 3, folderAsk: 'ask' } })
  assert.match(text, /3 folders withheld/)
  assert.match(text, /asking about new folders/)
  // The default mode departs from nothing, so it says nothing.
  assert.doesNotMatch(render(), /new folders/)
  assert.doesNotMatch(render(), /withheld/)
})

test('an install that has recorded nothing says so on the activity row', () => {
  assert.match(render({ recentEntrypoints: [] }), /activity\s+nothing recorded yet/)
})

test('the activity row caps at three surfaces and totals the rest', () => {
  const at = (/** @type {string} */ iso) => iso
  const text = render({
    recentEntrypoints: /** @type {any} */ ([
      { entrypoint: 'cli', clientName: 'claude', lastSeen: at('2026-08-11T11:59:30.000Z'), rows: 10 },
      { entrypoint: 'codex-tui', clientName: 'codex', lastSeen: at('2026-08-11T11:00:00.000Z'), rows: 20 },
      { entrypoint: 'Codex Desktop', clientName: 'codex', lastSeen: at('2026-08-10T12:00:00.000Z'), rows: 30 },
      { entrypoint: 'local-agent', clientName: null, lastSeen: at('2026-08-01T12:00:00.000Z'), rows: 40 },
    ]),
  })
  assert.match(text, /claude\/cli just now · codex\/codex-tui 1h ago · codex\/Codex Desktop 1d ago · \+1 more · 100 rows/)
})

test('a stopped daemon is named on its row and given a start command', () => {
  const text = render({
    daemon: /** @type {any} */ ({ installed: true, loaded: true, running: false, platform: 'darwin' }),
  })
  assert.match(text, /daemon\s+installed, not running/)
  assert.match(text, /warning\s+the daemon is not running, so nothing is being recorded/)
  assert.match(text, /→ hyp daemon start/)
})

test('a never-installed daemon is repaired with install, not start', () => {
  const text = render({
    daemon: /** @type {any} */ ({ installed: false, loaded: false, running: false, platform: 'linux' }),
  })
  assert.match(text, /daemon\s+not installed/)
  assert.match(text, /→ hyp daemon install/)
})

test('refused and failed client actions are loud; pending and done are not', () => {
  const text = render({
    clientActions: /** @type {any} */ ({
      actions: [
        { kind: 'attach', requestKey: 'claude', state: 'done', at: '2026-08-11T10:00:00.000Z' },
        { kind: 'backfill', requestKey: '@hypaware/codex', state: 'pending' },
        { kind: 'attach', requestKey: 'claude-desktop', state: 'refused', reason: 'settings file is JSONC' },
        { kind: 'backfill', requestKey: '@hypaware/hermes', state: 'failed', reason: 'timeout' },
      ],
    }),
  })
  assert.match(text, /warning\s+attach claude-desktop refused: settings file is JSONC/)
  assert.match(text, /→ hyp attach claude-desktop after fixing the cause/)
  assert.match(text, /warning\s+backfill @hypaware\/hermes failed: timeout/)
  assert.doesNotMatch(text, /pending/)
  assert.doesNotMatch(text, /done/)
})

// A collision drop says a duplicate declaration lost a merge. It must not
// read as "the plugin is off" - the commonest collision is the gateway,
// without which nothing is recorded at all.
test('a collision names who configures the entry now, and is a note, not a warning', () => {
  const text = render({
    layered: /** @type {any} */ ({
      hasCentral: true,
      centralPlugins: [],
      centralSinks: [],
      centralQueryIgnored: true,
      drops: [{ section: 'plugins', key: '@hypaware/ai-gateway', reason: 'collides_with_central' }],
    }),
  })
  assert.match(text, /note\s+@hypaware\/ai-gateway is configured by your org, so your local plugins entry for it is ignored/)
  assert.match(text, /note\s+the central config's query block is ignored/)
  assert.doesNotMatch(text, /not applied/)
})

test('an invalid-merge drop keeps saying it was dropped, and why', () => {
  const text = render({
    layered: /** @type {any} */ ({
      hasCentral: true,
      centralPlugins: [],
      centralSinks: [],
      centralQueryIgnored: false,
      drops: [{ section: 'sinks', key: 'extra', reason: 'invalid_merge', detail: 'capability_ambiguous' }],
    }),
  })
  assert.match(text, /note\s+your local sinks entry extra was dropped \(capability ambiguous\)/)
})

test('a live first-sync hold names its deadline and both ways out', () => {
  const text = render({ firstSyncHoldDeadline: Date.parse('2026-08-12T12:00:00.000Z') })
  assert.match(text, /note\s+first sync is held until/)
  assert.match(text, /hypaware-privacy skill, or hyp sync/)
})

test('errors sort above warnings, which sort above notes', () => {
  const text = render({
    overall: 'degraded',
    diagnostics: /** @type {any} */ ([
      { severity: 'warning', kind: 'client_attach_missing', message: 'a warning', repair: [] },
      { severity: 'error', kind: 'config_invalid', message: 'an error', repair: ['hyp config validate'] },
    ]),
    layered: /** @type {any} */ ({
      hasCentral: true, centralPlugins: [], centralSinks: [], centralQueryIgnored: false,
      drops: [{ section: 'plugins', key: 'x', reason: 'collides_with_central' }],
    }),
  })
  const order = ['an error', 'a warning', 'is ignored'].map((s) => text.indexOf(s))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), text)
  assert.match(text, /HypAware\s+degraded/)
})

test('sources that are not clients are captured too, and the gateway is not a source', () => {
  const text = render({
    clients: [/** @type {any} */ ({ name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true })],
    sources: /** @type {any} */ ([
      { name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started' },
      { name: 'hermes', plugin: '@hypaware/hermes', state: 'started' },
      { name: 'otel', plugin: '@hypaware/otel', state: 'error' },
    ]),
  })
  assert.match(text, /capture\s+Claude, Hermes, Otel \(error\)/)
  assert.doesNotMatch(text, /ai-gateway/)
})

test('an install with nothing configured says so rather than rendering an empty row', () => {
  assert.match(render({ clients: [], sources: [] }), /capture\s+nothing configured yet/)
})

// The frame is only a rectangle if the content was wrapped before it was
// drawn: the terminal's own wrap happens after the right edge is placed, so
// a too-long row turns the box into a staircase rather than a taller box.
// @ref LLP 0212#rows [tests]: the summary lays itself out to the terminal it is printed on

test('no line exceeds the terminal width, at any terminal width', () => {
  const report = makeReport({
    clients: /** @type {any} */ ([
      { name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true },
      { name: 'codex', plugin: '@hypaware/codex', configured: true, attached: true },
      { name: 'openclaw', plugin: '@hypaware/openclaw', configured: true, attached: true },
      { name: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: true, attached: false },
    ]),
    diagnostics: /** @type {any} */ ([{
      severity: 'warning',
      kind: 'client_attach_missing',
      message: "'@hypaware/claude-desktop' is enabled but claude-desktop settings show no HypAware marker",
      repair: ['hyp claude-desktop install'],
    }]),
  })

  for (let columns = 20; columns <= 200; columns++) {
    const stdout = /** @type {any} */ (makeBuf())
    stdout.columns = columns
    renderStatusSummary({ report, stdout, env: { NO_COLOR: '1' } })
    const over = stdout.text().split('\n').filter((/** @type {string} */ l) => l.length > columns)
    assert.deepEqual(over, [], `columns=${columns}`)
  }
})

test('a wrapped row hangs under its own value, not under the label', () => {
  const text = render({
    clients: /** @type {any} */ ([
      { name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true },
      { name: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: true, attached: false },
    ]),
  }, 44)
  assert.match(text, /│ capture {3}Claude, Claude Desktop \(not\s+│/)
  // The continuation sits in the value column, under `Claude`, not under
  // `capture`: same 10-column gutter, blank.
  assert.match(text, /│ {11}attached\)\s+│/)
})

test('a wrapped attention line hangs under the message, not under the severity', () => {
  const text = render({
    diagnostics: /** @type {any} */ ([{
      severity: 'warning',
      kind: 'client_attach_missing',
      message: 'claude-desktop settings show no HypAware marker anywhere at all',
      repair: ['hyp claude-desktop install'],
    }]),
  }, 44)
  const lines = text.split('\n').filter((l) => l.includes('marker') || l.includes('→'))
  for (const line of lines) assert.match(line, /^ {11}\S/)
})

test('the frame is dropped, not broken, on a terminal too narrow to hold it', () => {
  const stdout = /** @type {any} */ (makeBuf())
  stdout.columns = 30
  renderStatusSummary({ report: makeReport(), stdout, env: { NO_COLOR: '1' } })
  const text = stdout.text()
  assert.doesNotMatch(text, /[╭╮╰╯│]/)
  assert.match(text, /HypAware\s+healthy/)
})

test('a stream that will not say its width is laid out for 80, not for infinity', () => {
  const stdout = makeBuf()
  renderStatusSummary({
    report: makeReport({
      clients: /** @type {any} */ ([
        { name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true },
        { name: 'codex', plugin: '@hypaware/codex', configured: true, attached: true },
        { name: 'openclaw', plugin: '@hypaware/openclaw', configured: true, attached: true },
        { name: 'claude-desktop', plugin: '@hypaware/claude-desktop', configured: true, attached: false },
      ]),
    }),
    stdout,
    env: { NO_COLOR: '1' },
  })
  for (const line of stdout.text().split('\n')) assert.ok(line.length <= 80, line)
})

test('COLUMNS is honoured when the stream itself does not report a width', () => {
  const stdout = makeBuf()
  renderStatusSummary({ report: makeReport(), stdout, env: { NO_COLOR: '1', COLUMNS: '46' } })
  for (const line of stdout.text().split('\n')) assert.ok(line.length <= 46, line)
})

test('colour is opt-in on a TTY and never the only encoding of severity', () => {
  const plain = /** @type {any} */ (makeBuf())
  renderStatusSummary({ report: makeReport(), stdout: plain, env: {} })
  assert.doesNotMatch(plain.text(), /\x1b\[/)

  const tty = /** @type {any} */ (makeBuf())
  tty.isTTY = true
  renderStatusSummary({
    report: makeReport({
      overall: 'degraded',
      diagnostics: /** @type {any} */ ([{ severity: 'error', kind: 'config_invalid', message: 'an error', repair: [] }]),
    }),
    stdout: tty,
    env: {},
  })
  assert.match(tty.text(), /\x1b\[/)
  // The word survives the escapes being stripped, which is the point.
  assert.match(tty.text().replace(/\x1b\[[0-9;]*m/g, ''), /error\s+an error/)
})
