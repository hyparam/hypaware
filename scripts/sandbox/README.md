# hyp-sandbox

Test HypAware installation methods without touching your real install.

`hyp-sandbox` runs any command with `HOME`, `HYP_HOME`, and the npm global
prefix pointed at a throwaway directory, and with **mock `launchctl`,
`security`, and `systemctl`** first on `PATH`. So a real `hyp daemon install`,
`hyp attach claude`, or `hyp daemon uninstall` runs its real code all the way
down, but the LaunchAgent, the CA trust, and `NODE_USE_SYSTEM_CA` land in the
sandbox instead of your login session.

```sh
scripts/sandbox/hyp-sandbox info                    # what the sandbox looks like
scripts/sandbox/hyp-sandbox hyp daemon install      # workspace build, sandboxed
scripts/sandbox/hyp-sandbox run npx hypaware@latest status
scripts/sandbox/hyp-sandbox calls                   # what it intercepted
scripts/sandbox/hyp-sandbox reset                   # throw it all away
```

Default root is `~/.hyp-sandbox`; override with `--root <dir>` or
`HYP_SANDBOX_ROOT`.

## Why the mocks exist

`HOME` alone is not enough. launchd service labels and `launchctl setenv` live
in a **per-uid** namespace, and the login keychain that macOS actually consults
is the one belonging to your user, not to `$HOME`. Without the mocks, a
sandboxed `hyp daemon install` would boot out **your real daemon**, and a
sandboxed `hyp daemon uninstall` would delete **your real CA trust** and unset
`NODE_USE_SYSTEM_CA` for your whole login session.

Every one of those calls goes through a single seam,
`runServiceCommand(bin, args)` in `src/core/daemon/service_ops.js`, which
spawns the bare binary name and so resolves it through `PATH`. That is what
the shims intercept.

## What is isolated

| Thing | Where it goes in the sandbox |
|---|---|
| Cache, config, logs (`~/.hyp`) | `<root>/home/.hyp` |
| Client attach files (`~/.claude`, `~/.codex`) | `<root>/home/...` |
| LaunchAgent plists | `<root>/home/Library/LaunchAgents` |
| launchd bootstrap / bootout / kickstart / setenv | `<root>/state/launchd.json` |
| Keychain CA trust | `<root>/state/keychain.json` |
| systemd user units | `<root>/state/systemd.json` |
| `npm install -g`, `npx` downloads | `<root>/npm-global`, `<root>/npm-cache` |
| Every intercepted call | `<root>/state/calls.jsonl` |

## What is **not** isolated

- **Network.** Real requests go to real upstreams.
- **Ports.** The gateway defaults to `127.0.0.1:18521`, the same port your live
  daemon uses. Use `hyp-sandbox seed-config 18621` or `hyp-sandbox port 18621`
  before starting a sandbox daemon.
- **Real client behaviour.** Claude Code and Codex on your machine read your
  real `~/.claude` / `~/.codex`, so the sandbox proves what HypAware *writes*,
  not that a real client picks it up.
- **Actual trust.** The mock keychain records trust; it does not make TLS
  interception work. To prove real trust you still need a real keychain, i.e. a
  second macOS user account or a VM.

## Commands

| Command | What it does |
|---|---|
| `info` | Print the sandbox env, and warn if the shims are not first on `PATH` |
| `shell` | Open a bare `bash` inside the sandbox (`exit` to leave) |
| `run <cmd...>` | Run one command inside the sandbox |
| `hyp <args...>` | Run the workspace build's CLI inside the sandbox |
| `central start\|stop\|status\|log\|config` | Run a stand-in central server so `hyp join` / `leave` / rejoin can be tested without a real fleet |
| `seed-config [port]` | Write a minimal v2 config with a non-clashing gateway port |
| `port <n>` | Rewrite every `listen` port in the sandbox config |
| `calls [n]` | Show the last n intercepted `launchctl`/`security` calls |
| `state` | Dump the mock launchd, keychain, and systemd state |
| `reset` | Delete the sandbox root (asks first) |

| Flag | Effect |
|---|---|
| `--root <dir>` | Sandbox root (default `~/.hyp-sandbox`) |
| `--spawn` | Mock `launchctl bootstrap` really starts the plist's program, so you get a live sandboxed daemon with a real pid, status file, and bound port |
| `--refuse-trust` | `security add-trusted-cert` behaves like the user cancelling the macOS password dialog, for testing the degraded attach path |
| `--verbose` | Echo every intercepted call to stderr as it happens |

## Worked examples

Install method: published package, global install.

```sh
scripts/sandbox/hyp-sandbox run npm install -g hypaware@latest
scripts/sandbox/hyp-sandbox run hyp status
```

Install method: local tarball.

```sh
npm pack
scripts/sandbox/hyp-sandbox run npm install -g ./hypaware-1.23.0.tgz
scripts/sandbox/hyp-sandbox run hyp init
```

Full daemon lifecycle with a live process:

