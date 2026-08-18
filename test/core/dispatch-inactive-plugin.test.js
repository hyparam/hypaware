// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'

/**
 * The exemplar here is `@hypaware/gascity`, and it should stay a plugin that
 * is genuinely opt-in (the `V1_EXCLUDED_FROM_DEFAULT` set).
 *
 * It used to be `@hypaware/context-graph`. These tests stage their own
 * synthetic plugin, so they passed either way, but LLP 0213 composes the
 * graph into every gateway install: an example built on it would teach the
 * reader that the graph is the thing you probably do not have, which is now
 * exactly backwards. Please do not move it back.
 *
 * @ref LLP 0213#consequences [constrained-by]: the graph stops being a usable example of an inactive plugin
 */

/**
 * Stage a bundled plugin under `workspaceDir` whose manifest declares the
 * given commands. The entrypoint is a trivial `activate` unless `activateBody`
 * is provided (used to register commands so the plugin is dispatchable when it
 * is active). Mirrors the shape `discoverBundledPlugins` walks.
 *
 * @param {{ workspaceDir: string, name: string, commands: { name: string, summary: string }[], activateBody?: string }} args
 */
async function stageBundledPlugin({ workspaceDir, name, commands, activateBody }) {
  const dir = path.join(workspaceDir, name.replace(/^@hypaware\//, ''))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '0.0.1',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
      contributes: { commands },
    })
  )
  const body = activateBody ?? ''
  await fs.writeFile(path.join(dir, 'index.js'), `export async function activate(ctx) {\n${body}\n}\n`)
}

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

test('dispatch miss on an inactive bundled plugin command reports unavailable + repair, not unknown', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-inactive-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [
      { name: 'gascity attach', summary: 'Attach the gascity subscriber' },
      { name: 'gascity status', summary: 'Show gascity subscriber status' },
    ],
  })
  // Effective config does NOT enable the plugin, so `gascity` never registers.
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['gascity'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(
    stderr.text(),
    /^hyp: 'gascity' is provided by @hypaware\/gascity, which is not in the active config$/m
  )
  // Byte-exact: the repair line is the LLP 0153-pinned wording (issue #294),
  // so any drift in the exact phrasing must fail this test rather than slip
  // past a prefix/regex match.
  const repairLine = stderr
    .text()
    .split('\n')
    .find((line) => line.startsWith('  repair:'))
  assert.equal(repairLine, `  repair: add {"name": "@hypaware/gascity"} to plugins[] in ${configPath}`)
  // It must NOT fall back to the generic message.
  assert.equal(stderr.text().includes('unknown command'), false)
})

test('dispatch miss on a genuine typo still gets the generic unknown-command message', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-typo-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [{ name: 'gascity attach', summary: 'Attach the gascity subscriber' }],
  })
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['grahp'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(stderr.text(), /^hyp: unknown command 'grahp'$/m)
  assert.match(stderr.text(), /run 'hyp --help' for the list of available commands/)
  assert.equal(stderr.text().includes('provided by'), false)
  assert.equal(stderr.text().includes('repair:'), false)
})

test('dispatch miss on a plugin present-but-disabled in the local config advises enabling it, not adding it', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-disabled-local-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [{ name: 'gascity attach', summary: 'Attach the gascity subscriber' }],
  })
  // The entry EXISTS in plugins[] but is disabled, so it lands in the boot pool
  // yet is not selected. The repair must say to flip it, not add a duplicate.
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(
    configPath,
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/gascity', enabled: false }] })
  )

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['gascity'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(
    stderr.text(),
    /^hyp: 'gascity' is provided by @hypaware\/gascity, which is not in the active config$/m
  )
  assert.match(
    stderr.text(),
    /^ {2}repair: set "enabled": true on the \{"name": "@hypaware\/gascity"\} entry in plugins\[\] in /m
  )
  assert.match(stderr.text(), new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // It must NOT tell the user to add an entry that already exists.
  assert.equal(stderr.text().includes('add {"name"'), false)
  assert.equal(stderr.text().includes('unknown command'), false)
})

