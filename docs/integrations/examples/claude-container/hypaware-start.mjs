import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const home = process.env.HOME
if (!home) throw new Error('HOME must be set to a writable directory')
const state = process.env.HYP_HOME || `${home}/.hyp`
const config = `${state}/hypaware-config.json`
const joined = `${state}/.joined`
const appCommand = process.argv.slice(2)
if (!appCommand.length) throw new Error('Supply the application command after hypaware-start.mjs')
const readyFile = '/tmp/hypaware-app-ready'
let daemon
let app
let stopping = false

function launch(command, args, capture = false) {
  const child = spawn(command, args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    detached: true,
  })
  child.output = ''
  child.stdout?.on('data', chunk => { child.output += chunk })
  child.done = new Promise(resolve => {
    child.once('error', error => {
      console.error(`${command}: ${error.message}`)
      child.result = 1
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      child.result = code ?? 1
      resolve(child.result)
    })
  })
  return child
}

function signalGroup(child, signal) {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function command(args, timeout = 30000, capture = false) {
  const child = launch('hyp', args, capture)
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), timeout)
  try {
    const code = await child.done
    if (code !== 0) throw new Error(`hyp ${args[0]} exited ${code}`)
    return child.output
  } finally { clearTimeout(timer) }
}

async function stop(child, timeout) {
  if (!child) return
  signalGroup(child, 'SIGTERM')
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), timeout)
  try { await child.done } finally { clearTimeout(timer) }
  // Clean up any remaining children in this process group.
  signalGroup(child, 'SIGKILL')
}

async function shutdown(code) {
  if (stopping) return
  stopping = true
  if (existsSync(readyFile)) unlinkSync(readyFile)
  const deadline = setTimeout(() => process.exit(1), 55000)
  console.log('supervisor: draining app before upload')
  if (app) {
    // Signal only the HTTP server first. Its SDK subprocess must remain alive
    // while an in-flight request completes and exports its final telemetry.
    app.kill('SIGTERM')
    const timer = setTimeout(() => signalGroup(app, 'SIGKILL'), 30000)
    try { await app.done } finally { clearTimeout(timer) }
    console.log('supervisor: allowing final telemetry to settle')
    await delay(5000)
    signalGroup(app, 'SIGKILL')
  }
  try { await command(['sync', '--yes'], 15000) } catch (error) {
    console.error(`supervisor: final upload failed: ${error.message}`)
    code = 1
  }
  await stop(daemon, 5000)
  clearTimeout(deadline)
  console.log(`supervisor: stopped (${code})`)
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { void shutdown(0) })
}

function startDaemon() {
  daemon = launch('hyp', ['daemon', 'run'])
  daemon.done.then(code => {
    if (app && !stopping) {
      console.error(`supervisor: daemon exited ${code}; restarting container`)
      void shutdown(1)
    }
  })
}

async function main() {
  if (existsSync(readyFile)) unlinkSync(readyFile)
  if (!existsSync(config)) {
    await command(['setup', '--client', 'claude', '--export', 'keep-local', '--no-daemon', '--no-backfill', '--yes'], 60000)
  }
  if (stopping) return
  if (!existsSync(joined)) {
    await command(['join', process.env.HYP_JOIN_URL || 'https://api.hypaware.ai', '--token-file', '/var/run/hypaware/token', '--no-daemon'])
    writeFileSync(joined, 'joined\n')
  }
  if (stopping) return
  startDaemon()
  const deadline = Date.now() + 90000
  while (!stopping && Date.now() < deadline) {
    if (daemon.result !== undefined) {
      if (daemon.result !== 75) throw new Error(`daemon exited ${daemon.result}`)
      console.log('supervisor: restarting daemon after configuration update')
      startDaemon()
    }
    try {
      const current = daemon
      const status = JSON.parse(await command(['status', '--json'], 5000, true))
      if (current.result === undefined && status.daemon?.state === 'healthy' &&
          status.config_layers?.central &&
          status.client_attach?.some(c => c.name === 'claude' && c.recording) &&
          status.sources?.some(s => s.name === 'claude-telemetry' && s.state === 'started')) {
        if (stopping) return
        console.log('supervisor: capture ready; starting app')
        app = launch(appCommand[0], appCommand.slice(1))
        app.done.then(code => { if (!stopping) void shutdown(code || 1) })
        writeFileSync(readyFile, 'ready\n')
        return
      }
    } catch (error) {
      console.log(`supervisor: waiting for capture (${error.message})`)
    }
    await delay(1000)
  }
  if (!stopping) throw new Error('capture readiness timed out')
}

main().catch(error => {
  console.error(`supervisor: ${error.message}`)
  void shutdown(1)
})
