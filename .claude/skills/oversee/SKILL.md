---
name: oversee
description: Human-gated, single-issue delivery. Preflights the session config (Opus, effort >= xhigh, auto-accept), then runs PLAN -> adversarial critic -> plan-sweep and STOPS for a human to approve the plan via a checkbox on the [Plan] PR. Re-invoked on the plan PR (after the box is ticked) it verifies non-forgeable approval provenance, revalidates that the approved plan is still FRESH via a read-only Sonnet subagent, then runs EXECUTE -> VERIFY -> execute-sweep pinned to the approved commit. Reviewer convergence is reconciled re-entrantly, one scheduler-paced batch per invocation. On `/oversee --verify #<execute-PR>` it re-runs independent VERIFY on that execute PR's current head (same `verifyPrompt` agent; this skill never POSTs `pipeline/verify`). Never merges.
argument-hint: "[--plan | --execute | --verify] <#issue | #plan-PR | #execute-PR>"
allowed-tools: Bash, Read, Glob, Grep, Workflow, AskUserQuestion, Agent, ScheduleWakeup
---

# /oversee — human-gated, single-issue delivery for codegraph

`/oversee` takes **one** GitHub issue from "nobody has planned this" to "a verified, reviewer-clean PR waiting for a human merge", with exactly **one** human decision in the middle: **does this plan get built?** Everything else — planning, adversarial plan review, reviewer sweeps, the build, independent verification, review convergence — runs automatically.

It is the human-in-the-loop counterpart to [`/fixer`](../fixer/SKILL.md). The two are complementary, not interchangeable:

| | `/fixer` | `/oversee` |
|---|---|---|
| Scope | the whole qualifying backlog, in batches | exactly one issue |
| Plan | none — solve directly | a committed plan doc, reviewed and human-approved before any code |
| Human decision | none until the final report | one: tick the approval box |
| Merge | merges each PR itself | **never merges** — the human does |

Use `/oversee` for work where getting the *approach* wrong is expensive: anything touching the dual-engine boundary, resolution semantics, the language registry, a public API, or an architectural decision. Use `/fixer` for a backlog of self-contained fixes.

You are split in two:

- **You (this skill) are the gating brain.** You preflight the session config, route the run, run a readiness check, drive the human approval gate, verify its provenance, validate plan freshness, and reconcile the reviewer after execution. **You never write product code.**
- **[`oversee-dispatch`](../../workflows/oversee-dispatch.js) is the execution engine.** You hand it one task plus a `phase`, and it runs that half of the pipeline.

```text
/oversee #<issue>    ─preflight─▶ sync main ─▶ readiness ─▶ PLAN ─▶ critic (advisory, revise-in-place)
                                                                 ─▶ plan-sweep ─▶ [Plan] PR + ✋ approval box ─▶ STOP
                                                                                   │  (a human ticks the box)
/oversee #<plan-PR>  ─preflight─▶ sync main ─▶ box ticked? ─▶ provenance? ─▶ freshness gate (Sonnet subagent)
                                                                 ├─FRESH──▶ EXECUTE (pinned to approved SHA) ─▶ VERIFY ─▶ execute-sweep ─▶ reconcile ─▶ STOP (human merges)
                                                                 ├─NARROW─▶ patch the plan in place ─▶ re-stamp the gate ─▶ STOP (needs a fresh tick)
                                                                 └─STALE──▶ carry-forward ─▶ close the [Plan] PR ─▶ re-PLAN ─▶ STOP (needs a fresh tick)
```

Two things make this worth running instead of just asking an agent to fix an issue:

1. **A preflight config gate** runs before any compute is spent.
2. **The human is the plan gate, and the gate cannot be forged.** The critic is *advisory* — its verdict is printed next to the checkbox, it never auto-advances. EXECUTE runs only after a human ticks the box, and only when a commit status the PR body's author cannot write proves the gate was installed by an `/oversee` run for that exact plan head.

---

## Arguments

Parse `$ARGUMENTS` into these state variables, persisted to `.codegraph/oversee/` — bash blocks do not share shell variables, so every value one phase needs from another is written to a file.

| Token | File | Default | Meaning |
|-------|------|---------|---------|
| first bare integer | `.codegraph/oversee/arg` | — (required) | The issue number (PLAN phase) or the `[Plan]` PR number (EXECUTE phase) |
| `--plan` | `.codegraph/oversee/forced-phase` = `plan` | auto-detect | Force the PLAN phase |
| `--execute` | `.codegraph/oversee/forced-phase` = `execute` | auto-detect | Force the EXECUTE phase |
| `--verify` | `.codegraph/oversee/forced-phase` = `verify` | auto-detect | Re-run independent VERIFY on an execute PR |

`--plan`, `--execute`, and `--verify` are exclusive.

A number is either an issue **or** a PR (GitHub shares the numbering), so the phase is normally auto-detected in Phase: Route. One run handles **one** task.

```bash
mkdir -p .codegraph/oversee
ARGS="${ARGUMENTS:-}"

ARG_N=$(printf '%s\n' "$ARGS" | tr ' ' '\n' | grep -E '^#?[0-9]+$' | head -1 | tr -d '#')
if [ -z "$ARG_N" ]; then
  echo "ERROR: /oversee needs one number — an issue to plan, or a [Plan] PR to execute."
  echo "Usage: /oversee [--plan|--execute|--verify] <#issue | #plan-PR | #execute-PR>"
  exit 1
fi
printf '%s\n' "$ARG_N" > .codegraph/oversee/arg

FORCED=""
case "$ARGS" in
  *--plan*)    FORCED=plan ;;
esac
case "$ARGS" in
  *--execute*) [ -n "$FORCED" ] && { echo "ERROR: --plan, --execute, and --verify are mutually exclusive."; exit 1; }
               FORCED=execute ;;
esac
case "$ARGS" in
  *--verify*)  [ -n "$FORCED" ] && { echo "ERROR: --plan, --execute, and --verify are mutually exclusive."; exit 1; }
               FORCED=verify ;;
esac
printf '%s\n' "$FORCED" > .codegraph/oversee/forced-phase

echo "oversee: target #$ARG_N, forced-phase='${FORCED:-auto}'"
```

**Exit condition:** `.codegraph/oversee/arg` holds a bare number and `.codegraph/oversee/forced-phase` exists (possibly empty).

---

## Phase 0 — Pre-flight

Three session-config gates and a tooling check. Run these **before any compute is spent**. On any hard failure, STOP and print the exact fix — do not start the pipeline.

### 0a. Session config

1. **Model — HARD GATE (must be Opus).** Determine the model you are running as (it is stated in your own environment context). If its id does **not** start with `claude-opus-`, **STOP**:
   > "/oversee needs an Opus model: this session parses an authorization gate, judges plan readiness, and decides whether to destroy an approved plan. Switch to Opus, then re-invoke `/oversee`."

   Never proceed on Sonnet or Haiku. This gate is about *this* session's judgement; it does not propagate to dispatched agents, whose models the engine pins explicitly (PLAN on Opus, everything else on Sonnet).

2. **Reasoning effort — HARD GATE (>= xhigh).**
   ```bash
   echo "CLAUDE_EFFORT=${CLAUDE_EFFORT:-unset}"
   ```
   Effort order is `low < medium < high < xhigh < max`. If it reads `low`, `medium`, `high`, or `unset`, **STOP**:
   > "/oversee needs reasoning effort >= xhigh. Run `/effort xhigh` (ideally `/effort max`), then re-invoke `/oversee`."

3. **Auto-accept ("auto mode") — CONFIRM, not detect.** There is no env var or settings field that reports the **live** permission mode: it is runtime state toggled with shift+Tab. It can only be confirmed, never detected. As a *hint*, read `.claude/settings.json` and `~/.claude/settings.json` and note any `permissions.defaultMode` (`acceptEdits`/`bypassPermissions` is a positive hint; the live shift+Tab mode overrides it and is not readable). Then confirm with the human via `AskUserQuestion`:
   > "Is auto-accept edits mode on for this session? `/oversee` runs a long autonomous pipeline and will stall on permission prompts without it. (shift+Tab cycles to it.)"
   > Options: **"Yes, auto-accept is on"** / **"I'll enable it now — wait"** / **"Proceed anyway (I'll approve prompts)"**

   Do not start the pipeline until this is answered. If "wait", tell them to toggle it, then continue once they confirm.

