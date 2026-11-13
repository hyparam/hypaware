The daemon can now update HypAware itself. By default it checks npm once a day and installs new releases automatically. Set `auto_update: false` in config to turn it off.

How it works:

- The daemon checks the registry for a newer version at boot and daily after that. When it finds one it runs `npm install -g` (the same thing setup already does) and exits with the restart code so launchd/systemd brings it back up on the new version.
- The boot-time check runs in `bin/hypaware.js` before anything else loads. So if we ship a broken release that crashes on boot, the machine still checks for updates on every relaunch and picks up the fix once we publish one. If the last boot didn't reach healthy, it checks hourly instead of daily.
- `hyp update` updates immediately and restarts the daemon. `hyp status` shows a line when updates are off, broken, or pending, and `--json` has the details.
- Only global npm installs update themselves. Dev checkouts and npx runs skip the whole thing, including the network call, so smokes stay hermetic. If `npm install` fails (e.g. the prefix needs sudo), we don't retry in a loop, we just show it in `hyp status`.

The new `auto_update` config key is a top-level boolean, default true, and central config wins over local, so an org can control it for the fleet.

Tests: 15 new ones in `test/core/self-update.test.js`, full suite and typecheck pass, relevant smokes pass. I also ran `hyp update` from this checkout for real: it saw 1.26.0 on npm and correctly refused to install over a checkout.

Not in this PR: pinning the kernel version from central config (noted as deferred in LLP 0309). The flaky `claude-telemetry-unparseable-body` test fails occasionally on master too and is untouched.

<!-- neutral-triage: 2a7954f019d28f8e2c24d0221e41f1415f6188ea #1024 -->