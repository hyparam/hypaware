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
The interactive wizard and flag-driven installation retain their contracts.

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

## Human handoffs {#handoffs}

The agent asks the person about capture and sharing, then executes the
existing flags and privacy commands. It explains harness approval prompts
and macOS trust dialogs. It never guesses an org or requests secrets in chat.

Cloud enrollment uses `hyp remote login --no-browser` or `--browser` so piped
stdin cannot select static-token login. Unattended setup does not enable
GitHub collection; once the person enables it, GitHub uses `hyp github login
--no-browser`. The person follows the printed URL/device code while the
command waits. If the harness cannot keep it running, the agent gives the
person the command. Login's existing first-sync review remains authoritative.
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
