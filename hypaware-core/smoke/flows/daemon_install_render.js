// @ts-check

import path from 'node:path'

import { installObservability } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import {
  LAUNCH_LABEL,
  SYSTEMD_UNIT_BASE,
  defaultLogDir,
  defaultPlistDir,
  defaultUnitDir,
  plistFileName,
  unitFileName,
} from '../../../src/core/daemon/platform.js'
import { renderDaemonInstall } from '../../../src/core/daemon/install.js'

/**
 * Phase 4 smoke. Verifies that the daemon installer renders the
 * platform service files correctly for both macOS (LaunchAgent plist)
 * and Linux (systemd user unit) without touching `launchctl`,
 * `systemctl`, or `~/Library/LaunchAgents`.
 *
 * Asserts the §Phase 4 contract from `finish-v1.md`:
 *
 * - macOS plist render includes the configured binary path, config
 *   path, log paths, label, and foreground daemon command.
 * - Linux unit render includes the configured binary path, config
 *   path, restart policy, and foreground daemon command.
 * - Rendered service files do NOT reference `collectivus`.
 * - `hyp daemon install --dry-run --json` emits a JSON envelope
 *   matching the same plan.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'daemon_install_render: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const binPath = '/usr/local/bin/hypaware'
  const configPath = `${harness.hypHome}/hypaware-config.json`
  const nodePath = '/usr/local/bin/node'
  const homeDir = harness.hypHome

  // ----- macOS plist render -----
  const macosPlan = renderDaemonInstall({
    platform: 'darwin',
    binPath,
    configPath,
    nodePath,
    homeDir,
  })
  const macosContent = macosPlan.content

  expect.that(
    'macos: platform field set to darwin',
    macosPlan.platform,
    (v) => v === 'darwin'
  )
  expect.that(
    'macos: target path is <home>/Library/LaunchAgents/<label>.plist',
    macosPlan.targetPath,
    (v) => v === path.join(defaultPlistDir(homeDir), plistFileName(LAUNCH_LABEL))
  )
  expect.that(
    `macos: plist content includes label '${LAUNCH_LABEL}'`,
    macosContent,
    (v) => v.includes(`<string>${LAUNCH_LABEL}</string>`)
  )
  expect.that(
    'macos: plist content includes configured node path',
    macosContent,
    (v) => v.includes(`<string>${nodePath}</string>`)
  )
  expect.that(
    'macos: plist content includes configured bin path',
    macosContent,
    (v) => v.includes(`<string>${binPath}</string>`)
  )
  expect.that(
    'macos: plist content includes the foreground daemon command',
    macosContent,
    (v) =>
      v.includes('<string>daemon</string>') &&
      v.includes('<string>run</string>') &&
      v.includes('<string>--foreground</string>')
  )
  expect.that(
    'macos: plist content includes --config <path> sequence',
    macosContent,
    (v) =>
      v.includes('<string>--config</string>') &&
      v.includes(`<string>${configPath}</string>`)
  )
  expect.that(
    'macos: plist content includes RunAtLoad=true',
    macosContent,
    (v) => /<key>RunAtLoad<\/key>\s*<true\/>/.test(v)
  )
  expect.that(
    'macos: plist content includes KeepAlive=true',
    macosContent,
    (v) => /<key>KeepAlive<\/key>\s*<true\/>/.test(v)
  )
  const expectedMacosLogDir = defaultLogDir(homeDir)
  expect.that(
    'macos: plist content includes stdout log path under ~/.hyp/hypaware/logs',
    macosContent,
    (v) => v.includes(`<string>${path.join(expectedMacosLogDir, 'daemon.out.log')}</string>`)
  )
  expect.that(
    'macos: plist content includes stderr log path under ~/.hyp/hypaware/logs',
    macosContent,
    (v) => v.includes(`<string>${path.join(expectedMacosLogDir, 'daemon.err.log')}</string>`)
  )
  expect.that(
    'macos: plist content does not reference collectivus',
    macosContent.toLowerCase(),
    (v) => !v.includes('collectivus')
  )

  // ----- Linux unit render -----
  const linuxPlan = renderDaemonInstall({
    platform: 'linux',
    binPath,
    configPath,
    nodePath,
    homeDir,
  })
  const linuxContent = linuxPlan.content

  expect.that(
    'linux: platform field set to linux',
    linuxPlan.platform,
    (v) => v === 'linux'
  )
  expect.that(
    'linux: target path is <home>/.config/systemd/user/hypaware.service',
    linuxPlan.targetPath,
    (v) => v === path.join(defaultUnitDir(homeDir), unitFileName(SYSTEMD_UNIT_BASE))
  )
  expect.that(
    'linux: unit file name uses the short systemd base (hypaware.service)',
    linuxPlan.targetPath,
    (v) => v.endsWith(`/hypaware.service`)
  )
  expect.that(
    'linux: unit content includes the configured node path',
    linuxContent,
    (v) => v.includes(nodePath)
  )
  expect.that(
    'linux: unit content includes the configured bin path',
    linuxContent,
    (v) => v.includes(binPath)
  )
  expect.that(
    'linux: unit ExecStart calls `daemon run --foreground --config <path>`',
    linuxContent,
    (v) =>
      /^ExecStart=.* daemon run --foreground --config /m.test(v) &&
      v.includes(configPath)
  )
  expect.that(
    'linux: unit content sets Restart=always',
    linuxContent,
    (v) => /^Restart=always$/m.test(v)
  )
  expect.that(
    'linux: unit content sets RestartSec',
    linuxContent,
    (v) => /^RestartSec=\d+$/m.test(v)
  )
  expect.that(
    'linux: unit content writes stdout to ~/.hyp/hypaware/logs/daemon.out.log',
    linuxContent,
    (v) => v.includes(`StandardOutput=append:${path.join(defaultLogDir(homeDir), 'daemon.out.log')}`)
  )
  expect.that(
    'linux: unit content writes stderr to ~/.hyp/hypaware/logs/daemon.err.log',
    linuxContent,
    (v) => v.includes(`StandardError=append:${path.join(defaultLogDir(homeDir), 'daemon.err.log')}`)
  )
  expect.that(
    'linux: unit content does not reference collectivus',
    linuxContent.toLowerCase(),
    (v) => !v.includes('collectivus')
  )

  // ----- Unsupported platform -----
  let unsupportedError
  try {
    renderDaemonInstall({
      platform: 'win32',
      binPath,
      configPath,
      nodePath,
      homeDir,
    })
  } catch (err) {
    unsupportedError = err
  }
  expect.that(
    'unsupported platform: render throws DaemonInstallError',
    unsupportedError instanceof Error && /unsupported platform/.test(unsupportedError.message),
    (v) => v === true
  )

  // ----- `hyp daemon install --dry-run --json` -----
  const stdout = makeBuf()
  const stderr = makeBuf()
  const exit = await dispatch(
    [
      'daemon', 'install',
      '--dry-run', '--json',
      '--bin', binPath,
      '--config', configPath,
      '--platform', 'darwin',
    ],
    { stdout, stderr }
  )
  expect.that('dispatch: daemon install --dry-run --json exited 0', exit, (v) => v === 0)
  const dryRunJson = stdout.findJsonObject((obj) =>
    typeof obj?.content === 'string' && typeof obj?.targetPath === 'string'
  )
  expect.that(
    'dispatch: dry-run JSON output contains content + targetPath',
    dryRunJson,
    (v) => v !== undefined
  )
  expect.that(
    'dispatch: dry-run JSON platform=darwin (via --platform flag)',
    dryRunJson?.platform,
    (v) => v === 'darwin'
  )
  expect.that(
    'dispatch: dry-run JSON content does not mention collectivus',
    typeof dryRunJson?.content === 'string'
      ? dryRunJson.content.toLowerCase()
      : '',
    (v) => v.length > 0 && !v.includes('collectivus')
  )
  expect.that(
    'dispatch: dry-run JSON manageCommands include launchctl bootstrap/bootout/kickstart/print',
    JSON.stringify(dryRunJson?.manageCommands ?? []),
    (v) =>
      v.includes('bootstrap') &&
      v.includes('bootout') &&
      v.includes('kickstart') &&
      v.includes('print')
  )

  await obs.shutdown()
}

/**
 * Tiny WriteStream that captures chunks for later inspection.
 */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
    /**
     * @param {(value: any) => boolean} predicate
     */
    findJsonObject(predicate) {
      const text = chunks.join('')
      let depth = 0
      let start = -1
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '{') {
          if (depth === 0) start = i
          depth += 1
        } else if (ch === '}') {
          depth -= 1
          if (depth === 0 && start !== -1) {
            const slice = text.slice(start, i + 1)
            try {
              const parsed = JSON.parse(slice)
              if (predicate(parsed)) return parsed
            } catch {
              /* keep scanning */
            }
            start = -1
          }
        }
      }
      return undefined
    },
  }
}
