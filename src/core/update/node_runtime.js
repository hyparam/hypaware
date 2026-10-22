// @ts-check

import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { withFileLock } from '../util/file_lock.js'
import { APPLICATION_NODE_RANGE } from './node_version.js'
export { APPLICATION_NODE_RANGE, supportsApplicationNode } from './node_version.js'

/**
 * @import { CommandRunner } from '../../../src/core/cli/types.js'
 * @import { NodeRuntimeArtifact, NodeRuntimeOptions } from '../../../src/core/update/types.js'
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 25_000

// @ref LLP 0555#verified-installation [implements]: hashes were authenticated against Node's signed SHASUMS256 manifests, signing key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
const RELEASES = {
  '22.23.4': {
    'darwin-arm64': 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
    'darwin-x64': 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
    'linux-arm64': 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
    'linux-x64': 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  },
  '24.22.1': {
    'darwin-arm64': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    'darwin-x64': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
    'linux-arm64': '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
    'linux-x64': 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  },
  '26.12.1': {
    'darwin-arm64': '1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8',
    'darwin-x64': 'b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff',
    'linux-arm64': 'a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f',
    'linux-x64': '0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132',
  },
}

/** @param {string} version @param {string} platform @param {string} arch @returns {NodeRuntimeArtifact} */
export function selectNodeArtifact(version, platform, arch) {
  const major = version.split('.')[0]
  const target = major === '22' ? '22.23.4' : major === '26' ? '26.12.1' : '24.22.1'
  const sha256 = RELEASES[target][`${platform}-${arch}`]
  if (!sha256) throw new Error(`node_runtime.unsupported_platform: install patched Node.js manually for ${platform}/${arch}`)
  return { version: target, platform, arch, filename: `node-v${target}-${platform}-${arch}.tar.gz`, sha256 }
}

/** @param {NodeJS.ProcessEnv} [env] */
export function nodeRuntimePaths(env = process.env) {
  const hypHome = env.HYP_HOME || path.join(env.HOME || os.homedir(), '.hyp')
  const root = path.join(hypHome, 'hypaware', 'runtime')
  return { root, versions: path.join(root, 'versions'), nodePath: path.join(root, 'node') }
}

/** @param {string} value */
function realpathOrSelf(value) {
  try { return fs.realpathSync(value) } catch { return path.resolve(value) }
}

/** @param {NodeJS.ProcessEnv} [env] @param {string} [nodePath] */
export function managedNodeForProcess(env = process.env, nodePath = process.execPath) {
  const paths = nodeRuntimePaths(env)
  const relative = path.relative(realpathOrSelf(paths.versions), realpathOrSelf(nodePath))
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  try {
    return fs.realpathSync(paths.nodePath) === fs.realpathSync(nodePath) ? paths.nodePath : undefined
  } catch { return undefined }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [packageRoot]
 * @param {string} [nodePath]
 * @ref LLP 0555#daemon-handover [implements]: keep npm updates at the original global package, rather than installing into the private Node distribution
 */
export function nodeRuntimeEnvironment(env, packageRoot = PACKAGE_ROOT, nodePath = process.execPath) {
  const resolved = realpathOrSelf(nodePath)
  const nodeBin = path.dirname(resolved)
  const parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  let next = parts[0] === nodeBin ? env : { ...env, PATH: [nodeBin, ...parts.filter(p => p !== nodeBin)].join(path.delimiter) }
  const managed = /^node-v\d+\.\d+\.\d+-(darwin|linux)-(arm64|x64)[/\\]bin[/\\]node$/.test(path.relative(realpathOrSelf(nodeRuntimePaths(env).versions), resolved))
  if (managed &&
      path.basename(path.dirname(packageRoot)) === 'node_modules' &&
      path.basename(path.dirname(path.dirname(packageRoot))) === 'lib') {
    next = { ...next, npm_config_prefix: path.dirname(path.dirname(path.dirname(packageRoot))) }
    delete next.NPM_CONFIG_PREFIX
  }
  return next
}

/** @param {string} directory */
async function privateDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const st = await fsp.lstat(directory)
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022)) {
    throw new Error('node_runtime.unsafe_directory: runtime storage must be a private directory')
  }
}

