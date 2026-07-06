// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commandStringFrom,
  PROGRAM_RE,
  programFrom,
} from '../../hypaware-core/plugins-workspace/ai-gateway-graph/src/tool_facets.js'

// --- commandStringFrom: which arg holds the command string ---

test('commandStringFrom reads Bash.command and exec_command.cmd (fallback command)', () => {
  assert.equal(commandStringFrom('Bash', { command: 'git status' }), 'git status')
  // Codex wire shape this repo's fixtures pin: {"cmd": …}
  assert.equal(commandStringFrom('exec_command', { cmd: 'ls -la' }), 'ls -la')
  assert.equal(commandStringFrom('exec_command', { command: 'ls -la' }), 'ls -la', 'exec_command falls back to command')
  assert.equal(commandStringFrom('exec_command', { cmd: 'a', command: 'b' }), 'a', 'cmd wins over command')
})

test('commandStringFrom parses tool_args arriving as a JSON string', () => {
  assert.equal(commandStringFrom('Bash', '{"command":"npm test"}'), 'npm test')
  assert.equal(commandStringFrom('exec_command', '{"cmd":"duckdb"}'), 'duckdb')
})

test('commandStringFrom is null for non-shell tools, bad args, or a missing/non-string command', () => {
  assert.equal(commandStringFrom('Read', { command: 'git status' }), null, 'not a shell tool')
  assert.equal(commandStringFrom('Bash', { command: '' }), null, 'empty command')
  assert.equal(commandStringFrom('Bash', { notcommand: 'x' }), null, 'command absent')
  assert.equal(commandStringFrom('Bash', { command: 42 }), null, 'numeric command is not a command')
  assert.equal(commandStringFrom('Bash', '{not json'), null, 'malformed JSON')
  assert.equal(commandStringFrom('Bash', '"just a string"'), null, 'non-object JSON')
  assert.equal(commandStringFrom('Bash', null), null)
  assert.equal(commandStringFrom(null, { command: 'x' }), null, 'no tool name')
})

// --- programFrom: table-driven argv[0] extraction ---

