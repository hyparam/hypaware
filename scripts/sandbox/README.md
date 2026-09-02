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

Two shims updating the same state file take a lock over the read-change-write,
because a rename stops torn reads but not lost updates. A mock that deadlocks
would be worse than one that races, so a lock left behind by a shim that was
killed is broken after 60s, and a wait that outlives its 15s budget breaks
the holder's lock and takes it for itself. Either break attempt proceeds
unlocked instead when the retake that follows it is lost, whether or not the
removal itself took anything. Every one of those degraded
exits appends a line to `calls.jsonl` carrying a `lock` object
(`broke-stale`, `broke-budget`, or `degraded-unlocked`, with how long it
waited and the age of the lock, or a null age where there was nothing left to
measure), so a run that lost an update can be told from one that never
contended:

```sh
grep '"lock"' "$(scripts/sandbox/hyp-sandbox path)/state/calls.jsonl"
```

Read `ageMs` as an observation, not a fact about the lock that was evicted.
The age is stat'd before the removal, and those are two syscalls: a lock
released and retaken in that gap is the one actually evicted, while `ageMs`
still describes the lock seen a moment earlier. The reason is picked from
that same earlier read, so where it was a stale age that triggered the
break, the line says `broke-stale` about a lock that was freshly taken. A
`broke-budget` stays true whatever it evicted, being a fact about this
shim's own wait rather than about the lock. That an eviction happened is
never misreported, only how it is described. `waitedMs` is the field to
trust, on every event.

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

## What the sandbox *assumes* (and cannot prove)

One assumption is load-bearing enough to state on its own, because getting it
wrong produced a confidently wrong answer once already.

**A daemon-issued `security add-trusted-cert` is refused.** Attach runs the same
code in the CLI and in the daemon's reconciler
(`ensureDarwinProxyTrust`, `hypaware-core/plugins-workspace/claude/src/index.js`),
and trusting a CA in the login keychain is gated by the macOS password dialog.
Nobody is watching a background LaunchAgent, so the sandbox answers a
daemon-issued trust with the error macOS gives when it cannot prompt:

```
SecTrustSettingsSetTrustSettings: User interaction is not allowed.
```

The result is that an unattended fleet setup ends with:

```
proxy trust:
  login keychain: not trusted - Remote Control inbound will not work, run `hyp attach claude` to retry
  launchd env:    NODE_USE_SYSTEM_CA=1 set
```

which matches what people report from real machines: the settings and the
launchd env land by themselves, the keychain trust waits for a human.

**This is an assumption, not a measurement.** Whether real macOS lets a
LaunchAgent raise that dialog can only be settled on a real keychain - a second
macOS user account or a VM. The sandbox takes the pessimistic reading so a test
run cannot claim an unattended setup established trust when it may not have.
Flip it with `--trust-from-daemon grant` to exercise the other branch.

A mock that always succeeds is worse than no mock: it turns an open question
into a false answer. If you add mocks here, prefer failing the uncertain case
and naming the assumption in the `note` the call log records.

The mock does model the half of `launchctl setenv` that matters to the
daemon: a value set in the domain is injected into every job the mock launchd
starts afterwards, so under `--spawn` you can check the daemon's own
environment rather than only that `getenv` reads the value back.

What is *not* modellable here: Remote Control also needs
`NODE_USE_SYSTEM_CA=1` in the environment when Claude Code boots.
`launchctl setenv` only reaches processes launched afterwards, so the terminal
app must be fully quit (Cmd-Q) and reopened. Nothing inside a sandbox can
reproduce your terminal's inherited environment - check `echo
$NODE_USE_SYSTEM_CA` in the real one.

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
| `calls [n]` | Show the last n intercepted `launchctl`/`security`/`systemctl` calls, and the observations the KeepAlive supervisors filed under their own lane's tool |
| `state` | Dump the mock launchd, keychain, and systemd state |
| `reset` | Stop anything `--spawn` started (and the fake central), wait for it to actually exit, then delete the sandbox root (asks first) |

| Flag | Effect |
|---|---|
| `--root <dir>` | Sandbox root (default `~/.hyp-sandbox`) |
| `--spawn` | Mock `launchctl` or `systemctl` really starts the service, so you get a live sandboxed daemon with a real pid, status file, and bound port |
| `--refuse-trust` | `security add-trusted-cert` behaves like the user cancelling the macOS password dialog, for testing the degraded attach path |
| `--trust-from-daemon <grant\|refuse>` | Whether a *daemon-issued* trust succeeds. Default `refuse` - see "What the sandbox assumes" |
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

The fake server also speaks the attended sign-in flow
(`/v1/identity/login/start`, `/v1/identity/login/poll`, and
`/v1/identity/token`), so an enrolling login is testable without a real
identity provider. The "browser" is anything that fetches the start URL: the
server parks the outcome under the client's `state` and the client's poller
collects it (LLP 0342), so a plain `curl` completes a sign-in:

```sh
hyp-sandbox --root ~/.hyp-sandbox-upgrade --spawn run hyp remote login sandbox --no-browser > login.log 2>&1 &
sleep 4
curl -s "$(grep -o 'http://127.0.0.1:18700/v1/identity/login/start[^ ]*' login.log | head -1)"
```

What that surfaced: **login recovers a machine that ran `hyp leave`, and does
not recover one that only ran `hyp detach`.** The enrollment work (including the
daemon install that makes a freshly upgraded binary actually run) sits behind
`if (seeded.length === 0)` in `remoteLogin` - an already-enrolled machine
re-seeds its identity and stops. `hyp daemon install` is the idempotent step
that covers both.

The `security add-trusted-cert` in this flow is issued by the **daemon**, not
by a command the user ran. The sandbox refuses it by default because nobody is
watching the background service to answer a password dialog. That is the
pessimistic assumption described above, not proof of what a real Mac does; use
`--trust-from-daemon grant` to exercise the other branch, and verify either
claim in a second macOS user account before calling the flow unattended.

## Why the npm prefix lives in `.npmrc`

npm 11 refuses to *read* `prefix` when the sandbox supplies it through the
`npm_config_prefix` environment variable:

```
npm error The prefix option is protected, and can not be retrieved in this way
```

`ensureDurableBinForNpx` (`src/core/cli/global_install.js`) calls `npm config
get prefix`, so the sandbox instead writes `prefix` and `cache` into the
sandbox HOME's `.npmrc`. npm still reports that value normally, and both the
global install and the npx download stay under the sandbox root.

## Adding a mock

The mocks live in `lib/shim.js`, one function per tool, each returning
`{ code, out, err, note }`. Add a subcommand branch there; the wrapper scripts
in `<root>/bin` are regenerated on every run, so nothing else needs touching.