> **Why two gates and one confirmation:** the running model and `CLAUDE_EFFORT` are both knowable, so they are true gates. The live permission mode is not exposed anywhere readable, so an honest confirmation is the strongest correct check — claiming to have "detected" it would be fabrication (CLAUDE.md: never fabricate facts).

### 0b. Tooling, repo, and engine agreement

```bash
# One name per `command -v`: a multi-name `command -v a b` returns 0 under a POSIX
# shell (dash/sh) even when b is missing, which would silently pass this gate and
# fail much later inside a phase. Loop instead.
for tool in git gh jq mktemp; do
  command -v "$tool" > /dev/null 2>&1 \
    || { echo "ERROR: /oversee needs '$tool' on PATH."; exit 1; }
  # > /dev/null 2>&1: suppress the resolved path on success; the || clause carries the
  # actionable message on failure.
done

git rev-parse --git-dir > /dev/null 2>&1 \
  || { echo "ERROR: not inside a git repository."; exit 1; }
# > /dev/null 2>&1: suppress git's own "fatal: not a git repository" — ours is more actionable.

gh auth status > /dev/null 2>&1 \
  || { echo "ERROR: gh is not authenticated. Run 'gh auth login'."; exit 1; }
# > /dev/null 2>&1: suppress gh's auth banner on success and its error body on failure.

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) \
  || { echo "ERROR: could not resolve the repo slug via gh."; exit 1; }
printf '%s\n' "$REPO" > .codegraph/oversee/repo

# The engine has no filesystem access, so it hardcodes its own repo slug. If the two
# disagree (a fork, a rename, a partially-copied harness), every `gh` call the engine
# makes would target a different repo than the gate this skill installed — so fail
# closed here rather than dispatch a cross-repo run nobody asked for.
ENGINE=.claude/workflows/oversee-dispatch.js
[ -f "$ENGINE" ] || { echo "ERROR: $ENGINE is missing — /oversee cannot dispatch without its engine."; exit 1; }
ENGINE_REPO=$(sed -nE "s/^const REPO = '([^']+)'.*/\1/p" "$ENGINE" | head -1)
[ -n "$ENGINE_REPO" ] || { echo "ERROR: could not read the REPO constant from $ENGINE."; exit 1; }
if [ "$ENGINE_REPO" != "$REPO" ]; then
  echo "ERROR: repo mismatch — this checkout is '$REPO' but $ENGINE targets '$ENGINE_REPO'."
  echo "Fix: update the REPO constant in $ENGINE to '$REPO', then re-run /oversee."
  exit 1
fi

[ -f .claude/scripts/assert-worktree.sh ] \
  || { echo "ERROR: .claude/scripts/assert-worktree.sh is missing — dispatched agents rely on it for worktree confinement."; exit 1; }

echo "oversee: preflight OK on $REPO"
```

**Exit condition:** the session config gates passed, `.codegraph/oversee/repo` holds the slug, the slug matches the engine's constant, and the engine plus the worktree guard both exist.

---

## Phase: Route — resolve the argument and pick the phase

```bash
S=.codegraph/oversee
REPO=$(cat "$S/repo")
N=$(cat "$S/arg")
FORCED=$(cat "$S/forced-phase")

PR_JSON=$(gh pr view "$N" --repo "$REPO" --json number,title,state 2>/dev/null || true)
# 2>/dev/null || true: a number that is an ISSUE (not a PR) makes `gh pr view` fail by
# design — an empty PR_JSON is the expected "this is an issue" signal, not an error.

PHASE=""
if [ "$FORCED" = "verify" ]; then
  PHASE=verify
elif [ -n "$FORCED" ]; then
  PHASE="$FORCED"
elif [ -n "$PR_JSON" ]; then
  TITLE=$(printf '%s' "$PR_JSON" | jq -r .title)
  STATE=$(printf '%s' "$PR_JSON" | jq -r .state)
  case "$TITLE" in
    '[Plan]'*)
      if [ "$STATE" = "OPEN" ]; then PHASE=execute
      else
        echo "STOP: [Plan] PR #$N is $STATE. /oversee executes only an OPEN plan PR — re-plan with /oversee #<issue>."
        exit 1
      fi ;;
    *)
      echo "STOP: #$N is a PR but not a [Plan] PR. /oversee operates on an issue, or on a [Plan] PR it opened itself. To re-run independent VERIFY on an execute PR, use /oversee --verify #$N."
      exit 1 ;;
  esac
else
  gh issue view "$N" --repo "$REPO" --json number > /dev/null 2>&1 \
    || { echo "STOP: #$N resolves to neither an issue nor a PR in $REPO."; exit 1; }
  # > /dev/null 2>&1: we only need the exit status; the || clause reports the failure.
  PHASE=plan
fi

printf '%s\n' "$PHASE" > "$S/phase"
echo "oversee: routing #$N to the $PHASE phase"
```

**Exit condition:** `.codegraph/oversee/phase` is `plan`, `execute`, or `verify`. If `plan`, continue at Phase: Plan — Context and Readiness. If `execute`, jump to Phase: Execute — Confirm Approval. If `verify`, jump to Phase: Verify.

---

## Phase: Plan — Context and Readiness

### Sync local `main`

The roadmap, `CLAUDE.md`, and the ADRs you are about to read come from the working tree, and this is also the base the worktree-isolated planner branches from. A stale local `main` yields a wrong readiness verdict and a stale plan.

**Check the tree is clean before switching.** `git switch main` succeeds silently on non-conflicting uncommitted changes — tracked *or* untracked — and would carry them onto `main` with no warning, so the fail-closed guarantee has to be enforced upfront rather than left to `--ff-only`:

```bash
[ -z "$(git status --porcelain)" ] \
  || { echo "STOP: working tree is dirty — commit or stash before running /oversee (another session's files may be here; see CLAUDE.md 'Parallel Sessions')."; exit 1; }
git fetch origin || { echo "STOP: git fetch failed."; exit 1; }
git switch main || { echo "STOP: could not switch to main."; exit 1; }
git merge --ff-only origin/main \
  || { echo "STOP: local main diverged from origin/main and cannot fast-forward. Resolve it yourself — /oversee will not force, reset, or rebase past local work."; exit 1; }
```

### Read the authority, then check readiness

Read these before dispatching — **never dispatch blind**:

1. Root `CLAUDE.md` — repo law and the non-negotiables the engine embeds in every prompt.
2. `.codegraph/basics.md` — structure, entrypoints, coupling hotspots, health baseline, and the caveats that make raw numbers here misleading.
3. The issue itself (`gh issue view`), including its comments — a Done-when is often refined there.
4. `docs/roadmap/ROADMAP.md` and `docs/roadmap/BACKLOG.md` — the phase entry, if the issue has one.
5. `docs/architecture/decisions/` — any ADR the work would rely on or contradict.

> **Abort guard.** If `CLAUDE.md` or the issue cannot be read, **STOP and report**. Never derive a task's scope from its title alone.

Then capture the task metadata for the dispatch:

```bash
S=.codegraph/oversee
REPO=$(cat "$S/repo")
N=$(cat "$S/arg")

printf 'issue-%s\n' "$N" > "$S/task-id"
printf '%s\n' "$N" > "$S/issue"
gh issue view "$N" --repo "$REPO" --json title -q .title > "$S/title" \
  || { echo "STOP: could not read issue #$N's title."; exit 1; }

# Readiness signals — reported, not silently swallowed.
gh issue view "$N" --repo "$REPO" --json labels -q '[.labels[].name] | join(",")' > "$S/labels"
echo "labels: $(cat "$S/labels")"
```

**Readiness is warn-and-confirm, not a hard gate.** `/oversee` is human-driven, and a human may legitimately want to plan ahead of a dependency. If any of the following holds, surface the **exact** gate and ask via `AskUserQuestion` whether to proceed anyway:

- The issue carries the **`blocked`** label (say what it is blocked on — read the comment that applied it).
- The issue is **self-gated**: its author wrote it to stay open until some future trigger ("only if a real caller needs it") and that condition is still unmet. Warn strongly — planning the deferred work is often exactly what settles it, but say so explicitly rather than pretending the gate is met.
- A **dependency issue is still open**, or a dependency PR is unmerged (name the issue/PR).
- The work needs an **architectural decision with no ADR** in `docs/architecture/decisions/` (name what would need deciding).

If none holds, proceed silently. The invariants and the never-merge rule stay hard regardless of the human's answer.