/** @type {Array<[string, string, string | null]>} */
const CASES = [
  // plain first token
  ['bare command', 'git status', 'git'],
  ['single token', 'duckdb', 'duckdb'],

  // lowercasing + path basename converge
  ['absolute path is basenamed', '/opt/homebrew/bin/duckdb --version', 'duckdb'],
  ['relative path is basenamed', './scripts/build.sh', 'build.sh'],
  ['uppercase is lowercased', 'GIT status', 'git'],
  ['pathed + cased converge', '/usr/bin/DuckDB', 'duckdb'],

  // first-command-only: connectors take the head
  ['pipe takes the head', 'git log | head -5', 'git'],
  ['&& takes the head', 'cd /repo && npm test', 'cd'],
  ['|| takes the head', 'make || echo fail', 'make'],
  ['; takes the head', 'git add .; git commit', 'git'],
  ['newline takes the head', 'git status\nrm -rf /tmp/x', 'git'],
  ['single & (background) does not cut', 'git push &', 'git'],

  // quote-blind split is head-safe: a connector inside quotes only truncates
  // the discarded tail, never argv[0].
  ['quoted connector after argv[0] is head-safe', 'grep "a|b" file', 'grep'],

  // subshell paren
  ['leading subshell paren stripped', '(cd /x && git pull)', 'cd'],
  ['paren with no space stripped', '(git status)', 'git'],

  // env assignments skipped
  ['single env assignment skipped', 'FOO=bar git status', 'git'],
  ['multiple env assignments skipped', 'A=1 B=2 duckdb', 'duckdb'],

  // wrappers unwrapped
  ['sudo unwrapped', 'sudo git pull', 'git'],
  // The wrapper skip drops flags / env / bare numerics only (LLP 0073
  // §program-derivation); it deliberately does not parse flag *arguments* like
  // `-u root`, so a no-arg flag such as `-n` is the supported shape.
  ['sudo no-arg flag skipped', 'sudo -n git pull', 'git'],
  ['env wrapper + assignment skipped', 'env FOO=bar git status', 'git'],
  ['nohup unwrapped', 'nohup npm start', 'npm'],
  ['nice + numeric flag arg skipped', 'nice -n 10 make', 'make'],
  ['time keyword unwrapped', 'time git fetch', 'git'],
  ['command builtin unwrapped', 'command ls -la', 'ls'],
  ['stdbuf flags skipped', 'stdbuf -oL grep x', 'grep'],
  ['timeout numeric duration skipped', 'timeout 5 git fetch', 'git'],
  ['timeout suffix duration skipped', 'timeout 30s curl example.com', 'curl'],
  ['stacked wrappers unwrapped', 'sudo timeout 5 git pull', 'git'],
  ['wrapper of pathed program', 'sudo /usr/bin/env FOO=1 duckdb', 'duckdb'],

  // shell -c unwrap (Codex bash -lc "...")
  ['bash -lc unwraps the inner command', 'bash -lc "git commit -m x"', 'git'],
  ['sh -c unwraps', 'sh -c "npm run build"', 'npm'],
  ['zsh -c unwraps', 'zsh -c "duckdb foo.db"', 'duckdb'],
  ['bash -c single-quoted inner', "bash -c 'git status'", 'git'],
  ['inner command with its own connector takes head', 'bash -lc "git add . && git commit"', 'git'],
  ['inner command with a pipe takes head', 'bash -lc "cat f | grep x"', 'cat'],
  ['bash script.sh (no -c) keeps bash', 'bash script.sh', 'bash'],
  ['bash with no -c keeps bash', 'bash /path/to/run.sh', 'bash'],
  ['nested bash -lc unwraps to depth 2', 'bash -lc "bash -lc \'git push\'"', 'git'],

  // fail-closed: nothing bounded to key
  ['empty string mints nothing', '', null],
  ['whitespace mints nothing', '   ', null],
  ['all-numeric token mints nothing', '12345', null],
  ['token with a space char fails the gate', '"my program" x', null],
  ['token with illegal char fails the gate', 'weird!name', null],
  ['leading connector mints nothing', '| grep x', null],
]

for (const [name, command, expected] of CASES) {
  test(`programFrom: ${name}`, () => {
    assert.equal(programFrom(command), expected)
  })
}

test('programFrom rejects an over-long token (PROGRAM_RE cap)', () => {
  const long = 'a'.repeat(65) // first char + 64 more > the {0,63} tail cap
  assert.equal(programFrom(long), null)
  const atLimit = 'a'.repeat(64) // first char + 63 tail == the cap
  assert.equal(programFrom(atLimit), atLimit)
})

test('programFrom returns null for non-string / null input (from commandStringFrom)', () => {
  assert.equal(programFrom(null), null)
  assert.equal(programFrom(undefined), null)
  assert.equal(programFrom(42), null)
})

test('the depth cap stops shell -c recursion at 2 levels (keeps the innermost shell)', () => {
  // Three nested shells: 0 → 1 → 2 recurse; at depth 2 the shell is not
  // unwrapped again, so the third `bash` is argv[0].
  const triple = 'bash -lc "bash -lc \'bash -lc \\"git push\\"\'"'
  assert.equal(programFrom(triple), 'bash')
})

test('PROGRAM_RE gates to a bounded, lowercased basename domain', () => {
  assert.ok(PROGRAM_RE.test('git'))
  assert.ok(PROGRAM_RE.test('duckdb'))
  assert.ok(PROGRAM_RE.test('7z'))
  assert.ok(PROGRAM_RE.test('clang++'))
  assert.ok(PROGRAM_RE.test('python3.11'))
  assert.ok(!PROGRAM_RE.test('Git'), 'uppercase rejected (extraction lowercases first)')
  assert.ok(!PROGRAM_RE.test('a b'), 'spaces rejected')
  assert.ok(!PROGRAM_RE.test('a/b'), 'path separator rejected')
  assert.ok(!PROGRAM_RE.test(''), 'empty rejected')
})
