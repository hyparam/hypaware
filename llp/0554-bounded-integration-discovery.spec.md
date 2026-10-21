# LLP 0554: Bounded integration discovery

**Type:** Spec
**Status:** Draft
**Systems:** Onboarding, CLI, Plugins
**Author:** Phil / Codex
**Date:** 2026-10-21
**Extends:** LLP 0130, LLP 0548, LLP 0553

## Picker probes {#picker-probes}

@ref LLP 0130#picker-block [extends]: keep detection declarative and evaluate
metadata in core without executing clients, application code or plugin hooks.
Presence still seeds the normal picker choice; it does not attach or grant
capture. Existing configured choices still win over detection.

Add `vscode_extension` for an installed extension identifier. Copilot uses
`github.copilot-chat` in local Stable/Insiders extension catalogs, honoring
VSCODE_PORTABLE and VSCODE_EXTENSIONS. A bare home, VS Code directory, CLI
receipt, or project extension recommendation is not evidence. Relocated
extension directories passed only to the editor's CLI are not guessed.
Installation does not prove that the extension is enabled or that recording
works; the existing attach and capture-health checks remain necessary.

Add `project_dependencies` with optional `npm` and `python` package names.
LangGraph checks only the invoking project directory: direct dependency maps
in package.json, requirement lines in requirements.txt, or the standard
[project] dependencies string array in pyproject.toml. It never walks parent
projects, follows requirements includes, opens lockfiles or imports a package.
The Python recognizer deliberately accepts a conservative syntax subset:
dynamic metadata, escaped/multiline TOML strings, optional dependency tables,
Poetry tables and alternate requirement filenames need explicit selection.
The generated HypAware callback module is not installation evidence.
Detection does not prove the dependency is installed. Setup still prints the
callback the application must use before recording can begin.

Each file read is capped at 256 KiB, including concurrent growth, and must be
a regular file rather than a symlink or special file. Missing, unreadable,
oversized or unsupported metadata is not detected. Work is bounded by the
catalog and a fixed number of files per probe, with no persistent state.

## NanoClaw discovery {#nanoclaw-discovery}

@ref LLP 0553#capture [extends]: keep config.root explicit; add a read-only
`hyp client discover nanoclaw [root] [--json]` command usable before setup.
An explicit root is checked alone. Otherwise inspect the configured root and
current-directory ancestors, at most eight candidates total. No sibling,
home-directory or disk crawl, environment-root invention, or auto-activation.

Reuse the adapter's read-only catalog validator: at most 64 MiB, 1,024 groups,
bounded identifiers and contained host workspaces. Require at least one
contained Claude projects directory. A database filename alone or an empty
catalog is insufficient. Discovery reads no transcripts, changes no config,
and reports canonical roots for the user to choose. A relocated or deeper
installation can always be passed explicitly. An uninitialized or malformed
installation remains explicitly configurable but is not suggested.

The command records candidate/root counts and outcome, without logging root
paths or group identities. CPU/memory are bounded by eight catalog checks
and the existing group bounds; no new poller, network call or runtime package.

## Choices that remain explicit {#explicit-choices}

ChatGPT Work keeps LLP 0511's explicit selection and account-origin grant;
Codex installation does not prove Work usage. GitHub keeps LLP 0411's separate
offer, since remotes or gh authentication neither authorize capture nor add
value to an offer already shown. Gas City remains explicit: its production
transport is still a no-op, so discovery would imply a capability it lacks.
Generic OTEL and hidden raw-provider routes have no independent installation
to detect. Sinks, encoders and helper plugins are not missing client probes.