**Exit condition:** `.codegraph/oversee/{task-id,issue,title}` are populated, and any readiness warning has been answered.

---

## Phase: Plan — Dispatch, Install the Approval Gate, Stop

### Dispatch the planner

Invoke the engine with `phase: "plan"` and the single task. The engine has no filesystem access, so seed it with what you read — the agents still read the docs themselves:

```text
Workflow(name: "oversee-dispatch", args: {
  phase: "plan",
  tasks: [ {
    "id": "<contents of .codegraph/oversee/task-id>",
    "issue": <contents of .codegraph/oversee/issue, as an integer>,
    "title": "<contents of .codegraph/oversee/title>",
    "doneWhen": "<the issue's acceptance criteria, verbatim where it states them>",
    "roadmapRef": "<the ROADMAP.md phase entry, or 'none — issue-only'>",
    "interfaceFreeze": <true only if downstream work needs this task's shape first>
  } ]
})
```

It runs `PLAN → critic (advisory, with up to 2 revise-in-place rounds) → plan-sweep` and returns one result: `{ planPR, planRef, criticPass, criticRejectClass, criticBlocking, criticSummary, reviseRounds, planReviewerSatisfied, planCommentsAddressed }`. Watch it live in `/workflows`.

If the result has **no `planPR`** — the planner aborted because a plan was already in flight — report that and stop. Do not open a competing plan.

Otherwise persist the result, then install the gate.

> **On the `<...>` placeholders below.** These are the only values in this skill that no shell command can detect: they come out of the `Workflow` tool result, not off the filesystem, so you substitute them yourself before running the block. That is exactly why each one is validated by a `grep -qE` allow-list immediately after it is written — a mis-substituted value fails closed instead of reaching the gate install.

```bash
S=.codegraph/oversee
# Substituted from the Workflow result above, then validated below before any use.
printf '%s\n' "<planPR from the result>"  > "$S/plan-pr"
printf '%s\n' "<planRef from the result>" > "$S/plan-ref"

grep -qE '^[0-9]+$' "$S/plan-pr" \
  || { echo "STOP: plan-pr is not a bare integer — refusing to install a gate against an unresolved PR."; exit 1; }
grep -qE '^[A-Za-z0-9._/-]+$' "$S/plan-ref" \
  || { echo "STOP: plan-ref is not a plain path — refusing to embed it in the gate metadata."; exit 1; }
```

### Install the human approval gate

The append is idempotent across legitimate re-runs, but a sentinel that is *already present* is **not** trusted blindly. A copied or pre-seeded gate must never become the authorization boundary, so append only when **no** sentinel exists; treat an existing one as "already installed" **only** when it is a single gate matching **this run's** `id`/`issue`/`planRef` **and is unticked**. Anything else — more than one sentinel, a metadata mismatch, or an already-ticked box at install time — is a stale or foreign gate: STOP and ask the human to remove it.

```bash
S=.codegraph/oversee
REPO=$(cat "$S/repo")
PR=$(cat "$S/plan-pr")
TASK_ID=$(cat "$S/task-id")
ISSUE=$(cat "$S/issue")
PLAN_REF=$(cat "$S/plan-ref")
SENTINEL="oversee:approval-gate id=$TASK_ID issue=$ISSUE planRef=$PLAN_REF"

body=$(gh pr view "$PR" --repo "$REPO" --json body -q .body) \
  || { echo "STOP: could not read PR #$PR's body."; exit 1; }

# Strip GitHub closing keywords: a plan PR must NEVER close the issue on merge — only
# the execute PR carries "Closes #<n>". Rewrite to "Part of" so the link survives
# without the auto-close side effect. (.github/workflows/closing-keyword-check.yml
# flags the inverse case, but it is informational only and does not gate.)
body=$(printf '%s\n' "$body" | sed -E 's/(^|[[:space:]])(close[sd]?|fix(e[sd]?)?|resolve[sd]?)[[:space:]]+#([0-9]+)/\1Part of #\4/gI')

ngates=$(printf '%s\n' "$body" | grep -c 'oversee:approval-gate' || true)
# || true: grep -c exits 1 on zero matches, which is the normal first-install case.

if [ "$ngates" -eq 0 ]; then
  gh pr edit "$PR" --repo "$REPO" --body "$body
<!-- $SENTINEL -->

---
## ✋ Human approval gate (/oversee)
- **Task:** $TASK_ID (issue #$ISSUE)
- **Plan doc:** \`$PLAN_REF\`
- **Critic verdict:** <PASSED — recommended for approval | REJECTED (<rejectClass>) — <criticBlocking, joined>>
- **Revise rounds:** <reviseRounds>
- **Plan-sweep:** reviewer <satisfied|pending|unsatisfied>, <planCommentsAddressed> comment(s) addressed

Review the plan above. To approve it for execution, **tick this box, then run \`/oversee #$PR\`**:

- [ ] **APPROVED FOR EXECUTION** — I have reviewed this plan and approve building it" \
    || { echo "STOP: could not install the approval gate on PR #$PR."; exit 1; }
  echo "approval gate installed on PR #$PR"
elif [ "$ngates" -gt 1 ]; then
  echo "STOP: PR #$PR already carries $ngates approval-gate sentinels — a stale or copied gate is present."
  echo "Remove the stale block(s) so none remain, then re-run /oversee."
  exit 1
else
  # Exactly one preexisting sentinel: legitimate only if it is THIS run's gate, unticked.
  existing=$(printf '%s\n' "$body" | grep 'oversee:approval-gate')
  ticked=$(printf '%s\n' "$body" | awk '/oversee:approval-gate/{f=1} f' \
    | grep -cE '^- \[[xX]\] \*\*APPROVED FOR EXECUTION\*\*' || true)
  # || true: grep -c exits 1 on zero matches — an unticked gate is the expected case.
  case "$existing" in
    *"$SENTINEL"*)
      if [ "$ticked" -eq 0 ]; then
        echo "approval gate already installed for this run — leaving as-is"
      else
        echo "STOP: PR #$PR's gate is already ticked at install time — a stale or copied approved gate. Remove it, then re-run /oversee."
        exit 1
      fi ;;
    *)
      echo "STOP: PR #$PR carries a foreign approval-gate (its id/issue/planRef do not match this run). Remove it, then re-run /oversee."
      exit 1 ;;
  esac
fi
```

Fill the three `<...>` fields in the gate body from the Workflow result before the edit — a gate that hides a REJECTED verdict defeats its own purpose.

### Stamp the provenance status

Body text can never prove its own origin: a clean, ticked gate can be pasted into any mutable PR body. So the authorization anchor is a **commit status** on the plan PR's head — a channel written through the GitHub API that a body author cannot forge. The EXECUTE phase verifies *this*, not the body.

```bash
S=.codegraph/oversee
REPO=$(cat "$S/repo")
PR=$(cat "$S/plan-pr")
TASK_ID=$(cat "$S/task-id")
ISSUE=$(cat "$S/issue")

headSha=$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid) \
  || { echo "STOP: could not read PR #$PR's head SHA."; exit 1; }
printf '%s\n' "$headSha" > "$S/plan-head-sha"

gh api -X POST "repos/$REPO/statuses/$headSha" \
  -f state=success -f context=oversee/plan-gate \
  -f "description=gate installed by /oversee for $TASK_ID (issue #$ISSUE)" > /dev/null \
  && echo "provenance: oversee/plan-gate=success on $headSha" \
  || { echo "STOP: could not set the oversee/plan-gate commit status (the token needs the repo:status scope). EXECUTE refuses without it — fix auth, then re-run /oversee #$ISSUE."; exit 1; }
# > /dev/null: suppress the API's JSON echo; the && / || clauses report the outcome.
```

Re-stamping on a legitimate re-run is intended: the status must always track the *current* head.

Then **STOP** and print the PLAN board (Phase: Report). If the critic REJECTED, say so prominently and recommend fixing or re-planning rather than approving.

> **This STOP is an explicit `/clear` boundary.** The PLAN phase ends the turn at the checkbox; the EXECUTE phase is a **separate, fresh invocation**, and `/clear` between them is the intended handoff, not a workaround. Nothing needs to survive in context: EXECUTE reconstructs the task metadata from the `oversee:approval-gate` body sentinel and the authorization from the non-forgeable commit status. That same statelessness is what lets Phase: Execute — Reconcile the Reviewer run re-entrantly across `ScheduleWakeup` ticks.

