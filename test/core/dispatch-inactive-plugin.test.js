// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'

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
    name: '@hypaware/context-graph',
    commands: [
      { name: 'graph project', summary: 'Project the activity graph' },
      { name: 'graph neighbors', summary: 'Walk the activity graph' },
    ],
  })
  // Effective config does NOT enable the plugin, so `graph` never registers.
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['graph'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(
    stderr.text(),
    /^hyp: 'graph' is provided by @hypaware\/context-graph, which is not in the active config$/m
  )
  // Byte-exact: the repair line is the LLP 0098-pinned wording (issue #294),
  // so any drift in the exact phrasing must fail this test rather than slip
  // past a prefix/regex match.
  const repairLine = stderr
    .text()
    .split('\n')
    .find((line) => line.startsWith('  repair:'))
  assert.equal(repairLine, `  repair: add {"name": "@hypaware/context-graph"} to plugins[] in ${configPath}`)
  // It must NOT fall back to the generic message.
  assert.equal(stderr.text().includes('unknown command'), false)
})

test('dispatch miss on a genuine typo still gets the generic unknown-command message', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-dispatch-typo-'))
  const workspaceDir = path.join(hypHome, 'bundled-workspace')
  await stageBundledPlugin({
    workspaceDir,
    name: '@hypaware/context-graph',
    commands: [{ name: 'graph project', summary: 'Project the activity graph' }],
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
    name: '@hypaware/context-graph',
    commands: [{ name: 'graph project', summary: 'Project the activity graph' }],
  })
  // The entry EXISTS in plugins[] but is disabled, so it lands in the boot pool
  // yet is not selected. The repair must say to flip it, not add a duplicate.
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(
    configPath,
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/context-graph', enabled: false }] })
  )

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['graph'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.equal(stdout.text(), '')
  assert.match(
    stderr.text(),
    /^hyp: 'graph' is provided by @hypaware\/context-graph, which is not in the active config$/m
  )
  assert.match(
    stderr.text(),
    /^ {2}repair: set "enabled": true on the \{"name": "@hypaware\/context-graph"\} entry in plugins\[\] in /m
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
    name: '@hypaware/context-graph',
    commands: [{ name: 'graph project', summary: 'Project the activity graph' }],
  })
  // The fleet (central) layer disables the plugin. The whole central document
  // wins and locks, so a local add-back is dropped (collides_with_central):
  // the user cannot enable it locally (LLP 0031).
  const controlDir = path.join(hypHome, 'hypaware', 'config-control')
  await fs.mkdir(controlDir, { recursive: true })
  await fs.writeFile(
    path.join(controlDir, 'seed.json'),
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/context-graph', enabled: false }] })
  )
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['graph'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 2)
  assert.match(
    stderr.text(),
    /^hyp: 'graph' is provided by @hypaware\/context-graph, which is not in the active config$/m
  )
  assert.match(
    stderr.text(),
    /^ {2}repair: @hypaware\/context-graph is disabled by the fleet \(central\) config and cannot be enabled locally; ask your fleet admin to enable it$/m
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
    name: '@hypaware/context-graph',
    commands: [{ name: 'graph project', summary: 'Project the activity graph' }],
    activateBody: [
      "  ctx.commands.register({",
      "    name: 'graph project',",
      "    plugin: '@hypaware/context-graph',",
      "    summary: 'Project the activity graph',",
      "    usage: 'hyp graph project',",
      "    run: async () => 0,",
      "  })",
    ].join('\n'),
  })
  // Effective config enables the plugin, so `graph project` registers and the
  // `graph` group resolves to synthesized group help.
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(
    configPath,
    JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/context-graph' }] })
  )

  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['graph'], {
    stdout,
    stderr,
    workspaceDir,
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath },
  })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.match(stdout.text(), /usage: hyp graph <subcommand>/)
  assert.match(stdout.text(), /project\s+Project the activity graph/)
  assert.equal(stdout.text().includes('not in the active config'), false)
})
