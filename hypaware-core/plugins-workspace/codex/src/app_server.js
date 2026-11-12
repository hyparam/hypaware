// @ts-check

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * One bounded native app-server session, also used by the installed-client
 * acceptance check. Never answer native tool requests. Model turns are only
 * started by the acceptance check against its local synthetic provider.
 * @param {string} binary
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, overrides?: string[], onNotification?: (notification: any) => void }} options
 * @param {(request: (method: string, params: object) => Promise<any>) => Promise<any>} check
 */
export async function withCodexServer(binary, options, check) {
  const child = spawn(binary, [...(options.overrides ?? []), 'app-server'], {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  const lines = createInterface({ input: child.stdout })
  // Native diagnostics may include settings. Drain without copying them into
  // repair logs or errors, which must never contain credentials or chat text.
  child.stderr.resume()
  let bytes = 0
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 16 * 1024 * 1024) {
      pending?.reject(new Error('Codex app-server response budget exceeded'))
      child.kill('SIGTERM')
    }
  })
  let id = 0
  let failure
  let pending
  child.on('error', () => {
    failure = new Error('Codex app server could not start')
    pending?.reject(failure)
  })
  child.on('exit', () => {
    failure = new Error('Codex app server exited before completing the check')
    pending?.reject(failure)
  })
  lines.on('line', line => {
    try {
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('response budget')
      const response = JSON.parse(line)
      if (response.method && response.id !== undefined) throw new Error('unexpected native request')
      if (response.method && response.id === undefined) options.onNotification?.(response)
      if (response.id === pending?.id) pending.resolve(response)
    } catch {
      pending?.reject(new Error('Invalid Codex app-server response'))
    }
  })
  /** @param {string} method @param {object} params */
  async function request(method, params) {
    if (failure) throw failure
    let timer
    try {
      return await new Promise((resolve, reject) => {
        pending = { id: ++id, resolve, reject }
        timer = setTimeout(() => reject(new Error('Codex app-server request timed out')), 15_000)
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    } finally {
      clearTimeout(timer)
      pending = undefined
    }
  }
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'hypaware_provider_repair', version: '1' },
      capabilities: { experimentalApi: true },
    })
    if (initialized.error) throw new Error('Codex app server rejected initialization')
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    return await check(request)
  } finally {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    await closed.finally(() => clearTimeout(timer))
    lines.close()
  }
}