test('dispatch miss on a plugin disabled by the central layer says it cannot be enabled locally', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-disabled-central-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [{ name: 'gascity attach', summary: 'Attach the gascity subscriber' }],
  })
  // The fleet (central) layer disables the plugin. The whole central document
  // wins and locks, so a local add-back is dropped (collides_with_central):
  // the user cannot enable it locally (LLP 0031).
  const controlDir = path.join(hypHome, 'hypaware', 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  await fs.writeFile(
    path.join(controlDir, 'seed.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/gascity', enabled: false }] })
  )
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['gascity'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.match(
    stderr.text(),
    /^hyp: 'gascity' is provided by @hypaware\/gascity, which is not in the active config$/m
  )
  assert.match(
    stderr.text(),
    /^ {2}repair: @hypaware\/gascity is disabled by the organization \(central\) config and cannot be enabled locally; ask your administrator to enable it$/m
  )
  // Neither the add-entry nor the local-enable advice should appear.
  assert.equal(stderr.text().includes('add {"name"'), false)
  assert.equal(stderr.text().includes('set "enabled": true'), false)
  assert.equal(stderr.text().includes('unknown command'), false)
})

test('a command whose plugin IS active is unaffected (renders group help, no availability error)', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-active-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [{ name: 'gascity attach', summary: 'Attach the gascity subscriber' }],
    activateBody: [
      "  ctx.commands.register({",
      "    name: 'gascity attach',",
      "    plugin: '@hypaware/gascity',",
      "    summary: 'Attach the gascity subscriber',",
      "    usage: 'hyp gascity attach',",
      "    run: async () => 0,",
      "  })",
    ].join('\n'),
  })
  // Effective config enables the plugin, so `gascity attach` registers and the
  // `gascity` group resolves to synthesized group help.
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(
    configPath,
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/gascity' }] })
  )

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['gascity'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.match(stdout.text(), /usage: hyp gascity <subcommand>/)
  assert.match(stdout.text(), /attach\s+Attach the gascity subscriber/)
  assert.equal(stdout.text().includes('not in the active config'), false)
})

// `session` is core-registered as a task group (LLP 0248) but every one of its
// subcommands is contributed by @hypaware/ai-gateway. When that plugin is
// inactive the group shell still matches, so the miss path is never reached
// and the user got an empty subcommand table (exit 0) or an `expected one of:`
// with nothing after it (exit 2) instead of the plugin name and the repair.
// @ref LLP 0153#unavailable-not-unknown [tests]: a core group emptied by an inactive plugin reports unavailable by every spelling
test('a core group whose subcommands all come from an inactive plugin reports unavailable, not an empty table', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-empty-group-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/ai-gateway',
    commands: [
      { name: 'session ignore', summary: 'Stop recording this session' },
      { name: 'session status', summary: 'Report this session opt-out state' },
    ],
  })
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))

  for (const argv of [['session'], ['session', 'ignore'], ['session', 'zzz-not-a-subcommand'], ['session', '--help']]) {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(argv, {
      stdout,
      stderr,
      workspaceDir,
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
    })

    assert.equal(code, 2, `hyp ${argv.join(' ')} exited ${code}`)
    assert.equal(stdout.text(), '', `hyp ${argv.join(' ')} wrote to stdout`)
    assert.match(
      stderr.text(),
      /^hyp: 'session' is provided by @hypaware\/ai-gateway, which is not in the active config$/m
    )
    assert.ok(
      stderr.text().includes(`  repair: add {"name": "@hypaware/ai-gateway"} to plugins[] in ${configPath}`),
      `hyp ${argv.join(' ')} omits the repair line`
    )
    assert.equal(stderr.text().includes('expected one of: \n'), false)
  }
})

test('dispatch miss on a selected plugin whose activate() threw reports unavailable, not unknown', async () => {
  // The config already names the plugin, so LLP 0153's "add it to plugins[]"
  // repair is wrong and LLP 0154's "flip enabled" repair is wrong too. Before
  // this case existed the command fell all the way through to "unknown
  // command", telling the user a feature they configured does not exist.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-activate-threw-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/gascity',
    commands: [{ name: 'gascity attach', summary: 'Attach the gascity subscriber' }],
    activateBody: `  throw new Error('activation is broken on purpose')`,
  })
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/gascity' }] }))

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['gascity'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.match(
    stderr.text(),
    /^hyp: 'gascity' is provided by @hypaware\/gascity, which your config selects but this run could not activate$/m
  )
  const repairLine = stderr
    .text()
    .split('\n')
    .find((line) => line.startsWith('  repair:'))
  assert.equal(
    repairLine,
    `  repair: the plugin is configured but unavailable this run; run 'hyp status' for why, then re-run this command`
  )
  assert.equal(stderr.text().includes('unknown command'), false)
  // Neither config repair applies: the entry is already there and enabled.
  assert.equal(stderr.text().includes('add {"name"'), false)
  assert.equal(stderr.text().includes('"enabled": true'), false)
})
