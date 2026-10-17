# LLP 0529: An unsupervised foreground run relaunches itself on a staged restart

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon
**Author:** neutral
**Date:** 2026-10-17
**Extends:** LLP 0017 (#staged-restart-for-config-replacement)
**Related:** LLP 0025 (#apply-semantics-staged-restart), LLP 0521 (#pacing: the same supervised/unsupervised split, decided by `detectSupervisor`), issue #2513

> [LLP 0017](./0017-daemon-runtime.decision.md) is Active, so it is not
> edited. Its staged-restart section says a foreground daemon "cannot relaunch
> itself" and that the invoker loops on exit 75. This changes that one
> consequence for a run nobody relaunches, and leaves the rest of the section,
> including the requirement that a staged restart is a fresh process, as it is.

## Context {#context}

`hyp daemon run` in a container is the documented way to run HypAware without
launchd or systemd. Every staged config apply, rollback and SIGHUP reload ends
the run with exit 75, as LLP 0017 says it must. In a container nothing loops on
that code: the process exits, the gateway goes with it, and every client routed
through the gateway loses model access until someone restarts the container
(#2513). The 0017 recipe (a shell loop on 75) works, but every container image
has to know to add it, and the failure when it does not is silent until a
central config change lands.

## Decision {#decision}

- **Relaunch, do not reload.** {#fresh-process} A staged restart is still a new
  process, so the ESM cache argument in 0017 holds: when the in-process run
  ends with 75, the foreground run spawns the same command again as a child,
  with the same argv, env, cwd and stdio, and waits for it. Container logs stay
  attached because the child writes to the same descriptors. A child that ends
  with 75 again returns to the same parent to be relaunched, so at most two
  processes exist at once.
- **Only when nobody else relaunches it.** {#who-relaunches} `detectSupervisor`
  is the single source of the supervised decision, as in LLP 0521. A
  supervised run exits 75 exactly as before. So does a run whose parent is a
  Node process holding an IPC channel to it (an earlier foreground run, or a
  process manager such as pm2): that parent owns the relaunch. The IPC channel
  is the marker because it needs no extra argv or env, so the child really is
  the same command. A false positive is today's behavior, an exit 75.
- **Bounded.** {#bounded} At most 5 relaunches in a 10-minute window, waiting
  0s, 1s, 2s, 4s and 8s before each. On the sixth inside the window the run
  stops relaunching, writes one line naming the staged config, and exits 75
  itself, so a config that fails every apply cannot hot-loop and an outer loop
  or operator still sees the restart code. The first relaunch has no wait, so
  an ordinary apply costs no extra downtime.
- **Signals reach the child.** {#signals} SIGTERM and SIGINT are forwarded and
  end the loop: the run exits with the child's code, or 0 when the stop arrives
  during a wait. SIGHUP is forwarded as the reload it is, and the child's
  resulting 75 is relaunched like any other.

## Consequences {#consequences}

- The 0017 shell loop on 75 still works and is still right for a supervised
  wrapper; it now only runs when the bound is hit.
- The parent keeps the modules its first boot loaded. That is a constant cost,
  not one that grows per relaunch: the parent holds nothing across relaunches
  but the window's start time and count.
- Product telemetry counts each relaunch as its own `daemon run` invocation,
  because each is one.
