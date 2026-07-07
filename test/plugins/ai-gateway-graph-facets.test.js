// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLAUDE_BUILTIN_COMMANDS,
  commandStringFrom,
  PROGRAM_RE,
  programFrom,
  SKILL_NAME_RE,
  skillFromCodexRead,
  skillFromMarker,
  skillFromSlash,
  skillFromToolArgs,
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

  // MAJOR 2 fix: a wrapper's own option-with-arg must not have its *value*
  // mis-read as argv[0] (was: 'root', 'tmp', 'kill' respectively).
  ['sudo -u with a separate-token value consumes the pair', 'sudo -u root git status', 'git'],
  ['env -C with a separate-token value consumes the pair', 'env -C /tmp git', 'git'],
  ['timeout --signal with a separate-token value consumes the pair, then the numeric duration', 'timeout --signal KILL 5 git', 'git'],
  ['stdbuf -o with a separate-token value consumes the pair', 'stdbuf -o L grep x', 'grep'],
  ['nice -n with a separate-token value consumes the pair', 'nice -n 10 make', 'make'],
  // attached forms (no space) stay one token, need no pair-consumption
  ['sudo -u attached value', 'sudo -uroot git status', 'git'],
  ['env --chdir= attached value', 'env --chdir=/tmp git', 'git'],

  // fail-closed: an unrecognized flag shape for a known wrapper must not
  // have its value mis-read as argv[0] either — mint nothing rather than
  // guess (MAJOR 2, the general case beyond the specific enumerated forms).
  ['sudo with an unrecognized flag+value shape mints nothing', 'sudo -z VALUE git status', null],
  ['env with an unrecognized flag+value shape mints nothing', 'env -z VALUE git status', null],

  // `--` ends option parsing: the next token is argv[0], not an unrecognized
  // flag (round-2 regression fix — the fail-closed classifier would otherwise
  // drop these to nothing).
  ['sudo -- ends options, next token is argv[0]', 'sudo -- git status', 'git'],
  ['env -- ends options', 'env -- duckdb query.sql', 'duckdb'],

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

// --- skillFromToolArgs: LLP 0074 surface 1 (Skill tool call) ---

test('skillFromToolArgs reads tool_args.skill, parsed or as a JSON string', () => {
  assert.equal(skillFromToolArgs({ skill: 'hypaware-query' }), 'hypaware-query')
  assert.equal(skillFromToolArgs('{"skill":"deep-research"}'), 'deep-research')
  assert.equal(skillFromToolArgs({ skill: 'plugin:skill' }), 'plugin:skill', 'namespaced name kept verbatim')
})

test('skillFromToolArgs is null for missing/bad args or an un-gateable name', () => {
  assert.equal(skillFromToolArgs({}), null, 'skill absent')
  assert.equal(skillFromToolArgs({ skill: '' }), null, 'empty name')
  assert.equal(skillFromToolArgs({ skill: 42 }), null, 'non-string name')
  assert.equal(skillFromToolArgs({ skill: 'has space' }), null, 'fails SKILL_NAME_RE')
  assert.equal(skillFromToolArgs('{not json'), null, 'malformed JSON')
  assert.equal(skillFromToolArgs('"just a string"'), null, 'non-object JSON')
  assert.equal(skillFromToolArgs(null), null)
})

// --- skillFromMarker: LLP 0074 surface 2 (SKILL.md injection marker) ---

test('skillFromMarker takes the basename of the offset-0 base directory', () => {
  assert.equal(skillFromMarker('Base directory for this skill: /home/u/.claude/skills/hypaware-query'), 'hypaware-query')
  assert.equal(skillFromMarker('Base directory for this skill: /x/skills/report\n\nRest of the injected prose'), 'report', 'only the first line matters')
})

test('skillFromMarker trims a trailing slash and unwraps a SKILL.md file path', () => {
  assert.equal(skillFromMarker('Base directory for this skill: /x/skills/deep-research/'), 'deep-research')
  assert.equal(skillFromMarker('Base directory for this skill: /x/skills/deep-research/SKILL.md'), 'deep-research', 'a SKILL.md path names the skill by its parent dir')
})

// @ref LLP 0074#strict-filters [tests]: the offset-0 anchor is the whole
// false-positive defense; markers quoted mid-message mint nothing.
test('skillFromMarker rejects anything not anchored at offset 0', () => {
  assert.equal(skillFromMarker('I saw "Base directory for this skill: /x/skills/report" in the log'), null, 'mid-text marker (assistant quoting / echo)')
  assert.equal(skillFromMarker(' Base directory for this skill: /x/skills/report'), null, 'leading whitespace breaks the anchor')
  assert.equal(skillFromMarker('base directory for this skill: /x/skills/report'), null, 'case-sensitive prefix')
  assert.equal(skillFromMarker('Base directory for this skill:'), null, 'no path captured')
  assert.equal(skillFromMarker(null), null)
  assert.equal(skillFromMarker(42), null)
})

