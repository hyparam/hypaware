# LLP 0563: One source for client skills

**Type:** Spec
**Status:** Active
**Systems:** Plugins, CLI
**Author:** Brendan / Codex
**Date:** 2026-10-28
**Extends:** LLP 0197#t2-premise-corrected, LLP 0494#skills

## Request

Maintain the latest HypAware skills in one authoritative location for all
clients, preserving improvements from every existing source tree.

## Single source

`hypaware-core/skills/` owns the query, reference, privacy, and report skills.
Claude and Codex register that same tree, as the other supported skill clients
already do. Client-specific installation destinations remain unchanged.

Shared instructions and references are maintained once. Client-specific
privacy protection procedures live in `hypaware-privacy/claude.md` and
`codex.md`, selected explicitly by the shared entry point. Report delegation
rules and Codex cache-permission guidance retain explicit client conditions.
Preserve existing discovery triggers and routing requirements, along with the
neutral tree's CLI/MCP guidance. Do not derive one client's privacy rules from
another client's rules.

This replaces the separate source trees and divergence fixture of LLP 0197
and LLP 0494. Keep the content and executable privacy-script constraints;
verify every client registers the common source and installs every file.
Repository development skills and plugin-specific Gascity skills are outside
this consolidation.

## Verification

Run the traditional suite, including full-file installation checks for all
eight skill clients and existing privacy-script regressions. Static discovery
checks do not establish routing in a fresh agent session; report that gap when
fresh-session verification has not been performed.

## CPU and memory

Registration remains a fixed four entries per client. No runtime rendering,
filesystem scanning, new cache, or per-record work is added. Installation
copies a bounded shared tree; the package loses duplicate skill trees.
