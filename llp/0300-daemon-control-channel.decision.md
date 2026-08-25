# LLP 0300: Daemon Control Channel and Home Resolution for Windows Groundwork

**Type:** Decision
**Status:** Draft
**Systems:** Daemon, CLI
**Author:** Kenny / Claude
**Date:** 2026-08-21
**Related:** LLP 0017, LLP 0067, LLP 0166

## Summary

Two pieces of groundwork for a future Windows port, both applied on every
platform:

1. The daemon grows a **file-based control channel**
   (`<stateRoot>/run/control/`) that carries stop and reload requests without
   OS signals. On win32, `hyp daemon stop` uses it instead of SIGTERM; POSIX
   keeps signals as the primary transport, unchanged.
2. **Home-directory resolution** is made uniform: an injected `env.HOME` wins
   when set, `os.homedir()` is the fallback, and the empty string is never a
   home.

Neither change makes win32 a supported daemon platform (`platformIsSupported`
still refuses it; that gate is LLP 0017's and falls only with a Windows
service installer). They remove the two classes of POSIX assumption a Windows
installer would otherwise trip over.

## Context

LLP 0017's daemon lifecycle is signal-shaped at its edges: `hyp daemon stop`
sends SIGTERM and the runtime's reload path is a SIGHUP handler. Both edges
are POSIX-only in practice:

- On Windows, `process.kill(pid, 'SIGTERM')` from another process is
  `TerminateProcess`: a hard kill that skips the shutdown path entirely, so
  sources are not stopped, the daemon log is not flushed, and the PID file is
  left stale.
- SIGHUP is not deliverable to a detached Windows process at all, so the
  same-shape reload path (LLP 0004) has no cross-process trigger there.

The runtime itself is already transport-agnostic: signals only call the same
`shutdown()` / `reload()` functions the in-process `DaemonHandle` exposes.
What is missing is a cross-process way to reach them that works everywhere.

Separately, several call sites resolved a home directory as `env.HOME || ''`.
On POSIX, `HOME` is always set, so the `''` arm was dead. On Windows
(PowerShell / cmd), `HOME` is typically unset, so those sites silently
produced relative paths: `path.join('', '.hyp')` is `.hyp` in the current
working directory, which scatters state roots per-cwd instead of one per
user. The kernel's own resolution (`readObservabilityEnv`) never had this
bug: it uses `os.homedir()`, which reads `HOME` on POSIX and `USERPROFILE`
on Windows. The deviant sites were re-derivations that drifted.

## Options considered

**For the control transport:**

- **A localhost HTTP endpoint.** Rejected: LLP 0067 §cli-response-check and
  LLP 0166 already record that a localhost port can be squatted by any
  same-uid process and the responder cannot be cheaply authenticated. A stop
  channel with that property is worse than the status quo.
- **A named pipe / unix socket.** Carries ownership in the namespace (the
  property LLP 0166 notes a port lacks) but needs two transport
  implementations (AF_UNIX + Windows named pipes) and a wire protocol, for
  what is ultimately two verbs.
- **Request files in the daemon's own state directory.** The state dir is
  user-owned, so writing into it requires exactly the authority that owning
  the daemon requires: the namespace itself carries the trust property, per
  LLP 0166's observation. The daemon already treats this directory as its
  control surface (PID file, status file, config-control slots). One
  implementation, no protocol, portable `fs.watch`.

**For home resolution:** align every site on the pattern the healthy majority
already used (`env.HOME ?? os.homedir()`), rather than routing everything
through `readObservabilityEnv` (which ignores an injected `env.HOME`, and the
injected env is a load-bearing test seam for unit tests that never touch
`process.env`).

## Decision

<a id="file-channel"></a>**Stop and reload requests ride marker files under
`<stateRoot>/run/control/`.** `stop.request` and `reload.request` are the two
verbs. The daemon watches the directory (`fs.watch` for low latency, with a
polling interval always running underneath it: a watch event can be dropped
or delayed, a win32 unlink can fail transiently while the writer still holds
the handle, and a missed stop request would leave a win32 daemon
unstoppable; the poll is fast on win32 where the channel is the only stop
transport and slow elsewhere, where signals are primary and the poll is only
a backstop), consumes a request by deleting
its file, then dispatches into the same `shutdown()` / `reload()` the signal
handlers call. The watcher is installed on every platform: it is the only
transport on win32 and a harmless second door elsewhere.