/** @param {string} directory @param {NodeRuntimeArtifact} artifact */
async function verifiedDirectory(directory, artifact) {
  try {
    const markerPath = path.join(directory, 'archive.sha256')
    const [dir, bin, executable, markerStat] = await Promise.all([
      fsp.lstat(directory), fsp.lstat(path.join(directory, 'bin')), fsp.lstat(path.join(directory, 'bin', 'node')),
      fsp.lstat(markerPath),
    ])
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size !== 64) return false
    const marker = await fsp.readFile(markerPath, 'utf8')
    return dir.isDirectory() && !dir.isSymbolicLink() && bin.isDirectory() && !bin.isSymbolicLink() && executable.isFile() &&
      !executable.isSymbolicLink() && (executable.mode & 0o111) !== 0 && marker === artifact.sha256
  } catch { return false }
}

/** @param {NodeRuntimeArtifact} artifact @param {string} destination */
async function downloadNode(artifact, destination) {
  await new Promise((resolve, reject) => {
    // Raw https never feeds Content-Encoding through Node's vulnerable Brotli decoder.
    const request = https.get(`https://nodejs.org/dist/v${artifact.version}/${artifact.filename}`, {
      headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    }, response => {
      if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy()
        reject(new Error(`node_runtime.download_failed: unexpected HTTP response ${response.statusCode}`))
        return
      }
      let bytes = 0
      const budget = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > MAX_ARCHIVE_BYTES ? new Error('node_runtime.archive_too_large') : null, chunk)
      } })
      pipeline(response, budget, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })).then(resolve, reject)
    })
    request.once('error', reject)
  })
}

/** @type {CommandRunner} */
export function runNodeRuntimeCommand(command, args, opts) {
  return new Promise(resolve => {
    execFile(command, args, {
      env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs ?? 15_000,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr }))
  })
}

/** @param {string} executable @param {NodeRuntimeArtifact} artifact @param {CommandRunner} run @param {NodeJS.ProcessEnv} env */
async function probeNode(executable, artifact, run, env) {
  const probe = await run(executable, ['--input-type=module', '-e',
    'import zlib from "node:zlib"\nconsole.log(JSON.stringify({ version: process.versions.node, patched: Number.isInteger(zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH) }))',
  ], { env: { ...env, NODE_OPTIONS: '' }, timeoutMs: 5000 })
  let result
  try { result = JSON.parse(probe.stdout) } catch { /* invalid executable */ }
  if (probe.exitCode !== 0 || result?.version !== artifact.version || result?.patched !== true) {
    throw new Error('node_runtime.preflight_failed: the downloaded Node executable could not prove its version and security patch')
  }
}

/** @param {NodeRuntimeOptions} [opts] */
// @ref LLP 0555#verified-installation [implements]: verify before extraction, serialize publication, atomically switch the stable interpreter
export async function ensureNodeRuntime(opts = {}) {
  const env = opts.env ?? process.env
  const artifact = opts.artifact ?? selectNodeArtifact(opts.version ?? process.versions.node, opts.platform ?? process.platform, opts.arch ?? process.arch)
  if (!/^node-v\d+\.\d+\.\d+-(darwin|linux)-(x64|arm64)\.tar\.gz$/.test(artifact.filename) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('node_runtime.invalid_artifact')
  }
  const paths = nodeRuntimePaths(env)
  const directory = path.join(paths.versions, artifact.filename.slice(0, -7))
  const log = opts.log ?? (() => {})
  const run = opts.run ?? runNodeRuntimeCommand
  await privateDirectory(paths.root)
  await privateDirectory(paths.versions)
  return withFileLock(path.join(paths.root, 'install.lock'), async () => {
    if (!await verifiedDirectory(directory, artifact)) {
      const staging = await fsp.mkdtemp(path.join(paths.root, 'install-'))
      try {
        const archive = path.join(staging, 'node.tar.gz')
        log('node_runtime.downloading', { version: artifact.version, platform: artifact.platform, arch: artifact.arch })
        await (opts.download ?? downloadNode)(artifact, archive)
        const archiveStat = await fsp.lstat(archive)
        if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error('node_runtime.invalid_archive')
        const digest = crypto.createHash('sha256')
        await pipeline(fs.createReadStream(archive), digest)
        if (digest.digest('hex') !== artifact.sha256) throw new Error('node_runtime.checksum_mismatch: refusing to extract or execute the download')
        const extracted = path.join(staging, 'extracted')
        await fsp.mkdir(extracted, { mode: 0o700 })
        const untar = await run('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted], { env, timeoutMs: 15_000 })
        if (untar.exitCode !== 0) throw new Error('node_runtime.extract_failed: could not extract the verified Node release')
        await probeNode(path.join(extracted, 'bin', 'node'), artifact, run, env)
        await fsp.writeFile(path.join(extracted, 'archive.sha256'), artifact.sha256, { mode: 0o600 })
        // A crashed or incomplete distribution is never executable through the active link.
        await fsp.rm(directory, { recursive: true, force: true })
        await fsp.rename(extracted, directory)
        log('node_runtime.verified', { version: artifact.version })
      } finally { await fsp.rm(staging, { recursive: true, force: true }) }
    }
    let previous
    try { previous = await fsp.readlink(paths.nodePath) } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new Error('node_runtime.unsafe_pointer')
    }
    const target = path.join(directory, 'bin', 'node')
    if (previous !== path.relative(paths.root, target)) {
      const temporary = path.join(paths.root, `node-${crypto.randomUUID()}`)
      try {
        await fsp.symlink(path.relative(paths.root, target), temporary)
        await fsp.rename(temporary, paths.nodePath)
      } finally { await fsp.rm(temporary, { force: true }) }
    }
    try {
      const keep = new Set([directory, previous ? path.resolve(paths.root, previous, '..', '..') : directory])
      for (const entry of await fsp.readdir(paths.versions, { withFileTypes: true })) {
        const candidate = path.join(paths.versions, entry.name)
        if (/^node-v\d+\.\d+\.\d+-(darwin|linux)-(x64|arm64)$/.test(entry.name) && !keep.has(candidate)) {
          await fsp.rm(candidate, { recursive: true, force: true })
        }
      }
      for (const entry of await fsp.readdir(paths.root, { withFileTypes: true })) {
        if (!entry.name.startsWith('install-')) continue
        const candidate = path.join(paths.root, entry.name)
        if (Date.now() - (await fsp.lstat(candidate)).mtimeMs > 120_000) await fsp.rm(candidate, { recursive: true, force: true })
      }
    } catch { log('node_runtime.cleanup_deferred', { status: 'deferred' }) }
    return { nodePath: paths.nodePath, version: artifact.version }
  }, { onWait: () => log('node_runtime.waiting', { version: artifact.version }) })
}

