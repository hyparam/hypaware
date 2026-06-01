---
name: llp-review
description: Review an existing LLP document using a standard review prompt that asks about strengths, concerns, missing considerations, and open questions. Saves the review as a dated artifact for later reference.
---

# llp-review

Use this skill when the user wants a structured review of an LLP document. The review uses a standard prompt designed to elicit substantive feedback rather than surface-level commentary, and the result is saved as a file so reviews accumulate as a durable artifact.

Invoke as `/llp-review <identifier>` where `<identifier>` is an LLP number, slug, or filename. If omitted, the skill lists Draft and Review LLPs and asks which to review.

## Ground rules

- LLPs live in `llp/` (and any additional directories the project's root LLP or `CLAUDE.md` indicates).
- LLP filenames follow `NNNN-slug.type.md`.
- Reviews are saved under `notes-archive/llp-reviews/<slug>.round-N.claude.md` where `<slug>` is derived from the LLP filename by stripping the `NNNN-` prefix and the `.type.md` suffix.
- Reviews are numbered per-LLP starting at `round-1`. Increment to `round-N+1` if prior rounds exist.
- A single LLP may have multiple reviews from different models or different rounds — that's expected.

## The standard review prompt

Apply this review prompt to the LLP being reviewed:

> What do you think of this proposal? Is it a good idea? Do we have a good plan here? How would you change it to make it better? What would you add or take away or change? Is anything definitely or possibly wrongheaded here? Do you have any novel ideas that you think might make this way better even if they are a bit non-standard? What are the key open questions we need to answer to refine this?

Adapt the phrasing slightly if the LLP type is not a proposal (e.g., Research — "What do you think of this analysis? Are the findings sound?" Decision — "Do you agree with this choice?"). The intent is to get substantive feedback that the author can act on, not to produce a checklist.

## Workflow

### 1. Locate the LLP

Accept any of these identifiers:

- A number: `0042`, `42`, `LLP 0042`
- A slug: `token-rotation`
- A filename fragment: `0042-token-rotation`
- A full path: `llp/0042-token-rotation.rfc.md`
- Nothing — list all `Draft` and `Review` LLPs and ask the user to pick one

Scan `llp/` recursively. Match by number first (exact), then by slug substring (case-insensitive). If multiple match, ask the user to disambiguate.

### 2. Read the LLP

Read the full file. Do not skim.

### 3. Produce the review

Structure the review as:

```markdown
# Review of LLP NNNN: <Title>

**Reviewer:** Claude (<model version if known>)
**Date:** YYYY-MM-DD
**Round:** <N>
**LLP Status at review time:** <Draft | Review | etc.>

## Overall assessment

One or two paragraphs on the proposal as a whole. Is it a good idea? Is the plan sound? What's the big-picture reaction?

## Strengths

- Concrete things the LLP gets right — specific sections, specific decisions, specific arguments.
- Be specific, not generic. "Good summary" is not useful; "the summary correctly identifies the trade-off between X and Y" is.

## Concerns

- Substantive issues. Things that seem wrong, underdeveloped, or likely to cause problems.
- Distinguish between "definitely wrong" and "possibly wrong." Mark each concern with severity.
- For each concern, say what would resolve it.

## Suggestions

- Changes the author might consider: additions, removals, reorganizations, alternative approaches.
- Novel ideas that might improve the design, even if non-standard.
- Prioritize suggestions — which ones matter most?

## Open questions

- Questions the LLP doesn't answer but needs to.
- Assumptions the LLP makes without justifying.
- Decisions that are still implicit and should be made explicit.

## Recommended next step

- Does the LLP need revisions before moving forward? (Stay `Draft`)
- Is it ready for a different model's review? (Move to `Review` if not already)
- Is it ready for acceptance? (Move to `Accepted`)
- Is it fundamentally misconceived? (Consider `Withdrawn` or major rewrite)
```

Lead with findings, not with process. A reader scanning the review should see the overall assessment, strengths, and concerns first.

### 4. Save the review artifact

Determine the save path:

1. Strip the `NNNN-` prefix from the LLP filename. Example: `0042-token-rotation.rfc.md` → `token-rotation.rfc.md`.
2. Strip the trailing `.md`. → `token-rotation.rfc`.
3. The slug is now `token-rotation.rfc` (or just `token-rotation` if the project convention strips the type too — follow whatever convention exists in the existing `notes-archive/llp-reviews/` directory).
4. Count existing files matching `notes-archive/llp-reviews/<slug>.round-*.claude.md`. The next round is one higher than the max found.
5. Final path: `notes-archive/llp-reviews/<slug>.round-<N>.claude.md`.

Create the directory if it doesn't exist.

Write the review to that file.

### 5. Present the review to the user

Show the full review in the conversation. Also show the path where it was saved so the user can find it later.

### 6. Suggest status transitions

Based on the review's recommended next step:

- If concerns are significant: "This LLP likely needs revisions. Consider addressing the concerns and requesting another review."
- If the review is positive and the LLP is `Draft`: "Consider moving this to `Review` and requesting reviews from additional models before acceptance."
- If the LLP is already in `Review` and this round looks good: "This LLP looks ready for acceptance. Remember that the project's RFC process may require reviews from multiple models — check LLP 0005 or the project's RFC process guide for the specific requirements."

Always remind the user that if the project uses the multi-model review process (LLP 0005 or equivalent), a single AI review is not sufficient for acceptance — human judgment and additional model reviews are part of the process.

## Scope limits

- Do not change the LLP's `Status` field yourself. Suggest transitions; leave the change to the user.
- Do not claim an LLP is accepted or that a review process is complete.
- Do not overwrite existing review artifacts. Always increment the round number.
- Do not invent content that isn't in the LLP. Quote or paraphrase to ground the review in the actual text.
- Do not critique the LLP type or format choices unless the user asks — focus on the content.
