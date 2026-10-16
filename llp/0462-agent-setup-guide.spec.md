# LLP 0462: Agent setup guide

**Type:** Spec
**Status:** Draft
**Systems:** Onboarding
**Author:** Brendan / Codex
**Date:** 2026-10-05
**Extends:** LLP 0011#non-interactive-entry
**Related:** LLP 0130, LLP 0137, LLP 0404, LLP 0411

## Motivation

A person can ask an agent to install HypAware using two public commands:
`npm i -g hypaware`, then `hyp setup`. The unattended installer already
exists, but the flagless non-terminal entry only prints a refusal and a flag
skeleton. It does not explain choices or human handoffs.

## Guide {#guide}

Flagless setup without a stdout terminal prints a read-only guide on stdout
and exits 0: providing the guide is a successful response, not an error.
It opens with "HypAware setup guide" and asks the agent to choose options
with the person before running the setup command. `hyp setup --guide`, used alone,
prints the same guide on a terminal so an agent with a PTY can avoid the TUI.
The interactive wizard retains its contract. Flag-driven installation adds
explicit choices for GitHub collection and deferring optional history import.

The guide reuses bundled picker manifests, their platform/visibility gates,
display order and presence probes. Detected sources are hints only, never
selected without the person's answer. It names all accepted source IDs,
explains that `--yes` alone defaults to Claude and OTEL without detection,
and constructs an example from detected sources when there are any.

It discloses config replacement, local storage, retention, existing-history
import, daemon installation, client attachment and skills. It advises a dry
run, an explicit source selection and status verification, including the
existing config, daemon and client-attach JSON fields. Setup exit 0 is not
proof of healthy capture. An existing enrollment is not disconnected by a
local setup; the guide states this and names `hyp leave`.

## Choice parity {#parity}

Agent setup offers the same applicable choices as the attended wizard and
reuses answers already given. It offers detected defaults or customization,
local versus cloud collection, per-client sharing, new-folder review policy,
optional history import, GitHub collection, the first-sync review/send-now
offer, and the closing skill recommendation. Storage and retention remain
explained defaults, with 120 days local and 90 days cloud unless overridden.
Cloud sync is the recommended choice, presented before local only; examples
use cloud retention and explicitly require the separate enrollment step.
The agent confirms the choice before enrollment and honors an existing
local-only preference. A fresh config being local until login is a mechanism,
not a recommendation to stop with local-only setup.
The first-look uses `hyp query overview --json`; incomplete results are stated.
Needs-setup descriptors name their standalone configure command so the agent
can run it sequentially and arrange any human handoff.

GitHub is a separate opt-in even when the person accepts recording defaults.
`hyp setup --github` alongside the chosen sources composes the same GitHub and
context-graph plugins as the attended offer, before the guarded config write
and daemon installation. It never starts a browser: the agent runs login
after cloud enrollment, keeping the ordering in #handoffs. `--yes` alone does
not enable GitHub. `--from-file --github` applies the same opt-in to the
validated input config, preserving other fields and the overwrite guard.
Re-enabling existing entries preserves their settings without duplicating them.

`--no-backfill` defers only optional one-time imports, the same subset the
attended wizard allows the person to decline. Providers with scheduled recovery
still get their initial import and scheduled sweeps; this flag does not change
their window or schedule. It is not a promise to stop automatic history import.

Closing offers keep their existing human requirements. The agent shows the
sync dry-run and offers sending now or waiting, but the person must confirm
an early first-sync release in a terminal. After sign-ins and verification,
the agent offers `hyp ask` in an interactive terminal when recorded history and
a launchable client exist, with a terminal handoff if needed.

## Human handoffs {#handoffs}

The agent asks the person about capture and sharing, then executes the
existing flags and privacy commands. It explains harness approval prompts
and macOS trust dialogs. It never guesses an org or requests secrets in chat.

When sync is chosen, cloud enrollment defaults to `hyp remote login --browser`
so it opens the authorization page even with piped stdin. The agent explains
each sign-in and runs them sequentially: cloud first, then GitHub if requested
and enabled. It waits for each command's completion and checks its result;
failure, cancellation or timeout must be resolved or explicitly skipped before
the next sign-in starts. Sign-ins never run in parallel.

After setup with `--github`, the agent checks `hyp github status` and skips
login when authentication is already available. Otherwise it runs
`hyp github login` after cloud sign-in finishes or is skipped, opening the
browser and printing the device code. After login it verifies authentication
and restarts the daemon if setup started it, so cached credential state reloads.
A failed browser launch falls back to the printed
URL while the same command waits. Headless machines use the respective login
command's `--no-browser` flag. If the harness cannot keep a command running,
the agent gives it to the person and waits for their result before starting
another sign-in. Login's existing first-sync review remains authoritative.
Folder and client privacy choices use existing `hyp privacy` commands.

## Observability and performance {#verification}

The guide emits `wizard.setup.guide` with component, operation, guide-only
skip reason and exit code. It does not log paths, detected client names,
authorization URLs or codes. Discovery and detection run once per guide;
work and retained memory are bounded by the bundled picker catalog.

Traditional tests cover detection, platform filtering, config preservation,
no detected sources, explicit guide routing and handoff commands. Sandbox
checks exercise preview and install without the real launchd/keychain.
Fresh-agent and real-browser tests remain manual acceptance checks.
