# LLP 0404: Durable CLI Setup

**Type:** Spec
**Status:** Accepted
**Systems:** Onboarding, Daemon
**Author:** Phil / Codex
**Date:** 2026-09-12
**Related:** LLP 0002, LLP 0011, LLP 0017, LLP 0299
**Extended-by:** LLP 0405 (use an unversioned global install command)

## Request

Extend LLP 0002 #daemon-install and LLP 0017
#install-global-package-then-service-manager: detect project-local installations
as well as npx, and let the user deliberately retain either installation when
establishing a global CLI is declined or fails. Skipping the daemon would leave
background capture inactive and is not an acceptable substitute for that choice.

## Install policy

The shared daemon installer detects temporary CLI paths using the existing
npx and project-tree predicate. It does not add a persistent configuration key.

- Interactive installation offers the same running package version globally.
- If declined or unsuccessful, explain that deleting the installation tree or
  pruning the npm cache can break background capture and management commands.
  Continue with the original CLI path only on an explicit yes. This second
  question defaults to no, extending LLP 0299's default-yes convention because
  proceeding accepts a service that may disappear with its installation.
- Headless installation attempts the global install. If it cannot establish the
  durable CLI, fail unless `--force` allows the original installation path.
  Setup's existing `--force` also retains its config-overwrite meaning.
- Refusing the temporary path stops setup before client attachment and backfill.
  Configuration already written by setup is retained. The failure exits nonzero.
- Explicit `--bin` remains an intentional entrypoint override. Dry runs only
  render, and read-only commands do not install packages or ask these questions.

The existing project-tree predicate also recognizes some pnpm/yarn global
layouts as potentially temporary. Warnings name the actual path and conditional
removal consequence rather than claiming every such tree belongs to a project.

## Shell availability

A running daemon and a CLI available from the shell are separate outcomes.
Ignore npm's temporary node_modules PATH additions when checking availability.
If the durable commands cannot be confirmed to resolve to the selected CLI,
print an actionable repair and an absolute command for managing this installation.
For a newly installed global CLI, print the bin directory's PATH addition.
Do not edit shell startup files. The current process cannot prove the environment
of a future terminal; guidance must not claim that it has tested one.

No postinstall hook is added: this change takes effect when the user invokes
HypAware, not while npm merely downloads a local dependency.

## Validation and cost

Traditional tests cover both installation types, successful promotion, consent,
refusal, headless failure, force fallback, service paths, and PATH guidance.
CLI checks use existing bounded path walks, only at installation time. npm
output retained for errors is capped; no probe or timer is added to daemon work.
