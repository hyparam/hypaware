# GitHub merge queue for HypAware

Date: 2026-08-19

## Recommendation

Enable GitHub's native merge queue for `master`, but treat it as the landing
mechanism, not the control on how much work Neutral creates. Pair it with a
hard Neutral WIP limit and a rule that review findings normally stay in the
current PR or become backlog issues, rather than immediately spawning another
PR.

The queue directly removes the need to keep every approved branch rebased or
merged with the latest `master`. GitHub builds a temporary merge group from the
current base plus earlier queued PRs and runs required checks on that combined
state. A failed or timed-out group ejects the offending PR and regenerates
affected later groups. See GitHub's [merge queue documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

It does not reduce review demand, detect duplicate work, or limit PR creation.
Those are Neutral policy problems.

## Current repository shape

Live GitHub inspection on 2026-08-19 found:

- 46 open PRs: 32 non-draft and 14 draft
- 17 PRs labeled `neutral:approved` and 9 labeled `neutral:stuck`
- 35 open PRs created since 2026-08-18
- 21 PRs merged on 2026-08-19 at the time of inspection
- no repository rulesets
- legacy `master` protection with no required checks, no required approvals,
  and strict up-to-date checking disabled

The CI workflow currently listens to unrestricted `push` as well as
`pull_request`, so a commit to a PR branch launches the four Node matrix jobs
twice. This was visible on PRs 953 and 954. The LLP workflow scopes `push` to
`main` and `master`, which avoids that duplication. Neither workflow handles
`merge_group` yet.

## Required setup

1. Change required Actions workflows to run on `pull_request` and
   `merge_group`, with `push` limited to `master`. GitHub explicitly requires
   the [`merge_group` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)
   for required Actions checks on queued merge groups.
2. Make one stable, always-reported aggregate check required by branch
   protection, or require every stable matrix context. A required workflow
   skipped by a path or branch filter can remain pending and block the queue;
   GitHub documents the [skipped required-check behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks).
3. Add `Require merge queue` to the exact `master` branch protection rule or a
   repository-level ruleset. GitHub supports merge queues for public
   organization-owned repositories. The rule is not available in
   organization-level rulesets, and branch protection patterns containing `*`
   cannot enable it. See [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue)
   and [branch protection setup](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule).
4. Keep `Require branches to be up to date` disabled. GitHub recommends this
   with a merge queue because the queue already validates against the current
   base and strict updating causes repository-wide mergeability recalculation.
   See GitHub's [repository limits guidance](https://docs.github.com/en/enterprise-cloud@latest/repositories/creating-and-managing-repositories/repository-limits#pull-requests-limits).

Suggested initial queue settings:

- squash merge
- build concurrency: 1
- minimum group size: 1
- maximum group size: 1
- required-check timeout: 10 minutes
- do not jump PRs to the front except for emergencies

The current checks finish in about a minute, so conservative settings should
still drain faster than review work arrives while keeping failures attributable
to one PR. After a week with few ejections, raise the maximum group size to two
or three. Queue settings support 1 to 100 concurrent builds and 1 to 100 PRs per
merge group, but larger speculative groups increase reruns when an earlier group
fails. The controls are described in [managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#managing-a-merge-queue).

## Neutral controls that matter more than the queue

- Maintain at most four reviewable or approved PRs at once. When all slots are
  occupied, Neutral may record findings as issues but must not open another
  implementation PR.
- Only `neutral:approved` PRs enter the merge queue. Once queued, freeze the
  head unless GitHub ejects it.
- Treat `neutral:stuck` as frozen draft work. Do not spend CI or reconciliation
  effort keeping it mergeable.
- Fix in-scope review findings in the current PR. Convert unrelated,
  non-critical findings to backlog issues and do not implement them until a WIP
  slot opens.
- Use one integration PR per change set. Task branches can stay internal to the
  integration branch instead of becoming independent review surfaces.
- Prevent concurrent active PRs with strongly overlapping paths unless one is
  explicitly stacked on the other.
- Track ready-PR count, median ready age, queue ejections, CI runs per merged PR,
  and the ratio of review findings that become new PRs.

GitHub auto-merge alone does not provide the same ordered combined-state test.
Stacking tools can help represent real dependencies, but they do not limit WIP
or the review feedback loop. Native merge queue plus Neutral-side flow control
is the smallest intervention that addresses both failure modes.
