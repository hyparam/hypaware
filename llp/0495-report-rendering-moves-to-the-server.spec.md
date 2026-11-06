# LLP 0495: Report rendering moves to the server

**Type:** Spec
**Status:** Draft
**Systems:** Reports, CLI
**Date:** 2026-10-13
**Supersedes-in-part:** LLP 0451#server-rendering

## Ownership {#ownership}

The local render command remains retired. Move the renderer, types, assets and
rendering regression tests into HypAware Server, which is their remaining
production caller. Remove the `hypaware/core/reports` export and the client's
marked dependency. The server records its half in LLP 0600.

Local reports remain Markdown artifacts that users save and upload. No report
skill changes, new client rendering command or replacement HTML export accompany
this move. Deploy the server's internal import migration before removing the
client export from a release consumed by older servers.

## Validation and performance {#validation}

Keep CLI retirement checks and assert that the package no longer exposes the
renderer or contains its assets. Run client typecheck and tests. Rendering
regressions and output compatibility are checked in the server repository.
The client removes shipped code and adds no CPU work or retained memory.
