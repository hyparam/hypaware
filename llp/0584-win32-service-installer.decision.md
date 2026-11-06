# LLP 0584: Windows daemon service installer (Scheduled Task)

**Type:** Decision
**Status:** Draft
**Systems:** Daemon, Windows, Onboarding
**Author:** Kenny / Claude
**Date:** 2026-11-05
**Extends:** LLP 0430 (#validation: one real-Windows re-check for this backend, without reviving the procedures tier)
**Related:** LLP 0017 (#install-global-package-then-service-manager, #staged-restart-for-config-replacement, #status-queries-never-raise: the installer contract and the platform gate this falls), LLP 0300 (#file-channel, #posix-keeps-signals, #home-resolution: the win32 groundwork this consumes), LLP 0317 (install means running), LLP 0206 (uninstall detaches its clients), LLP 0181 (tests never drive the real service manager), LLP 0545 (unreachable status), LLP 0529 (unsupervised self-relaunch), LLP 0365 (self-update needs a supervisor), LLP 0521 (supervised port-conflict pacing), LLP 0582 (the SID this reads also keys the owner-only ACLs), LLP 0002 (V1 platform scope)

## Summary

The daemon has run on Windows under `hyp daemon run --foreground` since LLP 0300, but nothing installs it to start unattended, so `platformIsSupported` still refuses win32 and `hyp daemon install` throws. This LLP adds the Windows backend: a **per-user Scheduled Task**, triggered at logon, that runs the daemon as the logged-in user with no elevation - the Windows shape of the per-user launchd LaunchAgent and `systemctl --user` unit the project already chose on macOS and Linux. It flips the platform gate for the daemon service family, and - after the interactive onboarding was validated on a real Windows host (#gate, #validation) - for the `hyp setup` wizard too.

## Motivation

A Windows user today cannot keep HypAware recording across logins without leaving a terminal open. The remaining work is the one LLP 0300 named as the gate's condition: "a Windows service installer." LLP 0300 and the round-1–3 portability work already removed the POSIX assumptions a Windows installer would trip over (signal-free stop via the file control channel, `USERPROFILE` home resolution, a regular-file config pointer). What is left is registering the daemon with a Windows service mechanism and wiring it into the existing install/uninstall/start/stop/restart/status surface.

## Context

Windows offers three ways to start a process unattended, and the choice is constrained by three repo invariants: **no new runtime dependency**, **no required elevation for a CLI**, and the project's standing choice of a **per-user** daemon (never a system daemon) on every platform.

- A **Windows Service** (SCM) is the system-daemon tier. A plain `node.exe` cannot be a service: the SCM expects the process to call `StartServiceCtrlDispatcher` within ~30s and reports start failure (1053) when it does not, so a real service needs a wrapper (nssm, WinSW) - a forbidden dependency. It also requires Administrator to install and normally runs as `LocalSystem`, which has a different profile, cannot see the user's AI-client files, and defeats the owner-only ACLs of LLP 0582.
- A **Run key / Startup shortcut** fires once at logon with no restart, status, or stop, failing LLP 0017's relaunch-on-exit requirement.
- A **Scheduled Task** triggered at logon runs in the user's own session with their profile, needs no elevation for a per-user task, and supports restart-on-failure and single-instance. It is the structural match for a launchd *LaunchAgent* / `systemctl --user` unit - the per-user tier the project already uses.

## Decision

### D1: A per-user logon Scheduled Task is the Windows service backend {#task}

Add `src/core/daemon/win32.js` mirroring the surface `install.js` dispatches through (`plan*`, `install*`, `uninstall*`, `start*`, `stop*`, `restart*`, `*Installed`, `*Status`), and give it a win32 arm in each of the eight platform branches in `install.js`. The backend drives the Task through `schtasks` (resolved on PATH; no new dependency), behind the same injectable adapter seam the POSIX modules use, and registered with the LLP 0181 test-sandbox guard so the suite never touches the host's real Task Scheduler (the `schtasks` analogue of `HYP_ALLOW_REAL_SERVICE_MANAGER`). The task triggers **at logon of the installing user**, runs **as that user at LIMITED run level** (no elevation), and is **per-user by construction**, matching `launchctl … gui/<uid>` and `systemctl --user`.

The principal logon type is **InteractiveToken**, and the console window that would otherwise bring is suppressed by the launcher in D2, not by the logon type. The first real-Windows validation run (#validation) is what forced this to be explicit: node is a console-subsystem binary, and an `InteractiveToken` task launches it in the user's desktop session, where Task Scheduler allocates a **visible console window** that stays open for the daemon's whole life - nothing the task XML can suppress (`<Hidden>` only hides the task in the Scheduler UI; launchd and systemd never attach a console, so this is a win32-only wart). The obvious fix, S4U ("run whether the user is logged on or not"), which runs non-interactive with no window, is **not available to a plain CLI**: `schtasks /Create` for an S4U principal is refused with "Access is denied" unless elevated, and requiring Administrator to install a per-user daemon breaks the no-elevation invariant this whole backend rests on (it is also what would make the daemon outlive a logoff, which is not wanted - the LaunchAgent scope is). So the logon type stays InteractiveToken (non-elevated, torn down at logoff, started again by the logon trigger - LaunchAgent / `systemctl --user` parity), and the window is removed in the action instead.

### D2: The exec line runs node at the JS entry, through a windowless launcher {#exec}

The daemon node runs is `process.execPath` invoking the global package's **JavaScript entry directly** - `[nodePath, jsEntry, 'daemon', 'run', '--config', configPath, '--supervised']`, structurally identical to the launchd/systemd exec line. It does **not** invoke the `hypaware.cmd` shim, so no cmd.exe batch-parsing layer sits between the task and node (the layer LLP 0581 had to escape for untrusted `hyp ask` prompts; a command line we author ourselves gains nothing from it). The durable-bin resolver returns `hypaware.cmd` on win32, so the installer resolves the JS entry behind it from npm's stable global layout (`<prefix>\node_modules\hypaware\bin\hypaware.js`), never an ephemeral path (LLP 0017 #install-global-package-then-service-manager).

The task **action** is not that command line directly, though: it is `wscript.exe //B //Nologo <launcher>.vbs`, a generated one-line VBScript (`WScript.Quit shell.Run("<the node command>", 0, True)`) written to a stable per-user path at install time and removed at uninstall. This is the console-window fix D1 defers to. `wscript` is the GUI-subsystem script host (no console of its own), and window style `0` starts node hidden; `True` waits, so the launcher's exit code **is** node's, which keeps the exit-code supervision of D3 intact (a crash or exit 75 still propagates to Task Scheduler's restart-on-failure). `//B` suppresses WSH error dialogs. Unlike the cmd.exe shim of LLP 0581 the script is authored entirely by us - there is no untrusted text in it, only our own paths, quoted and VBS-escaped (a literal `"` doubled). It is the minimal windowless launcher available without a new dependency or elevation; `cmd /c start` reintroduces the cmd layer D2 avoids and still flashes a window, and `conhost --headless` relies on undocumented exit-code behavior that would make D3's supervision a guess.

### D3: The exit code is the supervision contract; the Task is the sole supervisor {#supervision}

Task Scheduler restarts a task whose process exits **non-zero** ("restart on failure"), and leaves a **zero** exit alone. This maps exactly onto how the daemon already speaks:

- **Crash** (non-zero) → the Task relaunches it: the `KeepAlive` / `Restart=always` equivalent LLP 0017 requires.
- **Staged restart** for config replacement / self-update → the daemon exits **75** (its deliberate "restart me" code, LLP 0017 #staged-restart-for-config-replacement, LLP 0529); non-zero, so the Task relaunches with the new version.
- **Graceful stop** → exit **0**; the Task treats it as success and stays down (see D4).

The Task is the **single** supervisor: the daemon must not also self-relaunch (LLP 0529), or a crash would spawn two daemons. So `detectSupervisor` - the one chokepoint LLP 0365, 0521, 0529 and 0539 all branch on - must return true for a Task-launched daemon. POSIX sniffs manager-set environment variables (launchd `XPC_SERVICE_NAME`, systemd `INVOCATION_ID`); Task Scheduler sets none, so the **task action marks the process explicitly** (an env var, e.g. `HYP_SUPERVISED=1`, set in the action, or an equivalent flag). Because we author the command line, this is unambiguous, unlike the POSIX env sniffing LLP 0365 notes is set in plain terminals too.

Consequence to record: Task Scheduler's restart-on-failure minimum interval is **1 minute**, so a crashed daemon can be down for up to ~1 minute before relaunch, versus systemd's `RestartSec=5`. Acceptable for a local telemetry daemon; documented, not hidden. The exit-75-triggers-restart behavior is verified empirically on a real Windows host during implementation rather than assumed.

### D4: Stop is the graceful file channel, escalating to a hard kill only on timeout {#stop}

`hyp daemon stop` on win32 writes a `stop.request` marker (LLP 0300 #file-channel); the daemon flushes and exits 0; the Task, keyed on the exit code (D3), leaves it down until next logon. No routine `schtasks /End` - that is `TerminateProcess`, the ungraceful hard kill LLP 0300 exists to avoid. This is simpler than the POSIX "route a supervised stop through the manager" dance (LLP 0300 #posix-keeps-signals), because our supervisor relaunches only on a *failure* exit, so a clean stop needs to tell the Task nothing.

If the daemon does not consume the request within `DAEMON_STOP_TIMEOUT_MS` (10s) - wedged, ignoring the channel - stop **escalates to `schtasks /End`** (a hard kill) and says so. This settles the open question LLP 0300 left (#posix-keeps-signals / its Open questions): a `stop` that can silently leave a stuck daemon running is a worse broken promise than losing an in-flight flush from a process that was already hung. Graceful is always tried first, so the hard kill only ever fires in the pathological case. The stop window nesting (LLP 0520: proxy 5s < gateway 8s < stop 10s) is unchanged; the `schtasks /End` escalation sits at the 10s boundary, outside the graceful window as systemd's 90s / launchd's 20s do.

`/End` alone is not enough **because of the D2 launcher**. It terminates the process Task Scheduler tracks - `wscript` - but not the node daemon `wscript` spawned, which is orphaned and keeps running (measured on a real host: node survived `/End`). So the win32 `/End` path, in both `hyp daemon stop`'s timeout escalation and `hyp daemon restart`'s fall-back, follows the `/End` with a direct `process.kill` of the pid the daemon's pid file names, guarded by the LLP 0515 identity check (`daemon run` on the command line; an unreadable command line is fail-closed to "it is the daemon", a provably-unrelated pid is left alone). Without this, a wedged `stop` would End the launcher and report success over a still-live daemon, and a `restart` would start a second daemon beside the orphan. The kill wears the LLP 0181 test-runner guard, since `process.kill` of a pid file's daemon is the same host hazard a real service-manager spawn is. Verified on a real Windows host: after the escalation the daemon process is gone.

Start is `schtasks /Run` (run the task now); restart is a graceful stop followed by `schtasks /Run`; install, per LLP 0317, creates the task, runs it, and proves a live pid before reporting success, honoring a `RunAtLoad: false` equivalent (create but do not run) when the caller asks not to start. `serviceDaemonStatus` queries the task's existence and state, never raises (LLP 0017 #status-queries-never-raise), and reports `unreachable: true` when `schtasks` cannot be run (LLP 0545). Uninstall removes the task, then detaches every attached client (LLP 0206 #d1).

### D5: The platform gate includes win32 for the service family and the setup wizard alike {#gate}

`platformIsSupported` gates both the daemon service family and the whole `hyp setup` onboarding wizard (the #975 dispatch gate). Both include win32.

This decision reached win32 in two steps within the same draft. The first opened the **service family** (`hyp daemon install / uninstall / start / stop / restart / status`) while holding the wizard behind a second predicate, `setupPlatformIsSupported`, because the interactive onboarding - first look, the attach cascade, skills/agents, backfill, the finale - had never run end-to-end on Windows. That validation has since happened on a real Windows host (see #validation): dry-run previews change nothing; a scripted `hyp setup` runs the full finale (config write, Claude attach, skills and agents copied, history backfill, daemon install and restart) to exit 0; and the interactive TUI runs. So the split predicate is retired: `setupPlatformIsSupported` is deleted and the setup preflight and `runInitWizard` refusal route through `platformIsSupported` alone. `setupUnsupportedNote` still refuses a platform with no service backend (e.g. `aix`), now naming "macOS, Linux and Windows" as the supported set. A win32 user onboards with `hyp setup` like anyone else; `hyp daemon install` plus `hyp client attach <x>` by hand remains available but is no longer the only path.

### D6: The task is named per-user, keyed by SID {#naming}

Task Scheduler has no per-user domain - its library is machine-wide - so two users on one machine would collide on a fixed task name (and the second may lack permission to modify the first's task). The task is therefore keyed by the user's **SID**, the true Windows analogue of the POSIX uid that launchd/systemd namespace by: stable across username renames, guaranteed unique, and already read via `whoami /user` for the owner-only ACLs (LLP 0582). The task lives at `\hypaware\<SID>` (a `hypaware` folder, one leaf per user). On the common single-user machine this is invisible; on a shared machine it keeps each user's daemon separate. `hyp status` can present a friendly name regardless of the opaque SID leaf.

## Consequences

- `platformIsSupported('win32')` is true for the daemon service family; `hyp daemon install` registers a per-user logon Scheduled Task and the rest of the family works. The `hyp daemon install` family's eight `install.js` branches and `platform.js` labels gain a win32 arm.
- Windows recording survives logout/login without a terminal, bounded to the user's logged-in sessions (LaunchAgent parity): the InteractiveToken task stops at logoff and the logon trigger starts it again at the next sign-in. It runs windowless via the `wscript` launcher (#exec); there is no visible console.
- `detectSupervisor` gains a win32 signal (the task's supervised marker); the self-update (LLP 0365/0539), port-conflict pacing (LLP 0521) and self-relaunch (LLP 0529) lanes behave as on POSIX, with no double-relaunch.
- The standing `TODO(win32)` at `runtime.js` (arm the control watcher early so a boot-time stop is honored) comes into scope: a Scheduled Task's stop rides the same LLP 0300 channel, so the watcher must be armed next to the pid write, not only at the tail of `runDaemon`.
- Crash-recovery latency on win32 is coarser (~1 min) than systemd (~5s); documented.
- `hyp setup` runs on win32 in every form, validated on a real host (#validation, #gate); the `setupPlatformIsSupported` split predicate is retired.

## Validation {#validation}

The tests drive `schtasks` through a fake adapter (LLP 0181), so they prove the calls the backend makes, not what Task Scheduler does with them. The first landing rests on the author's run on a real Windows machine. LLP 0430 retired the procedures doc, so this one re-check lives here instead: a release that changes `src/core/daemon/win32.js`, the task XML, or the win32 arms of `install.js` and `commands/daemon.js` repeats it on a real Windows host, as a normal user in a throwaway `HYP_HOME`.

1. `hyp daemon install`; `hyp daemon status` reports the task and a live daemon.
2. `hyp daemon stop`: the daemon exits 0 and the task stays down (no relaunch after 2 minutes).
3. `hyp daemon start`, then `hyp daemon restart`: the old pid exits through the stop request (its log shows an orderly shutdown, not a kill) and a new pid comes up.
4. Kill the daemon process (`taskkill /F /PID <pid>`): the task relaunches it.
5. Make the daemon exit 75 (a staged restart, e.g. `hyp update` or a config replace): the task relaunches it.
6. `hyp daemon uninstall`: the task is gone from `schtasks /Query /TN \hypaware\<SID>`.

The wizard gate (#gate) rests on a further real-Windows pass, done before the `setupPlatformIsSupported` split was retired:

7. `hyp setup --dry-run` (every form) leaves HOME and HYP_HOME unchanged.
8. A scripted `hyp setup --yes --no-daemon` runs the full finale to exit 0: config written, Claude Code attached (settings under the win32 profile), skills and agents copied, history backfilled, plugin/export dirs created.
9. A real `hyp setup` installs and starts the daemon (step 1) and runs the interactive TUI prompts.

That first run is also what surfaced the two win32 defects this doc records: the daemon's task launched node in a visible console window (fixed by the `wscript` launcher, D1/D2), confirmed gone after reinstall; and the setup tests' HOME-only sandbox leaked to the real profile because `os.homedir()` reads `USERPROFILE` on win32 (fixed in the tests).

The release notes record the `schtasks /Query /V /FO LIST` output after step 1, the `<Principals>` block of `schtasks /Query /XML`, and the observed relaunch delay in steps 4 and 5 (D3 expects up to about a minute).

## Open questions

- Whether the supervised marker is best carried as an environment variable in the task action or as a CLI flag on the exec line (both are unambiguous; the flag is visible in `schtasks /Query` output, the env var is not).
- Whether `install` should offer a `--run-level highest` escape hatch for users who deliberately want an elevated daemon, or keep LIMITED-only to match the no-elevation principle.
- (Resolved) The `hyp setup` finale was validated on a real Windows host before its gate was flipped - config write, attach cascade, skills/agents, backfill, and the daemon install/restart all run (#gate, #validation).

## References

- LLP 0017 - the installer contract and the platform gate this LLP falls.
- LLP 0300 - the file control channel and home resolution this consumes; its "a Windows service installer" is this document.
- LLP 0317, 0206, 0181, 0545, 0529, 0365, 0521, 0520, 0348, 0515 - the daemon-lifecycle constraints the win32 backend must satisfy.
- LLP 0581, 0582, 0580, 0575 - the round-1–3 win32 decisions this builds on.