test('skillFromMarker fails closed on an un-gateable basename', () => {
  assert.equal(skillFromMarker('Base directory for this skill: /'), null, 'root path has no basename')
  assert.equal(skillFromMarker(`Base directory for this skill: /x/skills/${'a'.repeat(80)}`), null, 'over-long name fails SKILL_NAME_RE')
})

// @ref LLP 0073#boundedness-contract [tests]: MAJOR 1 regression — a base
// directory containing a space must not truncate the capture at the space
// (which previously mis-keyed on a path segment instead of the trailing
// skill-directory basename).
test('skillFromMarker resolves a base directory containing a space to the correct trailing basename', () => {
  assert.equal(
    skillFromMarker('Base directory for this skill: /Users/John Smith/.claude/skills/hypaware-query'),
    'hypaware-query',
    'a space in an earlier path segment no longer truncates the capture (was minting "John")'
  )
})

test('skillFromMarker still mints nothing for a marker not on the first line (anchor not loosened)', () => {
  assert.equal(
    skillFromMarker('preamble text\nBase directory for this skill: /Users/John Smith/.claude/skills/hypaware-query'),
    null,
    'the offset-0 anchor must stay a true string-start match, not "start of any line"'
  )
})

// --- skillFromSlash: LLP 0074 surface 3 (<command-name> tag) ---

test('skillFromSlash reads an offset-0 command tag, stripping a leading /', () => {
  assert.equal(skillFromSlash('<command-name>/hypaware-query</command-name>'), 'hypaware-query')
  assert.equal(skillFromSlash('<command-name>deep-research</command-name>'), 'deep-research', 'bare name (no slash) accepted')
  assert.equal(skillFromSlash('<command-name>/code-review:code-review</command-name>'), 'code-review:code-review', 'namespaced name kept')
  assert.equal(skillFromSlash('<command-name>/loop</command-name><command-args>5m</command-args>'), 'loop', 'trailing tags ignored')
})

// @ref LLP 0074#builtin-exclusion [tests]: a built-in slash is not a skill run.
test('skillFromSlash drops Claude Code built-in commands', () => {
  assert.equal(skillFromSlash('<command-name>/compact</command-name>'), null)
  assert.equal(skillFromSlash('<command-name>/model</command-name>'), null)
  assert.equal(skillFromSlash('<command-name>review</command-name>'), null, 'built-in without the leading slash is still excluded')
  for (const builtin of CLAUDE_BUILTIN_COMMANDS) {
    assert.equal(skillFromSlash(`<command-name>/${builtin}</command-name>`), null, `built-in /${builtin} mints nothing`)
  }
})

test('skillFromSlash rejects tags not anchored at offset 0 and malformed tags', () => {
  assert.equal(skillFromSlash('The user typed <command-name>/foo</command-name>'), null, 'mid-text tag')
  assert.equal(skillFromSlash(' <command-name>/foo</command-name>'), null, 'leading whitespace breaks the anchor')
  assert.equal(skillFromSlash('<command-name>/foo'), null, 'unterminated tag')
  assert.equal(skillFromSlash('<command-name></command-name>'), null, 'empty name')
  assert.equal(skillFromSlash('<command-name>/has space</command-name>'), null, 'name outside the tag charset')
  assert.equal(skillFromSlash(null), null)
})

// --- skillFromCodexRead: LLP 0075 (Codex exec_command SKILL.md read) ---

/** @type {Array<[string, string, string | null]>} */
const CODEX_SKILL_CASES = [
  // the recorded example (LLP 0075)
  ["sed of a user's home path (LLP 0075 example)", "sed -n '1,240p' /Users/alice/.codex/skills/hypaware-query/SKILL.md", 'hypaware-query'],
  ['bare read', 'cat /repo/.codex/skills/deep-research/SKILL.md', 'deep-research'],
  ['~-prefixed path', 'cat ~/.codex/skills/deep-research/SKILL.md', 'deep-research'],
  ['double-quoted path', 'cat "/Users/alice/.codex/skills/foo/SKILL.md"', 'foo'],
  ['single-quoted path', "sed -n '1,5p' '/Users/alice/.codex/skills/foo/SKILL.md'", 'foo'],
  ['namespaced skill name kept', 'cat /repo/.codex/skills/plugin:skill/SKILL.md', 'plugin:skill'],

  // other read tools also activate (MINOR 1: the gate is a read-tool set, not just `cat`)
  ['head is a read tool', 'head -c 500 /repo/.codex/skills/deep-research/SKILL.md', 'deep-research'],
  ['grep is a read tool', 'grep -n foo /repo/.codex/skills/deep-research/SKILL.md', 'deep-research'],

  // reject: not the `.codex/skills/…/SKILL.md` shape
  ['Claude path (.claude, not .codex) mints nothing', 'cat /repo/.claude/skills/foo/SKILL.md', null],
  ['not reading SKILL.md itself mints nothing', 'cat /repo/.codex/skills/foo/README.md', null],
  ['a bare directory listing (no SKILL.md) mints nothing', 'ls /repo/.codex/skills/foo', null],
  ['no .codex/skills path at all mints nothing', 'git status', null],
  ['name containing a space fails to close the match', 'cat /repo/.codex/skills/foo bar/SKILL.md', null],
  ['empty string mints nothing', '', null],

  // MINOR 1 fix: a non-read command merely naming the SKILL.md path is not
  // an activation (was: minting a spurious Skill node from path text alone).
  ['echo (non-read command) naming the path mints nothing', 'echo /repo/.codex/skills/foo/SKILL.md', null],
  ['rm (non-read command) naming the path mints nothing', 'rm /repo/.codex/skills/foo/SKILL.md', null],
]

