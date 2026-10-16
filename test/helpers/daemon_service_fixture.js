// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  LAUNCH_LABEL,
  SYSTEMD_UNIT_BASE,
  defaultPlistDir,
  defaultUnitDir,
} from '../../src/core/daemon/platform.js'

/**
 * **A temp HOME does not sandbox the service manager.**
 *
 * Read this before writing any test that lets daemon code run for real.
 *
 * `serviceDaemonStatus`'s *installed* half is a file check under `homeDir`,
 * so pointing `HOME` / `HYP_HOME` at a temp dir really does sandbox it.
 * Nothing else about launchd or systemd is sandboxed by `HOME`. Both address
 * a service by **label inside a per-uid namespace**: the command that
 * actually runs is `launchctl kickstart -k gui/<your uid>/com.hyperparam.hypaware`
 * or `systemctl --user restart hypaware.service`, and neither reads `HOME` to
 * decide which service that is. A fixture that drops a marker here and then
 * lets `restartServiceDaemon` run kicks the **developer's own daemon**, which
 * on macOS severs every in-flight proxied stream (#602).
 *
 * The marker below is therefore only ever safe next to one of:
 *
 * - a fake `LaunchctlAdapter` / `SystemctlAdapter` passed into the code under
 *   test (see `test/core/daemon-launchagent-race.test.js`), or
 * - a call path that never reaches a state-changing service op, or
 * - `runServiceCommand`'s test-runner guard, which refuses the spawn outright
 *   and is what makes the two `attach-*` fixtures safe on a developer machine.
 *
 * "The CI container has no `launchctl` binary" is not one of them.
 *
 * @ref LLP 0181#the-rule [tests]: the fixture that most invites the mistake carries the rule
 *
 * @param {string} home
 */
export function installFakeDaemonService(home) {
  if (process.platform === 'darwin') {
    const dir = defaultPlistDir(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${LAUNCH_LABEL}.plist`), '<plist/>')
  } else {
    const dir = defaultUnitDir(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${SYSTEMD_UNIT_BASE}.service`), '[Unit]\n')
  }
}