<a id="boot-clears-stale"></a>**Boot clears stale requests before the PID
file is written.** A request file is an instruction to the *running* daemon.
One that survived a crash, or a hard kill, must not stop the next boot on
sight. The clear is best-effort per file and cannot block the boot; a
leftover it cannot remove (a transient win32 EPERM/EBUSY can outlive the
clear) is recorded, by content, and handed to the watcher, which consumes a
matching file without dispatching it (logged as discarded). The recording
never outlives the file: any observed absence drops it. A fresh request
rewrites the file with new bytes (every payload carries a nonce), so it no
longer matches and dispatches normally; independently, a `requestedAt` at or
after this boot proves a request fresh even when the recorded side was
unreadable, since the leftover necessarily predates the boot. Anything the
watcher dispatches is therefore a genuine live request, and anything it
discards is a genuine leftover, whether the clear succeeded or not.

<a id="stop-wins"></a>**When both requests are present, stop wins.** A
reload of a daemon that has been asked to stop is work thrown away; both
files are consumed either way.

<a id="posix-keeps-signals"></a>**POSIX keeps signals as the primary
transport.** `hyp daemon stop` sends SIGTERM on darwin/linux exactly as
before; only win32 routes through the file channel. The signal path is
proven by the existing smokes, and service managers (`launchctl bootout`,
`systemctl stop`) speak signals regardless, so the daemon's handlers stay.

<a id="home-resolution"></a>**Home resolution: `env.HOME` wins when set,
`os.homedir()` is the fallback, `''` is never a home.** For `HYP_HOME`
derivations, the shape is `env.HYP_HOME || path.join(env.HOME ||
os.homedir(), '.hyp')`, with `||` rather than `??` so an empty `HOME`
falls through too. This preserves both existing seams: smoke flows
steer via `process.env.HOME` (which `os.homedir()` reads on POSIX), and unit
tests steer via an injected env object (which the `env.HOME` arm honors). On
Windows, `os.homedir()` resolves `USERPROFILE`, which is what fixes the
relative-`.hyp` bug.

The rule is for read-side resolution. Write-side seams decide for
themselves and say so at the site: the attach reconcile
(`action_attach.js`) and the walkthrough finale keep `''` as a deliberate
"no env-provided home, write nothing" sentinel, while the explicit
`hyp skills install` command resolves a real home because the user asked
for that write.

## Consequences

- `requestDaemonStop` gains a `platform` option (defaulting to
  `process.platform`) and, on win32, writes `stop.request` instead of
  signaling; the wait-for-PID-clear loop is unchanged. A win32 stop against a
  daemon that predates the watcher times out rather than hard-killing; the
  stale request is cleared by that daemon's next boot.
- A cross-process reload trigger now exists on every platform (write
  `reload.request`), though no CLI command wraps it yet.
- The `shutdown` reason vocabulary grows a `'control'` member alongside
  `'signal' | 'manual' | 'restart'`.
- A future Windows service installer (the remaining LLP 0017 gate) can rely
  on the control channel for orderly stop and on uniform home resolution for
  state paths; those are no longer part of its work.

## Open questions

- Whether `hyp daemon reload` should become a CLI verb over the channel, or
  reload should stay operator-invisible (today it is SIGHUP-only on POSIX).
- Whether a win32 stop timeout should escalate to a hard kill after the
  orderly window, or keep reporting `timed_out` and leave escalation to the
  operator.

## References

- LLP 0017: Daemon Runtime and Installers (the lifecycle this extends)
- LLP 0067 §cli-response-check, LLP 0166: why a localhost port is not a
  trustworthy control transport
- LLP 0004: same-shape reload semantics (what `reload.request` triggers)