```sh
scripts/sandbox/hyp-sandbox seed-config 18621
scripts/sandbox/hyp-sandbox --spawn hyp daemon install
scripts/sandbox/hyp-sandbox hyp daemon status      # real pid, real bound port
scripts/sandbox/hyp-sandbox hyp daemon uninstall   # bootout stops the process
scripts/sandbox/hyp-sandbox calls
```

Attach and detach, including the cancelled-dialog path. Proxy-mode attach only
offers itself on an interactive terminal, so run these from `hyp-sandbox
shell`; a one-shot `hyp-sandbox hyp attach claude` falls back to base-URL mode:

```sh
scripts/sandbox/hyp-sandbox --refuse-trust hyp attach claude
scripts/sandbox/hyp-sandbox state                  # keychain still empty
scripts/sandbox/hyp-sandbox hyp attach claude
scripts/sandbox/hyp-sandbox state                  # cert recorded as trusted
```

## Worked example: 1.22 → `hyp leave` → 1.23 → rejoin with the proxy

The fake central server (`hyp-sandbox central`) serves a fleet config from
`<root>/state/fleet-config.json`, so the whole enrollment lifecycle is
testable. Edit that file mid-run to change what the fleet says; the daemon
picks it up on its next poll (the ETag is the file's content hash).

```sh
scripts/sandbox/hyp-sandbox --root ~/.hyp-sandbox-upgrade central start
scripts/sandbox/hyp-sandbox --root ~/.hyp-sandbox-upgrade run npm install -g hypaware@1.22.0
scripts/sandbox/hyp-sandbox --root ~/.hyp-sandbox-upgrade --spawn run hyp join http://127.0.0.1:18700 any-token
# ...org-driven attach lands in base-URL mode (1.22 has no proxy support at all)
scripts/sandbox/hyp-sandbox --root ~/.hyp-sandbox-upgrade --spawn run hyp leave
scripts/sandbox/hyp-sandbox --root ~/.hyp-sandbox-upgrade run npm install -g hypaware@1.23.0
scripts/sandbox/hyp-sandbox --root ~/.hyp-sandbox-upgrade --spawn run hyp join http://127.0.0.1:18700 any-token
scripts/sandbox/hyp-sandbox --root ~/.hyp-sandbox-upgrade run hyp status   # proxy trust: all green
```

Two things the mocks had to grow for this to work, both worth knowing:

- **KeepAlive.** HypAware applies a pulled config by *exiting* and letting
  launchd restart it. The mock `launchctl` therefore runs a supervisor per
  bootstrapped service (throttled at 1s rather than launchd's 10s), or the
  machine would be daemon-less exactly when the fleet config lands.
- **`identity`.** A served central sink block must include an `identity` key
  (`{}` is enough once the machine has an `identity.json`); without it the sink
  fails to materialize, which takes the config-pull loop down with it. The
  machine then recovers only when probation expires and rolls the config back.

### Testing `hyp remote login`

The fake server also speaks the attended sign-in flow (`/v1/identity/login/start`
and `/v1/identity/token`), so an enrolling login is testable without a real
identity provider. The "browser" is anything that fetches the start URL - the
server answers with a 302 straight to the client's loopback receiver, so `curl`
completes a sign-in:

```sh
hyp-sandbox --root ~/.hyp-sandbox-upgrade --spawn run hyp remote login sandbox --no-browser > login.log 2>&1 &
sleep 4
curl -sL "$(grep -o 'http://127.0.0.1:18700/v1/identity/login/start[^ ]*' login.log | head -1)"
```

What that surfaced: **login recovers a machine that ran `hyp leave`, and does
not recover one that only ran `hyp detach`.** The enrollment work (including the
daemon install that makes a freshly upgraded binary actually run) sits behind
`if (seeded.length === 0)` in `remoteLogin` - an already-enrolled machine
re-seeds its identity and stops. `hyp daemon install` is the idempotent step
that covers both.

The `security add-trusted-cert` in this flow is issued by the **daemon**, not
by a command the user ran. The sandbox mock accepts it silently; a real Mac
raises its password dialog. That step is the one thing this sandbox cannot
prove - verify it in a second macOS user account before telling anyone the
flow is unattended.

## Known snag: `npm config get prefix`

npm 11 refuses to *read* `prefix` whenever it is set explicitly, in an
`.npmrc` or in the environment:

```
npm error The prefix option is protected, and can not be retrieved in this way
```

The sandbox has to set it, so `ensureDurableBinForNpx`
(`src/core/cli/global_install.js`), which shells out to `npm config get
prefix`, fails inside the sandbox on the `npx hypaware` → `hyp init` path.

This is not only a sandbox artifact: **any** user with `prefix=` in their
`~/.npmrc` (the usual way to avoid `sudo` for global installs) hits the same
error on that path. `npm prefix -g` returns the same value and is not
protected.

## Adding a mock

The mocks live in `lib/shim.js`, one function per tool, each returning
`{ code, out, err, note }`. Add a subcommand branch there; the wrapper scripts
in `<root>/bin` are regenerated on every run, so nothing else needs touching.