**Exit condition:** the `[Plan]` PR carries exactly one unticked gate matching this run, `oversee/plan-gate=success` is set on its current head, and the PLAN board has been printed.

---

## Phase: Verify — Re-run independent VERIFY (`--verify`)

Reached only from Phase: Route when `--verify` is set. `N` is an **open execute PR**, not a `[Plan]` PR.

1. **Refuse `[Plan]` PRs and closed PRs.** Title starting with `[Plan]` → STOP (that is `--execute` / a plan gate, not VERIFY). Closed → STOP. Drafts are OPEN.
2. **Recover task id + Done-when — fail closed.** Snapshot `headRefName`, `body`, `headRefOid`. Prefer `execute/<task-id>` or the collision suffix. Else closing keywords / `Part of #<issue>` → tracking issue. Done-when from the issue body (this repo has no master-roadmap §3). STOP if either is empty.
3. **Confirm auto-accept** (Phase 0a's confirmation) — this mode dispatches.
4. **Spawn one independent VERIFY agent.** Read `verifyPrompt(t, exec)` and `VERIFY_SCHEMA` from `.claude/workflows/oversee-dispatch.js`. Fill `t.id` / `t.issue` and `exec.executePR = N`. Model: `sonnet`. Isolation: `worktree`. Label: `re-verify:<task-id>`.

   **This skill never POSTs `pipeline/verify` and never `gh pr review`.** Only the spawned agent may stamp. Never merge. Never dispatch `oversee-dispatch`.
5. **Gate the result** as `applyVerifyGates` does: `verifiedSha` must be 40-hex; `pass` with `reviewPosted` or `statusPosted` false → fail. Re-read live `headRefOid`; mismatch → STOP and tell the operator to re-run `/oversee --verify #N`.
6. **STOP** and print the VERIFY board. Never execute, never restamp, never merge.

Always spawn, even if `pipeline/verify=success` already sits on the current head.

---

## Phase: Execute — Confirm Approval

### Re-sync local `main`

This is a fresh invocation and other PRs may have merged since the plan was approved. Refresh the gating brain's view — and the base the execute agent's worktree starts from — before anything else, with the **same dirty-tree guard** as Phase: Plan — Context and Readiness, for the same reason:

```bash
[ -z "$(git status --porcelain)" ] \
  || { echo "STOP: working tree is dirty — commit or stash before running /oversee."; exit 1; }
git fetch origin || { echo "STOP: git fetch failed."; exit 1; }
git switch main || { echo "STOP: could not switch to main."; exit 1; }
git merge --ff-only origin/main \
  || { echo "STOP: local main diverged from origin/main and cannot fast-forward. Resolve it yourself."; exit 1; }
```

### Recover the task, verify provenance, require the tick

Three checks, in this order, each failing closed.

```bash
S=.codegraph/oversee
REPO=$(cat "$S/repo")
PR=$(cat "$S/arg")

body=$(gh pr view "$PR" --repo "$REPO" --json body -q .body) \
  || { echo "STOP: could not read PR #$PR's body."; exit 1; }

# --- 1. Exactly one gate. Refuse to guess past an ambiguous authorization boundary. ---
ngates=$(printf '%s\n' "$body" | grep -c 'oversee:approval-gate' || true)
# || true: grep -c exits 1 on zero matches, handled explicitly below.
[ "$ngates" -eq 0 ] && { echo "STOP: PR #$PR has no /oversee approval gate — start with /oversee #<issue>."; exit 1; }
[ "$ngates" -gt 1 ] && { echo "STOP: PR #$PR has $ngates approval gates — a stale or copied gate block is present. Remove the copy so exactly one remains, then re-run /oversee #$PR."; exit 1; }

# Parse each field with a strict allow-list and assign by plain capture. NEVER eval
# body-derived text: the body is mutable, and a copied or pre-seeded gate could embed
# shell metacharacters. These three charsets make id/issue/planRef non-injectable.
gateId=$(printf      '%s\n' "$body" | sed -nE 's/.*oversee:approval-gate[[:space:]]+id=([A-Za-z0-9._-]+)[[:space:]].*/\1/p'   | head -1)
gateIssue=$(printf   '%s\n' "$body" | sed -nE 's/.*oversee:approval-gate[[:space:]]+.*issue=([0-9]+)[[:space:]].*/\1/p'       | head -1)
gatePlanRef=$(printf '%s\n' "$body" | sed -nE 's#.*oversee:approval-gate[[:space:]]+.*planRef=([A-Za-z0-9._/-]+).*#\1#p'      | head -1)
{ [ -z "$gateId" ] || [ -z "$gateIssue" ] || [ -z "$gatePlanRef" ]; } \
  && { echo "STOP: PR #$PR's gate metadata is malformed (id/issue/planRef must be plain tokens) — a stale or tampered gate. Remove it, then re-run /oversee."; exit 1; }
printf '%s\n' "$gateId"      > "$S/task-id"
printf '%s\n' "$gateIssue"   > "$S/issue"
printf '%s\n' "$gatePlanRef" > "$S/plan-ref"
printf '%s\n' "$PR"          > "$S/plan-pr"

# --- 2. Provenance: the check body text cannot fake. ---
# Parsing proves the gate is well-formed, not that /oversee installed it. Require the
# commit status stamped on THIS plan PR's CURRENT head. Bound to the head SHA, this
# also fails closed if anyone pushed to the plan PR after approval — the approved plan
# would no longer be what builds.
headSha=$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid) \
  || { echo "STOP: could not read PR #$PR's head SHA."; exit 1; }
gateState=$(gh api "repos/$REPO/commits/$headSha/status" \
  --jq '.statuses[] | select(.context=="oversee/plan-gate") | .state' 2>/dev/null | head -1)
# 2>/dev/null: a commit with no statuses at all makes the jq filter yield nothing and
# gh exit non-zero — an empty gateState is exactly the "no gate" case handled next.
[ "$gateState" = "success" ] || {
  echo "STOP: PR #$PR has no oversee/plan-gate=success status on its current head ($headSha)."
  echo "Either the gate was not installed by /oversee for this plan head (a copied or pre-seeded body gate),"
  echo "or commits were pushed after it was set. Re-run /oversee #$gateIssue to re-install the gate on the"
  echo "current head, then re-approve."
  exit 1
}
printf '%s\n' "$headSha" > "$S/plan-head-sha"

# --- 3. The gate's OWN checkbox must be ticked. ---
# Check the FIRST "APPROVED FOR EXECUTION" line after the sentinel — that is the gate's
# own line. A later copied checkbox in the body tail must not count, and the column-0
# bold shape stops a stray, indented, or pasted line from counting either.
firstbox=$(printf '%s\n' "$body" | awk '/oversee:approval-gate/{f=1} f' \
  | grep -E '^- \[[ xX]\] \*\*APPROVED FOR EXECUTION\*\*' | head -1)
case "$firstbox" in
  '- [x] **APPROVED FOR EXECUTION**'*|'- [X] **APPROVED FOR EXECUTION**'*)
    echo "APPROVED — gate $gateId (issue #$gateIssue) ticked, provenance verified on $headSha" ;;
  *)
    echo "STOP: plan PR #$PR is not approved yet. Review it, tick **APPROVED FOR EXECUTION**, then re-run /oversee #$PR."
    exit 1 ;;
esac
```

With provenance proven, three further guards keep the *approval* signal on the human's tick rather than on copyable body text: exactly one gate stops a duplicate placed above the real one from hijacking recovery; checking only the first checkbox after the sentinel stops a `- [x]` pasted later in the tail from approving an unticked gate; and the column-0 bold shape stops a stray line from counting.

### Re-run the pre-flight

A second invocation is a fresh session — the model, effort, and auto-mode could all differ. Re-run Phase 0 (both 0a and 0b) now.

### Recover an already-open execute PR

**A resumed run must never re-dispatch, and must never re-litigate the plan.** A second `/oversee #<plan-PR>` — a fresh context, a `/clear` between the build and reconciliation, a wakeup whose state dir is gone — arrives here with the execute PR already open on GitHub. Re-dispatching cannot recover it: the execute agent claims the tracking issue first, finds it already claimed, and aborts with `executePR=null` **by design**, so the engine returns no PR number, `.codegraph/oversee/execute-pr` stays empty, and the open PR is stranded with nobody reconciling its reviewer.

This check sits **before** Phase: Execute — Validate Plan Freshness on purpose. Once an execute PR exists the build already happened, against a head whose human approval this phase just re-verified — so re-checking the plan's freshness cannot change what was built, and its **STALE** branch is actively destructive: it would close the `[Plan]` PR and re-plan, orphaning an open and possibly already-verified execute PR. Recover first, and the freshness gate runs only on a plan that has yet to be built.

Because skipping that gate removes the last downstream check, a candidate is adopted only on **provenance**, never on issue linkage: it must target `main` and be **strictly ahead** of the approved `planHeadSha`. The execute agent branches from that exact commit and commits the code on top, so a real execute PR always adds at least one commit to it, while an unrelated PR that merely says `Closes #<issue>` is not descended from it at all. *Strictly* matters: a PR pointing **at** the plan head is the plan carrying no build, and adopting it would hand reconciliation an empty delivery — the same defect as adopting an unrelated PR. Candidates that fail either test are named and skipped, not silently ignored.

```bash
S=.codegraph/oversee
REPO=$(cat "$S/repo")
ISSUE=$(cat "$S/issue")
PLAN_PR=$(cat "$S/plan-pr")
PLAN_SHA=$(cat "$S/plan-head-sha")

# All three reach a shell substitution, a grep pattern, or an API path below. They were
# parsed under a strict allow-list in Phase: Execute — Confirm Approval; re-assert it
# here so this block is safe to run on its own in a resumed context.
grep -qE '^[0-9]+$' "$S/issue" && grep -qE '^[0-9]+$' "$S/plan-pr" \
  || { echo "STOP: .codegraph/oversee/{issue,plan-pr} must each hold a plain integer — re-run Phase: Execute — Confirm Approval."; exit 1; }
grep -qE '^[0-9a-f]{40}$' "$S/plan-head-sha" \
  || { echo "STOP: .codegraph/oversee/plan-head-sha must hold a 40-hex commit — re-run Phase: Execute — Confirm Approval."; exit 1; }

# Candidates: every OPEN, non-[Plan] PR that cross-references the tracking issue. The
# issue timeline is exact and fully paginated — unlike `gh pr list` it needs no guessed
# --limit that could silently truncate past the execute PR, and unlike a code search it
# has no indexing lag in the minutes right after that PR opens.
gh api "repos/$REPO/issues/$ISSUE/timeline" --paginate \
  --jq '.[] | select(.event == "cross-referenced") | .source.issue
        | select(.pull_request != null and .state == "open")
        | select((.title | startswith("[Plan]")) | not)
        | .number' > "$S/xref.raw" \
  || { echo "STOP: could not read issue #$ISSUE's timeline to check for an existing execute PR."; exit 1; }
# Redirected to a file rather than piped into sort: a POSIX pipeline reports only its
# LAST command's status, so `gh ... | sort` would swallow a gh failure as success.
sort -u "$S/xref.raw" > "$S/xref"

# Two tests, cheap one first. A bare cross-reference is NOT an execute PR — merely
# linking the issue from a comment creates one too — so require a CLOSING keyword in
# the body: `executePrompt` mandates "Closes #<issue>", while the plan PR's own closing
# keywords were rewritten to "Part of" at gate install. That is only INTENT, though, and
# any PR can claim it. PROVENANCE is the decisive test: the execute agent branches from
# the approved `planHeadSha`, so that commit is an ANCESTOR of a real execute PR's head.
# Adopting a PR on issue linkage alone would hand reconciliation something never built
# from the approved plan — and, because this phase also skips the freshness gate, with
# nothing downstream left to catch it.
: > "$S/exec-prs"
while read -r C; do
  [ -n "$C" ] || continue
  [ "$C" = "$PLAN_PR" ] && continue
  BODY=$(gh pr view "$C" --repo "$REPO" --json body --jq '.body // ""') \
    || { echo "STOP: could not read PR #$C's body while recovering the execute PR."; exit 1; }
  printf '%s' "$BODY" \
    | grep -Eiq "(clos(e|es|ed)|fix(e[sd])?|resolv(e|es|ed))[[:space:]]+#$ISSUE([^0-9]|$)" \
    || continue

  # Two provenance facts, both read from the PR in one call.
  META=$(gh pr view "$C" --repo "$REPO" --json headRefOid,baseRefName \
           --jq '"\(.headRefOid) \(.baseRefName)"') \
    || { echo "STOP: could not read PR #$C's head while recovering the execute PR."; exit 1; }
  C_HEAD=${META%% *}
  C_BASE=${META##* }

  # (a) It targets main. `executePrompt` opens the execute PR against main (the same
  # branch this skill syncs and merges elsewhere), so a PR based on the plan branch is
  # somebody stacking work on the plan, not the build.
  if [ "$C_BASE" != "main" ]; then
    echo "recover: skipping PR #$C — it closes issue #$ISSUE but targets '$C_BASE', not main, so it is not an /oversee execute PR."
    continue
  fi

  # (b) It is STRICTLY AHEAD of the approved plan head. `compare/<base>...<head>` reports
  # "ahead" when base is an ancestor AND head adds commits, "identical" when they are the
  # same commit, and "behind"/"diverged" when base is not an ancestor at all. Only "ahead"
  # is an execute PR: the agent branches from `planHeadSha` and commits the code on top,
  # so a real one always adds at least one commit. "identical" is a PR pointing AT the
  # plan head — the plan carrying no build — and adopting it would hand
  # reconciliation an empty delivery, which is the same defect as adopting an unrelated PR.
  # An unrelated history 404s, a legitimate "not built from the approved plan" answer
  # rather than an error to surface; an empty REL falls through to the rejection below.
  # 2>/dev/null is expected and tolerated here.
  REL=$(gh api "repos/$REPO/compare/$PLAN_SHA...$C_HEAD" --jq '.status' 2>/dev/null)
  case "${REL:-none}" in
    ahead) printf '%s\n' "$C" >> "$S/exec-prs" ;;
    *) echo "recover: skipping PR #$C — it closes issue #$ISSUE but is not strictly ahead of the approved plan head $PLAN_SHA (compare=${REL:-unavailable}), so /oversee did not build it." ;;
  esac
done < "$S/xref"
rm -f "$S/xref" "$S/xref.raw"

COUNT=$(grep -c '^[0-9]' "$S/exec-prs" || true)
# || true: grep -c exits 1 on zero matches, which is the normal first-run case.
if [ "${COUNT:-0}" -gt 1 ]; then
  echo "STOP: issue #$ISSUE has $COUNT open execute PRs ($(tr '\n' ' ' < "$S/exec-prs")). /oversee will not guess which one to reconcile — close the stale one, then re-run."
  rm -f "$S/exec-prs"
  exit 1
elif [ "${COUNT:-0}" -eq 1 ]; then
  head -1 "$S/exec-prs" > "$S/execute-pr"
  rm -f "$S/exec-prs"
  echo "recover: execute PR #$(cat "$S/execute-pr") already exists for issue #$ISSUE — SKIPPING dispatch."
  echo "Continue at Phase: Execute — Reconcile the Reviewer. Do NOT run the Workflow below."
else
  rm -f "$S/exec-prs" "$S/execute-pr"
  echo "recover: no open execute PR for issue #$ISSUE — dispatching the build."
fi
```

**Routing.** If this found a PR, **skip both Phase: Execute — Validate Plan Freshness and Phase: Execute — Dispatch the Build** and continue at Phase: Execute — Reconcile the Reviewer. If it found none, continue to the freshness gate as normal.

**Exit condition:** the gate is ticked, its provenance is verified on the current head, `.codegraph/oversee/{task-id,issue,plan-ref,plan-pr,plan-head-sha}` are populated, the pre-flight passed again, and either `.codegraph/oversee/execute-pr` holds a recovered PR number (go straight to Phase: Execute — Reconcile the Reviewer) or it is absent (continue to the freshness gate).

---

## Phase: Execute — Validate Plan Freshness

Approval proves a human liked the plan *at approval time*. It does not prove the plan still matches reality **now**. The world moves after a plan is authored: the issue gets edited, an ADR the plan assumed gets decided differently, the roadmap re-scopes the task, a cited doc changes, an overlapping PR merges. **An approved-but-stale plan must be rejected and re-planned, never built.**

Do **not** run this analysis in this context — it reads issue histories, doc diffs, and the roadmap, and would blow up the session. Spawn a **read-only** subagent pinned to **Sonnet** and act only on its compact verdict:

```text
Agent(subagent_type: "general-purpose", model: "sonnet", run_in_background: false,
      prompt: <the brief below, with the task-id, issue, plan-ref and plan-pr values
               read from .codegraph/oversee/ substituted in>)
```

The brief:

```text
You are a read-only plan-staleness validator for optave/ops-codegraph-tool.
NEVER write files, push, comment, or edit issues/PRs. Use the local repo (main is
already synced with origin) plus `gh` for live GitHub state.

TASK: <task-id> — tracking issue #<issue>. PLAN: <plan-ref> on the head of [Plan] PR #<plan-pr>.

0. RESOLVE THE LIVE HEAD FIRST — do NOT trust any SHA you were handed. Run
   `gh pr view <plan-pr> --repo optave/ops-codegraph-tool --json headRefOid -q .headRefOid`
   and validate against THAT commit. On an actively-worked PR a SHA the caller captured
   even a minute ago is routinely superseded, and judging a superseded copy manufactures
   findings that were already fixed on the live head — a FALSE STALE, whose cost is a
   sound plan closed and re-planned from scratch. If the live head differs from a SHA you
   were given, use the live one and say so as your FIRST REASONS bullet.
1. ANCHOR — when the plan was last authored: the timestamp of the last commit that
   touched the plan document
   (`git log -1 --format=%cI <plan-PR-head-sha> -- <plan-ref>`; `git fetch origin
   <plan-PR-head-sha>` first if the SHA is not local; for a plan doc already on main,
   use origin/main as the ref).
2. EXTRACT the plan's document dependency tree — the inputs its validity rests on:
   the tracking issue text it was planned against; every ADR in
   docs/architecture/decisions/ it cites or silently assumes; its ROADMAP.md phase entry
   or BACKLOG.md entry; the CLAUDE.md rules it relies on; every doc/section it cites; and
   the specific source files its Folder Structure section says it will modify.
3. DIFF each input against reality SINCE the anchor:
   - Issue #<issue>: body edits and post-anchor comments that change scope, decisions,
     or acceptance criteria.
   - `git log --since='<anchor>' origin/main -- docs/ CLAUDE.md .codegraph/basics.md`,
     then read the diffs of ONLY the files the plan depends on.
   - `git log --since='<anchor>' origin/main -- <each file in the plan's Folder
     Structure>`: a plan whose target files were substantially rewritten since it was
     authored may no longer describe the code it means to change.
   - docs/architecture/decisions/: any cited or assumed ADR whose content or status
     changed since the anchor.
   - New issues or merged PRs since the anchor that overlap, supersede, or re-scope this
     task or its dependencies.
4. JUDGE: cosmetic edits (typos, formatting, unrelated sections) are NOT staleness.
   Staleness = a post-anchor change that alters what the plan should build, its
   dependencies or interfaces, its assumptions, or its Done-when.
   Two ways this judgement goes wrong in opposite directions, both worth guarding:
   (a) VACUOUS FRESH — the anchor is the last commit that TOUCHED the plan doc, so a late
   fix commit drags it forward and the DIFF window collapses to near-nothing. If the
   anchor is materially newer than when the plan was actually authored, say so and diff
   from the authoring commit too, or FRESH means only "nothing changed in the last few
   minutes".
   (b) ALREADY-FIXED FINDING — before reporting anything as STALE, confirm the plan text
   at the LIVE head does not already address it; a plan is frequently patched in place
   between a caller's snapshot and your run.
   Mark a finding NARROW when a line-or-two patch to the plan reconciles it, and name the
   exact section to patch — NARROW findings are patched in place, never re-planned.

RETURN EXACTLY THIS SHAPE (<= 25 lines, no preamble):
VERDICT: FRESH | STALE | UNVERIFIABLE
HEAD: <the live head SHA you actually validated against>
ANCHOR: <ISO timestamp>
REASONS: (STALE/UNVERIFIABLE only) one bullet per finding — what changed, where
(file/section/issue-comment/PR), whether it is NARROW, and why it invalidates the plan.
```

### Act on the verdict — fail closed, never execute past it

**First, sanity-check the verdict against the head it names.** The validator reports `HEAD:`. If that is not the plan PR's current head, its findings describe a superseded revision — re-check each one against the live head before acting, because a finding already fixed there is not staleness, and a false STALE costs a sound plan. Likewise discount any finding the plan text at the live head already addresses.

- **FRESH** → proceed to Phase: Execute — Dispatch the Build.

- **STALE, every finding marked NARROW** → **patch in place, do NOT re-plan.** Closing a large, sound plan over a line-or-two reconciliation (a shifted line citation, an ADR reference that needs re-pointing) is destructive and wasteful. Patch the named sections on the plan branch, push, then **re-stamp `oversee/plan-gate` on the new head and leave the box UNTICKED** — never carry a pre-existing tick across the patch, because the human approved a different revision. Report what was patched, then STOP for a fresh tick. If any finding is broader than that, treat the whole verdict as STALE below.

- **STALE** (any non-NARROW finding) → **do NOT execute.** Reject and recreate — but **preserve the plan's work before destroying it**, because a re-plan that starts cold re-derives every citation, dependency fact, and rejected alternative the closed plan already paid for. In this order:

  1. **Write the carry-forward artifact FIRST, while the plan is still readable.** Spawn one Sonnet subagent using the engine's `carryForwardPrompt()` / `CARRY_FORWARD_SCHEMA` contract (both in [`oversee-dispatch.js`](../../workflows/oversee-dispatch.js)), which distils the plan into a sticky `<!-- plan-carry-forward task=<id> -->` comment on the tracking issue: still-valid conclusions, rejected alternatives, the invalidating delta, and a pointer to the superseded doc at its SHA. The next planner reads it and starts warm. Non-fatal: if it fails, say the re-plan will start cold and continue.

     **Read the round counter — and every other bullet — only from an authenticated comment.** The sentinel is public and predictable, so an outside commenter could otherwise reset the counter or plant a retained "conclusion" the next planner treats as already verified. Authenticate by the author's **real repo permission** (`gh api repos/optave/ops-codegraph-tool/collaborators/<author>/permission` → trust only `admin`/`write`), **not** by `author_association`: `MEMBER` proves only org membership and `COLLABORATOR` only an invitation, so a read-only member or collaborator passes either. `read`/`none`/404/uncheckable → not an artifact.

     **If the artifact's round counter reaches 3, do NOT re-plan again — STOP and escalate to the human to re-scope.** An issue that has burned three plan rounds is not going to be fixed by a fourth. If the round is unknown because the carry-forward failed, that is **not** "under the cap": establish it, or stop.
  2. Post the validator's `REASONS` as a comment on the `[Plan]` PR (`STALE PLAN — /oversee refused execution: …`).
  3. **Close the `[Plan]` PR** (`gh pr close`) so the stale plan can never be executed later and no longer counts as in-flight. Its approval is void.
  4. **Re-run the PLAN phase** for the tracking issue as if invoked as `/oversee #<issue>`, passing the validator's `REASONS` as the task's `stalenessReasons` so the fresh planner accounts for what changed. Install the fresh approval gate and **STOP** — the human must re-approve.

  Report prominently: which plan was rejected, why, and the new `[Plan]` PR number.

- **UNVERIFIABLE** → **STOP and report** exactly what the validator could not verify. Take no destructive action: do not close anything, do not execute, do not re-plan. An unreadable dependency tree is a blocker to surface, not to route around.

**Exit condition:** the verdict is FRESH (proceed), or the run has stopped with a patched plan, a re-planned issue, or an unverifiable report.

---

## Phase: Execute — Dispatch the Build

Reached only when Phase: Execute — Confirm Approval found **no** open execute PR, so this phase never re-dispatches a build that already happened.

Dispatch on top of the approved (unmerged) plan PR, **pinned to the verified head SHA** from Phase: Execute — Confirm Approval. The execute agent builds *that exact commit* rather than whatever the plan branch resolves to at checkout time, and re-checks `oversee/plan-gate=success` on it before building — so a push to the plan PR between approval and checkout fails closed instead of silently building an unapproved head.

```text
Workflow(name: "oversee-dispatch", args: {
  phase: "execute",
  tasks: [ {
    "id": "<contents of .codegraph/oversee/task-id>",
    "issue": <contents of .codegraph/oversee/issue, as an integer>,
    "title": "<the issue title>",
    "planRef": "<contents of .codegraph/oversee/plan-ref>",
    "planPR": <contents of .codegraph/oversee/plan-pr, as an integer>,
    "planHeadSha": "<contents of .codegraph/oversee/plan-head-sha>"
  } ]
})
```

It runs `EXECUTE (branch off the verified SHA) → VERIFY → execute-sweep` and returns `{ executePR, branch, verify, verifyBlocking, executeReviewerSatisfied, executeCommentsAddressed }`. Persist the PR number for the reconcile phase:

```bash
S=.codegraph/oversee
printf '%s\n' "<executePR from the result>" > "$S/execute-pr"
grep -qE '^[0-9]+$' "$S/execute-pr" \
  || { echo "NOTE: no execute PR was opened — read the Workflow result's summary and report it to the human. Nothing to reconcile."; }
```

**Exit condition:** either `.codegraph/oversee/execute-pr` holds a PR number, or the failure to open one has been reported to the human.

---

## Phase: Execute — Reconcile the Reviewer

The `executeReviewerSatisfied` value the engine returns is a **read-time hint, not proof**: the sweep stage runs a single bounded round and returns without waiting out the reviewer's quiet window, so the driver owns convergence.

Run **ONE bounded reconcile batch per invocation**:

1. Read the execute PR's reviewer state from GitHub and classify it:
   - **satisfied** — a positive reaction on a **current-head `@greptileai` trigger** comment, **plus ~6–7 minutes of quiet**: no new reviewer comment, **no edit to the reviewer's existing summary comment**, and no new push.
   - **pending** — the reaction is there but the quiet window has not elapsed.
   - **unsatisfied** — no trigger or no reaction, or a new comment / summary edit / push landed after the trigger.

   > **Greptile edits its summary comment in place** rather than posting a new one, so a re-review verdict arrives as an edit. "Poll for new comments" silently misses it — compare the summary comment's body or its `updated_at`, not just the comment list.

2. If **unsatisfied**, spawn **one single-round** sweep agent: read the current findings once → address every open finding → reply → re-trigger `@greptileai` → return. This is deliberately **not** a `/sweep` invocation: `/sweep` re-introduces the multi-round loop this phase exists to avoid.

3. If the state is **pending or unsatisfied**, call `ScheduleWakeup` with ~360–420s (matched to the quiet window) and a one-line reason, then **END THE TURN**. The wait burns no live context. On the wake, re-run **this batch only** — the execute PR already exists, so do **not** re-dispatch the engine.

4. If **satisfied**, go to Phase: Report.

**Escalate on genuine non-convergence.** Track the **open** finding ids across ticks, derived from GitHub rather than from an in-memory counter (a review thread's root comment id is stable across a push and re-anchor). *Open* is the load-bearing word: the set has to shrink as findings get addressed, or it compares equal on every tick and escalates a PR that was converging normally.

Read it from the GraphQL `reviewThreads` connection, **not** the REST comment list. REST `/pulls/<n>/comments` cannot express any of the three properties that decide whether a comment is still a finding: it has **no resolved flag**, so an addressed-and-resolved thread stays in the list forever and pins the id set; it **flattens our own replies in** among the findings, so answering a comment *grows* the set; and it carries **no thread identity**, so a live finding is indistinguishable from a closed one or from an unrelated remark.

```bash
S=.codegraph/oversee
REPO=$(cat "$S/repo")
PR=$(cat "$S/execute-pr")
OWNER=${REPO%%/*}
NAME=${REPO##*/}

# The acting account authors the replies, so its own threads are never findings.
ME=$(gh api user --jq .login) \
  || { echo "STOP: could not resolve the acting account — cannot separate reviewer findings from our own replies."; exit 1; }

# isResolved:false  - the thread has not been marked addressed.
# isOutdated:false  - the diff hunk it flagged still exists (the REST equivalent of the
#                     comment's `line` going null once the code it anchored to is gone).
# comments(first:1) - the thread ROOT: the finding itself, never a reply to it.
gh api graphql --paginate \
  -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -f query='
  query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            isOutdated
            comments(first: 1) { nodes { databaseId author { login } } }
          }
        }
      }
    }
  }' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved == false and .isOutdated == false)
        | .comments.nodes[0] // empty' > "$S/open-threads.raw" \
  || { echo "STOP: could not read PR #$PR's review threads."; exit 1; }

NOW_RAW=$(jq -rs --arg me "$ME" \
  '[.[] | select(.author.login != $me) | .databaseId] | sort | join(",")' \
  "$S/open-threads.raw") \
  || { echo "STOP: could not reduce PR #$PR's review threads to an open-finding key."; exit 1; }
# -s (slurp): --paginate emits one object per thread across all pages, not one array.
rm -f "$S/open-threads.raw"

# tr -d '\r': a native Windows `jq` build writes CRLF, and a stray CR would ride into
# both the comparison key and the state file. `gh`'s own --jq writes LF, standalone jq
# does not, and this is the one place the skill shells out to jq directly.
NOW=$(printf '%s' "$NOW_RAW" | tr -d '\r')

PREV=$(cat "$S/open-ids" 2>/dev/null || echo "")
# 2>/dev/null || echo "": no previous tick file is expected on the first reconcile — an
# empty PREV correctly means "nothing to compare", never a false stall match.
printf '%s\n' "$NOW" > "$S/open-ids"

if [ -n "$PREV" ] && [ "$PREV" = "$NOW" ] && [ -n "$NOW" ]; then
  echo "ESCALATE: the same reviewer findings ($NOW) are still open on PR #$PR after 2 consecutive reconcile ticks."
  echo "Reporting to the human as needs-human-review — /oversee will not loop on a non-converging reviewer."
else
  echo "reconcile: open finding ids = ${NOW:-none}"
fi
```

On escalation, tell the human plainly which findings are still open and stop — a one-shot handoff, not a loop.

Because this batch is stateless, it is correct in a fresh or `/clear`ed context: re-run `/oversee #<plan-PR>` and it re-derives the execute PR and its reviewer state from GitHub, re-verifying the `oversee/plan-gate` provenance on the way, rather than re-dispatching.

**Exit condition:** the reviewer is satisfied (go to Phase: Report), a wakeup is scheduled and the turn has ended, or the non-convergence escalation has been reported.

---

## Phase: Report

**Never merge.** Print the board and stop. The human's only remaining action is the merge to `main`.

**VERIFY mode (`--verify`):**

```text
=== /oversee — VERIFY (issue-<n>, execute PR #<PR>) ===
Head:            <headSha>
pipeline/verify: success | failure | missing  (before spawn)
Agent:           re-verify:<id>  verdict=<pass|fail>  verifiedSha=<sha>
Next action:     Review PR #<PR> and merge to `main` when satisfied (/oversee never merges).
                 | Re-run `/oversee --verify #<PR>` (head moved during verify).
```

**PLAN phase:**

```text
=== /oversee — PLAN phase (issue-<n>) ===
[Plan] PR:       #<planPR>  (<url>)
Plan doc:        docs/plans/issue-<n>.md
Critic:          PASSED — recommended | REJECTED (<class>) — <blocking findings>
Revise rounds:   <n>/2
Plan-sweep:      reviewer <satisfied|pending|unsatisfied>, <k> comment(s) addressed
Provenance:      oversee/plan-gate=success on <headSha>
Approval gate:   ☐ UNCHECKED
Next action:     Review PR #<planPR>, tick "APPROVED FOR EXECUTION", then run `/oversee #<planPR>`.
```

**EXECUTE phase:**

```text
=== /oversee — EXECUTE phase (issue-<n>) ===
Approved plan:   [Plan] PR #<planPR> @ <headSha>
Staleness gate:  FRESH (Sonnet validator, anchor <ISO timestamp>)
Execute PR:      #<executePR>  (<url>)   [carries the plan doc + the code]
Verify:          approve | changes-requested — <blocking findings>
Execute-sweep:   reviewer <satisfied|...>, CI <green|red>, <k> addressed
Next action:     Review PR #<executePR> and merge to `main` when satisfied (/oversee never merges).
```

**EXECUTE phase — refused (stale plan):**

```text
=== /oversee — EXECUTE REFUSED (issue-<n>) — STALE PLAN ===
Rejected plan:   [Plan] PR #<old> — CLOSED (validator's reasons commented on the PR)
Carry-forward:   round <n>/3 written to issue #<n>  (<comment url>)
Stale because:   <the validator's REASONS, one line each>
Re-planned as:   [Plan] PR #<new> — fresh approval gate installed
Next action:     Review the NEW plan PR #<new>, tick "APPROVED FOR EXECUTION", then run `/oversee #<new>`.
```

---

## Artifacts

State lives in `.codegraph/oversee/` (git-ignored via `**/.codegraph/*`). Every file holds a single bare value, newline-terminated.

| File | Written by | Contents |
|------|-----------|----------|
| `arg` | Arguments | The target number from `$ARGUMENTS` |
| `forced-phase` | Arguments | `plan`, `execute`, `verify`, or empty |
| `repo` | Phase 0 | `owner/name` from `gh repo view` |
| `phase` | Phase: Route | `plan` or `execute` |
| `task-id` | Plan context / gate recovery | `issue-<n>` |
| `issue` | Plan context / gate recovery | Tracking issue number |
| `title` | Plan context | Issue title |
| `labels` | Plan context | Comma-joined issue labels |
| `plan-pr` | Plan dispatch / gate recovery | `[Plan]` PR number |
| `plan-ref` | Plan dispatch / gate recovery | Plan doc path |
| `plan-head-sha` | Gate stamp / provenance check | The verified approved-plan commit |
| `execute-pr` | Execute recovery / dispatch | Execute PR number — recovered from GitHub on a resumed run, otherwise written by the dispatch |
| `open-ids` | Reconcile | Comma-joined root comment ids of the last tick's UNRESOLVED, non-outdated reviewer threads |

The durable artifacts live outside this directory, and are the point of the run: the plan doc under `docs/plans/`, the `[Plan]` PR with its approval gate, the `oversee/plan-gate` commit status, the execute PR, and — on a rejected plan — the `plan-carry-forward` comment on the tracking issue.

**Cleanup.** State is safe to re-read and safe to delete: a fresh invocation re-derives everything it needs from GitHub. Remove it with `rm -rf .codegraph/oversee` once the execute PR is merged. Leaving it costs nothing.

---

## Examples

```bash
# Plan issue #2601. Stops at the approval checkbox on the [Plan] PR.
/oversee #2601
```

```bash
# After reviewing the plan and ticking APPROVED FOR EXECUTION on [Plan] PR #2610,
# in a fresh context (/clear first):
/oversee #2610
```

```bash
# Force the PLAN phase for a number that also resolves to a PR.
/oversee --plan 2601
```

```bash
# Re-run independent VERIFY on execute PR #2611 after the build session ended.
/oversee --verify 2611
```

```bash
# Resume reconciliation after a /clear — re-derives the execute PR and reviewer
# state from GitHub instead of re-dispatching the build.
/oversee #2610
```

---

## Rules

- **Pre-flight first, or don't start.** The model must be Opus and effort must be >= xhigh (max ideal) — both are readable, so both are hard gates. Auto-accept mode is not readable anywhere, so it is confirmed with the human, never claimed as detected. `git`, `gh`, `jq`, `mktemp`, an authenticated `gh`, the engine file, and the worktree guard must all be present, and the engine's `REPO` constant must match this checkout.
- **`/oversee --verify <#execute-PR>` re-runs independent VERIFY on an open execute PR's current head.** Exclusive with `--plan` / `--execute`. Fail closed if task id and Done-when cannot be recovered. This skill never POSTs `pipeline/verify` — only a spawned `verifyPrompt` / `VERIFY_SCHEMA` agent may stamp. A `verifiedSha` that does not match the live head is a STOP (re-run), not an in-line loop.
- **The human is the plan gate.** EXECUTE runs only after a human ticks **APPROVED FOR EXECUTION** on the `[Plan]` PR. Never infer approval from a chat message, and never execute an unticked plan.
- **Provenance, not body trust.** The PLAN phase stamps `oversee/plan-gate=success` on the `[Plan]` PR head; EXECUTE verifies that status on the **current** head before honouring the checkbox. A PR body is mutable and cannot prove its own origin — a clean, ticked gate can be pasted in — so the commit status, not the body, is the authorization anchor. Install refuses any duplicate, foreign, or pre-ticked sentinel.
- **Never `eval` body-derived text.** The gate's `id`/`issue`/`planRef` are parsed with strict allow-list charsets and assigned by plain capture, so a tampered gate cannot inject shell.
- **Freshness before execution.** Human approval proves the plan was good *when approved*, not that it still is. A read-only Sonnet subagent — never this context, which it would blow up — validates the plan against its document dependency tree before EXECUTE. **STALE → reject and recreate**: write the carry-forward artifact *first*, comment the reasons, close the `[Plan]` PR, re-plan with the reasons seeded in, and stop at a fresh gate. **All-NARROW → patch in place, re-stamp on the new head, leave the box unticked.** **UNVERIFIABLE → STOP and report**, nothing destructive. Always check the verdict's `HEAD:` against the PR's current head first: a validator that judged a superseded revision reports findings already fixed on the live one.
- **Stop at three plan rounds.** Read the round counter only from a comment whose author holds real `admin`/`write` permission — never from `author_association`, which a read-only member or collaborator passes. An unknown round is not "under the cap".
- **Pin execution to the verified head SHA, not a moving branch ref.** EXECUTE builds the exact `planHeadSha` the gate was verified on and re-checks its provenance immediately before checkout. Resolving the plan branch by name at checkout time would build a revision no human approved; a moved head fails closed.
- **The critic is advisory.** Its verdict is surfaced next to the checkbox and never auto-advances anything. A REJECTED plan is flagged to the human, never silently dropped and never silently built. Fixable rejects are revised **in place** (max 2 rounds) — re-planning throws away resolved citations and rejected alternatives a revise keeps.
- **Independent critic, independent verify.** The verifier is never the builder and the critic is never the planner; the engine enforces this by dispatching separate agents.
- **One issue per run.** `/oversee` is single-issue by design. Use `/fixer` for a backlog.
- **Read the authority first, or abort.** `CLAUDE.md`, `.codegraph/basics.md`, the issue and its comments, the roadmap entry, and the relevant ADRs — never derive scope from an issue title.
- **Sync local `main` before each phase's context read.** Check the tree is clean first (`[ -z "$(git status --porcelain)" ]`): `git switch main` succeeds silently on non-conflicting uncommitted changes, tracked or untracked, and would carry them onto `main`. Then `git fetch origin && git switch main && git merge --ff-only origin/main`, failing closed on a dirty tree or a non-fast-forward. Never force, reset, or rebase past local work.
- **Readiness is warn-and-confirm**, not a gate: a `blocked` label, a self-gated issue, an open dependency, or a missing ADR is surfaced with the exact gate named and the human asked. The invariants and never-merge stay hard regardless of the answer.
- **Reconcile the reviewer as a re-entrant, scheduler-paced batch — never a live loop.** One bounded batch per tick: read state, spawn a single-round sweep if unsatisfied, then `ScheduleWakeup` (~360–420s) and end the turn, or stop when satisfied. Compare Greptile's summary **body**, not just the comment list — it edits in place. Escalate to the human only on genuine non-convergence: the same **unresolved** thread ids across 2 consecutive ticks, read from the GraphQL `reviewThreads` connection so resolved, outdated, and self-authored comments cannot pin a set that never shrinks.
- **Recover before you re-dispatch, and before the freshness gate.** Confirm Approval re-derives an already-open execute PR from the tracking issue's cross-references and routes straight to reconciliation, skipping both the freshness gate and the build. Adoption requires **provenance** — the candidate must target `main` and be strictly ahead of the approved plan head — not issue linkage, which any PR can claim. Strictly ahead, because a PR pointing at the plan head carries no build. Ordering is load-bearing: a STALE verdict closes the `[Plan]` PR and re-plans, which on a resumed run would orphan an open, possibly already-verified execute PR. Re-dispatching a resumed run cannot recover it — the builder claim-aborts on the already-claimed issue and returns no PR number, stranding the open PR with nobody reconciling its reviewer.
- **Every dispatched agent runs in worktree isolation and runs `.claude/scripts/assert-worktree.sh` before any branch-mutating git operation** (CLAUDE.md "Parallel Sessions"). Branch names must carry a hook-approved prefix — a `/worktree` `claude/...` branch is rejected on push.
- **Never merge anything.** Not the plan PR, not the execute PR. Humans own every merge to `main`.
- **Never weaken a gate to make a review pass**, and never document a native/WASM divergence as expected behavior — fix the root cause (CLAUDE.md).
- **No `Co-Authored-By` and no Claude/AI attribution** in any commit, PR, comment, or claim (hooks enforce it).
- **When blocked on an unresolved dependency or a missing decision, STOP and report** — don't route around it.
