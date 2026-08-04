# LLP 0181: a temp HOME does not sandbox the service manager

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon
**Author:** Phil / Claude
**Date:** 2026-08-04
**Related:** LLP 0017, LLP 0174, LLP 0178

> `runServiceCommand` refuses to spawn `launchctl` / `systemctl` when it is
> running under the Node test runner, unless `HYP_ALLOW_REAL_SERVICE_MANAGER=1`
> says otherwise. A temp `HOME` sandboxes the plist/unit **file**; it does not
> sandbox launchd or systemd, which address a service by label in a **per-uid**
> namespace. The refusal lives at the single spawn seam, not in each fixture,
> because the failure mode is a fixture author not knowing the rule.

## Context {#context}

[LLP 0017](./0017-daemon-runtime.decision.md#install-global-package-then-service-manager)
installs a macOS LaunchAgent under the fixed label `com.hyperparam.hypaware` and
a systemd user unit named `hypaware.service`. Both installers take an injectable
`LaunchctlAdapter` / `SystemctlAdapter`, and the install-path tests use it
(`test/core/daemon-launchagent-race.test.js`).

The attach-enable flow ([LLP 0174](./0174-attach-prompts-to-enable.design.md#prompt))
has no such seam: `enableClientAdapter`'s `restartDaemon` injection point is not
threaded through `runAttach`, so a test that drives `hyp attach` end to end gets
the real `restartServiceDaemon`.

Two fixtures (`test/core/attach-enable-resume.test.js`,
`test/core/attach-endpoint-fallback.test.js`) wrote a service marker under the
**real** label into a temp-`HOME` `Library/LaunchAgents` so
`serviceDaemonStatus` would report `installed: true`, and then let the restart
run, on the recorded assumption that "the environment has no `systemctl` /
`launchctl` binary reachable, so the call genuinely throws". That holds in the CI
container and is false on every developer machine. On a macOS host with an
installed daemon, `npm test` therefore ran
`launchctl kickstart -k gui/<uid>/com.hyperparam.hypaware` against the
developer's own daemon, roughly 27 times in one session (#602). Each kick
severed in-flight proxied streams, which attached clients saw as truncated
responses.

The temp `HOME` fooled only the on-disk half of the status check. `resolveTarget`
derives `userDomain` from `process.getuid()`, never from `HOME`.

## The rule {#the-rule}

**A temp `HOME` (or `HYP_HOME`) does not sandbox the service manager.** It
relocates the plist/unit file and nothing else. Any test that lets a real
`launchctl` / `systemctl` command run escapes its sandbox and acts on the
developer's own per-user service, whatever `HOME` says.

A test may reach daemon service code only by injecting a fake adapter, or by
staying on a path that never reaches a state-changing service op. "The CI image
has no service manager installed" is not a sandbox; it is a property of one host.

## The guard {#the-guard}

Fixture-by-fixture discipline is the thing that already failed, so the refusal
goes where every service-manager command necessarily passes:
`runServiceCommand` in `src/core/daemon/service_ops.js` rejects with a
`ServiceManagerSandboxError` when `NODE_TEST_CONTEXT` is set (the Node test
runner sets it in every test child) and `HYP_ALLOW_REAL_SERVICE_MANAGER` is not
`1`.

Three consequences are deliberate:

- **It covers spawns nobody thought about.** The next fixture to drop a marker
  under the real label gets a named refusal instead of a kicked daemon.
- **It is a rejection, not a synchronous throw.** Callers such as
  `installLaunchAgent`'s best-effort `bootout` attach a `.catch()` to the
  returned promise, which a synchronous throw would sail past.
- **It binds to the test runner only.** The hermetic smokes
  (`hyp smoke ...`) and the packaged CLI do not set `NODE_TEST_CONTEXT`, so the
  acceptance tier that is *supposed* to install and start a real daemon
  (`docs/ACCEPTANCE.md`) is untouched, and needs no opt-in.

The opt-in exists for a hypothetical test that genuinely means to drive this
machine's service manager. Nothing in the traditional suite may use it: that
tier is defined as fast, deterministic, and local, and a real `launchctl` call
is none of the three.

## Alternatives considered {#alternatives}

**Thread an adapter injection seam through `runAttach`.** The honest fix for
those two fixtures, but it widens a command entrypoint's signature to serve a
test, and it fixes only the call sites someone remembers to thread. Rejected as
the *primary* guard; still the right move if attach ever needs to script daemon
behaviour rather than merely avoid it.

**Set a fake `PATH` in the test runner so `launchctl` resolves to a stub.**
Silently turns a real call into a no-op, so a fixture keeps its wrong mental
model and the next reviewer cannot see the mistake. The refusal names it.
