# LLP 0405: Unversioned Global CLI Install

**Type:** Spec
**Status:** Accepted
**Systems:** Onboarding, Daemon
**Author:** Phil / Codex
**Date:** 2026-09-12
**Related:** LLP 0404

## Command

The user requested removal of the version suffix from the global install command.
Extend LLP 0404 #install-policy: offer and execute `npm install -g hypaware`,
and use that same unversioned command in progress messages and repair advice.
The installed version is resolved by npm rather than pinned to the running CLI.

Existing consent, force, daemon-path, and shell-availability behavior remains
as specified in LLP 0404. The command-runner test checks the actual npm arguments
as well as the displayed command. This changes no CPU or memory bounds.