for (const [name, command, expected] of CODEX_SKILL_CASES) {
  test(`skillFromCodexRead: ${name}`, () => {
    assert.equal(skillFromCodexRead(command), expected)
  })
}

test('skillFromCodexRead composes with commandStringFrom (the exec_command wire shape)', () => {
  const command = commandStringFrom('exec_command', { cmd: 'cat /repo/.codex/skills/hypaware-query/SKILL.md' })
  assert.equal(skillFromCodexRead(command), 'hypaware-query')
  // fallback `command` arg
  const fallback = commandStringFrom('exec_command', { command: 'cat /repo/.codex/skills/hypaware-query/SKILL.md' })
  assert.equal(skillFromCodexRead(fallback), 'hypaware-query')
  // a non-shell tool never resolves a command string, so this mints nothing
  // (restricting the surface to `exec_command` is the contract rule's SQL
  // filter's job, tested in ai-gateway-graph-contract.test.js).
  assert.equal(skillFromCodexRead(commandStringFrom('Read', { command: 'cat /repo/.codex/skills/x/SKILL.md' })), null, 'Read is not a shell tool')
})

test('skillFromCodexRead fails closed on an un-gateable captured name and non-string input', () => {
  assert.equal(skillFromCodexRead(`cat /repo/.codex/skills/${'a'.repeat(80)}/SKILL.md`), null, 'over-long name fails SKILL_NAME_RE')
  assert.equal(skillFromCodexRead(null), null)
  assert.equal(skillFromCodexRead(undefined), null)
  assert.equal(skillFromCodexRead(42), null)
})

// MINOR 2 (documented, not fixed): `CODEX_SKILL_READ_RE` requires exactly one
// segment between `skills/` and `/SKILL.md`, so a nested/system Codex skill
// dir layout mints nothing. We have no evidence such layouts exist in this
// fleet, and fail-closed (miss) is safer than widening into false-positives,
// so this is an accepted exclusion — @ref LLP 0075#decision: only
// single-segment `~/.codex/skills/<name>/SKILL.md` is in scope for surface 4.
test('skillFromCodexRead fails closed on nested/system skill directory layouts (accepted exclusion, not widened)', () => {
  assert.equal(
    skillFromCodexRead('cat /Users/alice/.codex/skills/.system/openai-docs/SKILL.md'),
    null,
    'a nested segment (.system/openai-docs) between skills/ and SKILL.md is out of scope'
  )
  assert.equal(
    skillFromCodexRead('cat /repo/.codex/plugins/foo/skills/bar/SKILL.md'),
    null,
    'a plugin-nested skills/ path is out of scope'
  )
})

test('SKILL_NAME_RE gates to a bounded verbatim-name domain', () => {
  assert.ok(SKILL_NAME_RE.test('hypaware-query'))
  assert.ok(SKILL_NAME_RE.test('plugin:skill'))
  assert.ok(SKILL_NAME_RE.test('llp_todo'))
  assert.ok(SKILL_NAME_RE.test('Skill'), 'case preserved (verbatim identity), so uppercase is legal')
  assert.ok(!SKILL_NAME_RE.test(''), 'empty rejected')
  assert.ok(!SKILL_NAME_RE.test('-leading-dash'), 'must start alphanumeric')
  assert.ok(!SKILL_NAME_RE.test('a b'), 'spaces rejected')
  assert.ok(!SKILL_NAME_RE.test('a/b'), 'path separator rejected')
  assert.ok(!SKILL_NAME_RE.test('a'.repeat(65)), 'over-long rejected')
  assert.ok(SKILL_NAME_RE.test('a'.repeat(64)), 'at the cap accepted')
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
