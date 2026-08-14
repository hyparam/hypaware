// @ts-check

import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  installObservability,
  runRoot,
  Attr,
} from '../../../src/core/observability/index.js'

/**
 * Phase 1 smoke. Verifies the package + CLI identity contract from
 * finish-v1.md §Phase 1:
 *
 * - `node ./bin/hypaware.js --help` exits 0 (no-arg help via flag).
 * - `node ./bin/hypaware.js smoke core_boot_noop` still passes (the
 *   internal developer path is preserved through the dispatcher).
 * - `npm pack --dry-run --json` ships the bundled assets the package
 *   needs at install time: `bin/hypaware.js`, `src/core/**`, plugin
 *   manifests, plugin source trees, skill assets, and the smoke
 *   harness.
 *
 * Subprocesses inherit the harness's `HYP_HOME` so their telemetry
 * lands in the same tmpdir we shut down here. We only assert against
 * exit codes and the pack manifest: the dispatched subprocess's
 * spans are exercised by their own smokes.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'package_bin_boot: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const binPath = path.join(repoRoot, 'bin', 'hypaware.js')

  await runRoot(
    'smoke.package_bin_boot',
    {
      [Attr.COMPONENT]: 'smoke',
      [Attr.OPERATION]: 'smoke.run',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'package_bin_boot',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    () => {
      const helpResult = spawnSync(
        process.execPath,
        [binPath, '--help'],
        { cwd: repoRoot, encoding: 'utf8', env: { ...process.env } }
      )
      expect.that(
        `hypaware --help exits 0 (got status=${helpResult.status}, stderr=${truncate(helpResult.stderr)})`,
        helpResult.status,
        (v) => v === 0
      )
      // The banner's marketing sentence is copy, not a contract this flow
      // owns; it changes with onboarding copy decisions (e.g. LLP 0211) and
      // no LLP pins it. Assert the usage line and a known command name
      // instead: those are what "the packaged binary boots and --help
      // works" actually means, and they survive a copy edit.
      expect.that(
        'hypaware --help prints the usage line',
        helpResult.stdout,
        (v) => typeof v === 'string' && v.includes('usage: hyp <command> [args...]')
      )
      expect.that(
        'hypaware --help lists known commands',
        helpResult.stdout,
        (v) => typeof v === 'string' && v.includes('daemon') && v.includes('status')
      )

      const smokeResult = spawnSync(
        process.execPath,
        [binPath, 'smoke', 'core_boot_noop'],
        { cwd: repoRoot, encoding: 'utf8', env: { ...process.env } }
      )
      expect.that(
        `hypaware smoke core_boot_noop exits 0 (got status=${smokeResult.status}, stderr=${truncate(smokeResult.stderr)})`,
        smokeResult.status,
        (v) => v === 0
      )
      expect.that(
        'hypaware smoke core_boot_noop reports ok',
        smokeResult.stdout,
        (v) => typeof v === 'string' && v.includes('smoke core_boot_noop: ok')
      )

      const packResult = spawnSync(
        'npm',
        ['pack', '--dry-run', '--json'],
        { cwd: repoRoot, encoding: 'utf8', env: { ...process.env } }
      )
      expect.that(
        `npm pack --dry-run exits 0 (got status=${packResult.status}, stderr=${truncate(packResult.stderr)})`,
        packResult.status,
        (v) => v === 0
      )

      let packInfo
      try {
        packInfo = JSON.parse(packResult.stdout)
      } catch (err) {
        throw new Error(
          `npm pack --dry-run did not emit JSON: ${err instanceof Error ? err.message : String(err)}\n  stdout=${truncate(packResult.stdout)}`
        )
      }
      /** @type {Array<{ path: string }>} */
      const fileEntries = packInfo?.[0]?.files ?? []
      const files = fileEntries.map((f) => f.path)

      expect.that(
        'pack includes bin/hypaware.js',
        files,
        (v) => Array.isArray(v) && v.includes('bin/hypaware.js')
      )
      expect.that(
        'pack includes package.json',
        files,
        (v) => Array.isArray(v) && v.includes('package.json')
      )
      expect.that(
        'pack includes src/core/** sources',
        files.some((f) => f.startsWith('src/core/')),
        (v) => v === true
      )

      const manifestRegex = /^hypaware-core\/plugins-workspace\/[^/]+\/hypaware\.plugin\.json$/
      const manifests = files.filter((f) => manifestRegex.test(f))
      expect.that(
        'pack includes at least one bundled plugin manifest',
        manifests,
        (rows) => Array.isArray(rows) && rows.length >= 1
      )

      const pluginSrcRegex = /^hypaware-core\/plugins-workspace\/[^/]+\/src\//
      const pluginSrc = files.filter((f) => pluginSrcRegex.test(f))
      expect.that(
        'pack includes bundled plugin entrypoint sources',
        pluginSrc,
        (rows) => Array.isArray(rows) && rows.length >= 1
      )

      const skillsRegex = /^hypaware-core\/plugins-workspace\/[^/]+\/skills\//
      const skillFiles = files.filter((f) => skillsRegex.test(f))
      expect.that(
        'pack includes bundled skill assets',
        skillFiles,
        (rows) => Array.isArray(rows) && rows.length >= 1
      )

      const smokeFiles = files.filter((f) => f.startsWith('hypaware-core/smoke/'))
      expect.that(
        'pack includes the smoke harness',
        smokeFiles,
        (rows) => Array.isArray(rows) && rows.length >= 1
      )
    }
  )

  await obs.shutdown()
}

/** @param {string | null | undefined} s */
function truncate(s) {
  if (!s) return '<empty>'
  const str = String(s)
  return str.length > 240 ? str.slice(0, 240) + '...' : str
}
