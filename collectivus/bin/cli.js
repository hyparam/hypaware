#!/usr/bin/env node

import process from 'node:process'

const SUBCOMMANDS = new Set(['install', 'uninstall', 'attach', 'detach', 'status', 'config', 'admin', 'invite', 'export', 'query', 'collect', 'rendezvous', 'join', 'skills', 'claude-hook', 'init', 'gascity', 'ignore'])

const argv = process.argv.slice(2)
const subcommand = argv[0]

const updateCheck = subcommand === 'claude-hook' ? Promise.resolve() : checkForUpdates()

main().then(
  async function(code) {
    await updateCheck
    process.exit(code)
  },
  async function(err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    await updateCheck
    process.exit(1)
  }
)

/**
 * Dispatch to a subcommand handler when the first argument matches one of the
 * installer commands; otherwise fall through to the long-running listener
 * lifecycle in `src/cli.js`.
 *
 * @returns {Promise<number>}
 */
async function main() {
  if (subcommand && SUBCOMMANDS.has(subcommand)) {
    const subArgs = argv.slice(1)
    const handler = await loadSubcommand(subcommand)
    return handler(subArgs)
  }
  const { run } = await import('../src/cli.js')
  return run(argv, process.env)
}

/**
 * @param {string} name
 * @returns {Promise<(args: string[]) => Promise<number>>}
 */
async function loadSubcommand(name) {
  switch (name) {
  case 'install': {
    const { runInstall } = await import('../src/cli/install.js')
    return runInstall
  }
  case 'uninstall': {
    const { runUninstall } = await import('../src/cli/uninstall.js')
    return runUninstall
  }
  case 'attach': {
    const { runAttach } = await import('../src/cli/attach.js')
    return runAttach
  }
  case 'detach': {
    const { runDetach } = await import('../src/cli/detach.js')
    return runDetach
  }
  case 'status': {
    const { runStatus } = await import('../src/cli/status.js')
    return runStatus
  }
  case 'config': {
    const { runConfig } = await import('../src/cli/config.js')
    return runConfig
  }
  case 'admin': {
    const { runAdmin } = await import('../src/cli/admin.js')
    return runAdmin
  }
  case 'invite': {
    const { runInvite } = await import('../src/cli/invite.js')
    return runInvite
  }
  case 'export': {
    const { runExport } = await import('../src/cli/export.js')
    return runExport
  }
  case 'query': {
    const { runQuery } = await import('../src/cli/query.js')
    return runQuery
  }
  case 'collect': {
    const { runCollect } = await import('../src/cli/collect.js')
    return runCollect
  }
  case 'rendezvous': {
    const { runRendezvous } = await import('../src/cli/rendezvous.js')
    return runRendezvous
  }
  case 'join': {
    const { runJoin } = await import('../src/cli/join.js')
    return (args) => runJoin(args, process.env)
  }
  case 'skills': {
    const { runSkills } = await import('../src/cli/skills.js')
    return runSkills
  }
  case 'claude-hook': {
    const { runClaudeHook } = await import('../src/cli/claude-hook.js')
    return runClaudeHook
  }
  case 'init': {
    const { runInitSubcommand } = await import('../src/cli/init.js')
    return runInitSubcommand
  }
  case 'gascity': {
    const { runGascity } = await import('../src/cli/gascity.js')
    return runGascity
  }
  case 'ignore': {
    const { runIgnore } = await import('../src/cli/ignore.js')
    return runIgnore
  }
  default:
    throw new Error(`unknown subcommand: ${name}`)
  }
}

/**
 * Background check against the npm registry for a newer published version.
 * Prints a notice to stderr when one is available; never throws or rejects.
 *
 * @returns {Promise<void>}
 */
async function checkForUpdates() {
  try {
    const [{ readPackageVersion }, { fetchLatestVersion }] = await Promise.all([
      import('../src/cli/common.js'),
      import('../src/update.js'),
    ])
    const currentVersion = readPackageVersion()
    const latest = await fetchLatestVersion()
    if (latest && latest !== currentVersion) {
      process.stderr.write(
        `\x1b[33mA newer version of collectivus is available: ${latest} (current: ${currentVersion})\x1b[0m\n` +
        '\x1b[33mRun \'npm install -g collectivus\' to update\x1b[0m\n'
      )
    }
  } catch {
    // fail silently — update check is best-effort
  }
}
