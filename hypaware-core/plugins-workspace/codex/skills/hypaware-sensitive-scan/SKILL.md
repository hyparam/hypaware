---
name: hypaware-sensitive-scan
description: Scan HypAware recordings for sensitive content (secrets, credentials, secret-file reads, PII, private-repo code) and recommend what to opt out of recording - a folder-scoped `.hypignore` / `hyp ignore <path>` for directory-bound exposure, or a per-session opt-out for one-off sensitive sessions. Use when the user says "scan my logs for secrets", "what should I hypignore", "did I record anything sensitive", or wants ignore recommendations grounded in recorded data. REDACTS every secret (never echoes a value). Recommends PROSPECTIVE opt-outs only - it does NOT purge already-recorded rows. Asks which source to scan (local logs or a remote server) first.
---

# Scan recordings for sensitive data, recommend ignores

Turn a window of recorded AI-gateway exchanges into a short, ranked answer to one
question: **what sensitive content did HypAware capture, and where should the user
turn recording off so it stops happening.** The deliverable is copy-paste ignore
commands grouped by scope, not a saved report.

IMPORTANT: Both ignore mechanisms are **prospective only** - a `.hypignore` and the
session opt-out gate *future* recording; neither purges rows already in the cache
(LLP 0049 §prospective-only). So the sensitive rows you find stay captured. Say this
plainly and never imply the scan removes anything.

IMPORTANT: **REDACT everything.** Never echo a secret, token, key, credential, or raw
PII value - not in a finding, not from `content_text`, not from `tool_args`. A secret
appearing in the recording *is* the finding; name the scope and class, quote nothing.

IMPORTANT: **Ask which source first.** List the data sources and let the user choose:
**local logs** (this machine, `hyp query sql …`, no `--remote`) and each remote
HypAware server (every `hyp remote list` target, plus any hypaware MCP `query_sql`
tool already in your toolset; the same server can appear both ways - list it once).
Query mechanics are step 0 of the procedure — a mandatory read, not a reference.

## What counts as sensitive (match over `content_text` AND `CAST(tool_args AS VARCHAR)`)
| Class | Match signals | Why it matters |
| --- | --- | --- |
| Secret in payload | `AKIA…`, `sk-…`, `ghp_…`/`gho_…`, `xox[baprs]-…`, `-----BEGIN … PRIVATE KEY-----`, `Bearer <token>`, `password=`/`api_key=`, `postgres://user:pass@` | a live credential now sits in the cache |
| Secret-file read | reads of `.env`, `id_rsa`, `.ssh/`, `.aws/credentials`, `.netrc`, `*.pem`, `*.key`, `credentials.json` | key/config contents captured verbatim |
| PII | email, phone, national-id and card-like number runs | personal data captured |
| Private code / infra | private `git_remote`, internal hostnames, connection strings, non-public source paths | proprietary IP in the cache |

## Procedure
0. **Load query mechanics BEFORE the first query — skills, not memory.** After the user picks a
   source and before any `hyp query sql`, read the **hypaware-query** skill (invoke it or Read
   its SKILL.md), and the **hypaware-graph** skill if `hyp query status` lists `node`/`edge`
   datasets. Memory notes from past runs do NOT substitute — stale notes have cost real runs
   failed queries and server crashes (a phantom "100-row output cap"; message-table `cwd` scans
   that 504'd then OOM'd the prod server). This scan's core job IS reading wide columns
   (`content_text`, `tool_args`) — keep those queries aggregate-shaped regex matches over
   **date-sliced, server-sized ranges** (especially against a remote server), never bulk
   row-fetches of raw content; the step-2 rollup GROUP BY is on scope keys, not content. Use the
   graph's tiny `node`/`edge` tables for the scope inventory where projected (which
   sessions/cwds/repos exist, session→directory attribution via Session nodes' `props.cwd`)
   instead of DISTINCT-scanning message columns. Capture stderr and check it even on success —
   truncation and server-cap notices land there, and a clipped scan reads as "no hits". If a
   query fails, come back to this step; don't iterate on the failing SQL.
1. **Pick the source** (above), then a **baseline**: window; total rows; distinct
   `repo_root` / `cwd` / `session_id`; coverage of `content_text` and `tool_args` (a
   sparse column bounds what the scan can see - say so). State N.
2. **Scan.** Match each class over `content_text` and `CAST(tool_args AS VARCHAR)`
   (`tool_args` is JSON that may hold a plain string - never `JSON_EXTRACT` it; regex
   the cast text per the hypaware-query dialect notes). For every hit, capture the
   **scope keys** `repo_root` (fallback `cwd`), `session_id`, and `class` - **not** the
   matched value. Roll up hit counts per `(scope, class)` and per `(session_id, class)`.

   ```sql
   SELECT repo_root, cwd, session_id,
          count(*) AS hits
   FROM ai_gateway_messages
   WHERE regexp_matches(coalesce(content_text,'') || ' ' || CAST(tool_args AS VARCHAR),
           '(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-|postgres://[^:]+:[^@]+@)')
   GROUP BY repo_root, cwd, session_id
   ORDER BY hits DESC
   ```
3. **Route each scope to a recommendation.** Two shapes, matched to how the exposure is
   bound:
   - **Directory-bound** (a `repo_root`/`cwd` that keeps producing hits across sessions,
     or is inherently sensitive - a secrets repo, an infra tree) -> a **folder
     `.hypignore`**, durable and committable/team-wide.
   - **One-off** (hits isolated to a single `session_id` in a directory the user would
     not want permanently ignored) -> a **per-session opt-out** at session start.

## Recommendations (the output)
Print findings **most sensitive first** (weight: live-credential > secret-file > PII >
private-code; break ties by hit count and by how many distinct sessions a scope spans).
All examples redacted. Two groups, then the caveat:

- **Folder ignores** - one line per scope: a redacted headline (`<class> in <repo_root>,
  N hits across M sessions`) followed by the copy-paste command on its own line:
  ```bash
  hyp ignore <repo_root>        # writes a committable .hypignore; covers all future sessions in this tree
  ```
  Note that an empty `.hypignore` at the repo root does the same for the whole repo, and
  that folder matching keys on `cwd`/`repo_root` (Claude + Codex only; a no-op for
  raw-proxy / OTEL sources, which carry no `cwd` - LLP 0049 §non-goals).
- **Session opt-outs** - for one-off sensitive work in a directory the user won't
  permanently ignore. The in-session opt-out skill (`/hypaware-ignore`, reversed with
  `/hypaware-unignore`) ships for Claude sessions only; for one-off work in Codex,
  recommend a narrow folder ignore instead (`hyp ignore <subfolder>`, removable with
  `hyp unignore` once the sensitive work is done).
- **Caveat (always).** The sensitive rows above are **already recorded**; ignoring is
  prospective and does not delete them. Show the residual with
  `hyp ignore --check <path>` (reports the governor and how many cached rows from the
  scope remain). Retroactive purge is out of scope.

## Notes
- Redaction is absolute; a raw secret in `tool_args` is itself worth flagging (the
  gateway captured it) - name it, don't reproduce it.
- Read stderr on every query (staleness / row-budget notices land there); an empty
  stdout is not the same as zero hits.
- Keep the pattern set honest: a high-recall regex over free text produces false
  positives (an example string, a doc). Spot-check counts before recommending an ignore,
  and prefer recommending the *scope* over asserting a specific leak you cannot verify.
