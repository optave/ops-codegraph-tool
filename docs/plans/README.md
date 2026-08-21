# Delivery plans

Committed, per-issue implementation plans. One file per task, named after the task id the
`/oversee` skill assigns (`issue-<n>.md`), written by the planner agent and reviewed by a human
before any code is built.

## Why plans live in the repo

A plan in a chat transcript is unreviewable, undiffable, and gone the moment the context clears.
A plan committed here is a normal PR: Greptile reviews it, an independent critic agent reviews
it, a human approves it with a checkbox, and the execute PR is built on top of the approved
commit. When a plan later goes stale, the diff between what it assumed and what is now true is a
`git diff` rather than an argument.

## Lifecycle

1. `/oversee #<issue>` dispatches a planner. It writes `docs/plans/issue-<n>.md` from
   [`task-plan.template.md`](task-plan.template.md) and opens a `[Plan]` PR.
2. An independent critic reviews the plan adversarially; fixable findings are revised in place.
   The critic's verdict is **advisory** — it is shown to the human, it never auto-approves.
3. Greptile reviews the `[Plan]` PR; the plan-sweep stage addresses that feedback so the human
   reviews a reviewer-clean plan.
4. A human ticks **APPROVED FOR EXECUTION** on the `[Plan]` PR.
5. `/oversee #<plan-PR>` re-validates the plan is still fresh, then builds on top of the
   approved commit. The execute PR carries the plan doc **and** the code, so one merge lands
   both.

A plan PR never uses a GitHub closing keyword — merging a plan does not complete the issue.
Only the execute PR carries `Closes #<n>`.

## Conventions

- **Filename:** `issue-<n>.md`, matching the tracking issue number.
- **Header:** the four-line block from the template. The `**Tracking:**` line is load-bearing —
  the staleness validator anchors on it, and a plan without it is treated as UNVERIFIABLE and
  never executed.
- **Status:** update the `**Status:**` line as the plan moves Draft → In Review → Approved →
  In Progress → Complete. A completed plan stays in the repo as the record of what was built and
  why.
- **Superseded plans:** when a plan is rejected as stale, its `[Plan]` PR is closed and its
  research is distilled into a `plan-carry-forward` comment on the tracking issue, so the next
  round starts warm instead of re-deriving every citation.

## Related

- [`.claude/skills/oversee/SKILL.md`](../../.claude/skills/oversee/SKILL.md) — the skill that drives
  this lifecycle, including the approval gate and the staleness check.
- [`.claude/workflows/oversee-dispatch.js`](../../.claude/workflows/oversee-dispatch.js) — the engine
  that dispatches the planner, critic, builder, verifier, and sweep agents.
- [`../roadmap/ROADMAP.md`](../roadmap/ROADMAP.md) — the phase a plan's task belongs to, when it has one.
- [`../architecture/decisions/`](../architecture/decisions/) — the ADRs a plan cites and must not
  contradict.