/** @param {{ argv: string[], binPath: string, env?: NodeJS.ProcessEnv }} opts */
export async function bootstrapNodeRuntime(opts) {
  const env = opts.env ?? process.env
  const log = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => process.stderr.write(`${event} ${JSON.stringify(fields)}\n`)
  const { detectSupervisor, readLocalConfigAutoUpdate, readSelfUpdateState } = await import('./self_update.js')
  const daemon = opts.argv[0] === 'daemon' && opts.argv[1] === 'run'
  const supervised = daemon && detectSupervisor(env)
  if (supervised) {
    const paths = nodeRuntimePaths(env)
    const configIndex = opts.argv.indexOf('--config')
    const configPath = configIndex < 0 ? opts.argv.find(a => a.startsWith('--config='))?.slice(9) : opts.argv[configIndex + 1]
    const stateRoot = path.dirname(paths.root)
    if ((readSelfUpdateState(stateRoot).auto_update ?? readLocalConfigAutoUpdate({ stateRoot, env, configPath })) === false) {
      throw new Error(`node_runtime.update_disabled: auto_update is false; install Node.js ${APPLICATION_NODE_RANGE} and reinstall the daemon`)
    }
  }
  const prepared = await ensureNodeRuntime({ env, log })
  const childEnv = nodeRuntimeEnvironment(env, PACKAGE_ROOT, prepared.nodePath)
  if (supervised) {
    const { handOverNodeRuntime } = await import('./node_runtime_handover.js')
    try {
      const code = await handOverNodeRuntime({ nodePath: prepared.nodePath, binPath: opts.binPath, oldNodePath: process.execPath, env: childEnv, log })
      if (code !== undefined) return code
    } catch {
      log('node_runtime.handover_deferred', { status: 'deferred', error_kind: 'service_handover_failed' })
    }
  }
  log('node_runtime.reexec', { version: prepared.version })
  const child = spawn(prepared.nodePath, [...process.execArgv, opts.binPath, ...opts.argv], { env: childEnv, stdio: 'inherit' })
  const signals = /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])
  const handlers = signals.map(signal => [signal, () => child.kill(signal)])
  for (const [signal, handler] of handlers) process.on(/** @type {NodeJS.Signals} */ (signal), /** @type {() => void} */ (handler))
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? 128 + (signal ? os.constants.signals[signal] : 0)))
    })
  } finally {
    for (const [signal, handler] of handlers) process.off(/** @type {NodeJS.Signals} */ (signal), /** @type {() => void} */ (handler))
  }
}
