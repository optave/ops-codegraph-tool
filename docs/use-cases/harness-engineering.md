# Use Case: Harness Engineering — Preventing AI Agent Mistakes at Scale

> How codegraph powers the mechanical enforcement layer of harness engineering — the discipline of building systems that prevent AI coding agents from repeating mistakes.

---

## The Problem

AI coding agents are powerful, but they make mistakes. They introduce cycles, break callers they didn't know existed, violate architectural boundaries, and mark tasks complete without verifying impact. The standard response is to fix the mistake and move on.

Harness engineering is a different approach.

Coined by **Mitchell Hashimoto** (creator of Terraform and Ghostty), the core principle is:

> Every time an agent makes a mistake, you invest time engineering a solution so the agent never makes that mistake again.

The formula: **Model + Harness = Agent**. The harness is the set of constraints, tools, hooks, and feedback loops that keep an agent productive. A mediocre model with a great harness outperforms a great model with no harness. This isn't a one-time setup — it's a discipline that grows with every failure.

The concept has been developed independently by multiple teams:

| Source | Key contribution |
|--------|-----------------|
| [Mitchell Hashimoto](https://mitchellh.com/writing/my-ai-adoption-journey) | Coined the term; every line in AGENTS.md maps to a specific observed failure |
| [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Progress files + initializer agents for session continuity |
| [OpenAI](https://openai.com/index/harness-engineering/) | Remediation-focused linter messages as agent context injection |
| [INNOQ](https://www.innoq.com/en/blog/2026/02/from-vibe-coder-to-code-owner/) | 4-layer defense model (guardrails → AI review → human review → product testing) |
| [HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents) | Sub-agents as context firewalls; silent success / loud failure |
| [Martin Fowler](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) | Constraining the solution space makes agents more productive, not less |

The harness has four layers (INNOQ model). Each catches what the previous one missed:

1. **Deterministic guardrails** — pre-commit hooks, CI gates, linters (zero tolerance)
2. **AI review** — a separate agent reviews the first agent's code
3. **Selective human review** — developers focus on business logic and domain decisions
4. **Product testing** — does the software actually work end-to-end?

Codegraph is a **Layer 1 tool** — it provides the deterministic guardrails that mechanically prevent bad code from landing, without relying on the agent to "know" the rules.

---

## How Codegraph Helps — Today

### Deterministic Guardrails: Pre-Commit Gates

The most impactful harness component. The agent cannot commit until all checks pass — no warnings, no exceptions. It hits the wall, reads the error, and self-corrects.

```bash
# One-call pre-commit gate: cycles + blast radius + boundaries
codegraph check --staged --no-new-cycles --max-blast-radius 50 --no-boundary-violations -T
```

Exit code 0 = pass, 1 = fail. Perfect for hooks and CI gates. The agent doesn't need to know your architectural rules — the harness enforces them mechanically.

Individual checks for targeted enforcement:

```bash
# Did this change introduce a circular dependency?
codegraph check --staged --no-new-cycles

# Is the blast radius acceptable? (N = max callers affected)
codegraph check --staged --max-blast-radius 30

# Does this change violate module boundary rules?
codegraph check --staged --no-boundary-violations

# Full code health gate — 9 configurable rules with warn/fail thresholds
codegraph check -T
```

With Claude Code hooks, these run automatically on every commit attempt. See [Claude Code Hooks Guide](../examples/claude-code-hooks/README.md) for ready-to-use scripts.

### Remediation-Focused Error Messages

OpenAI's key finding: linter error messages become part of the agent's context. Opaque errors like `"Error: Invalid import"` force the agent to guess. Actionable messages like `"Cycle detected: A → B → C → A. Break the cycle by extracting shared logic"` teach the agent how to fix the problem.

Codegraph's output is designed for this:

```bash
codegraph check --staged --no-new-cycles --max-blast-radius 50 -T
```

```
FAIL  No new cycles
  Cycle detected: parser.js → builder.js → parser.js
  Break the cycle by extracting shared logic into a separate module.

FAIL  Max blast radius ≤ 50
  Function resolveImports affects 67 callers across 12 files.
  Consider splitting this function or reducing its public surface.
```

The agent reads these messages, understands what to fix, and self-corrects — no human intervention needed.

### Mechanical Architecture Enforcement

Agents replicate patterns that already exist in the repository — even suboptimal ones. Without mechanical enforcement, bad patterns compound exponentially (OpenAI's finding from 1,500 merged PRs with zero manually-written code).

Define your architecture in `.codegraphrc.json`:

```json
{
  "manifesto": {
    "boundaryPreset": "onion",
    "boundaries": [
      { "from": "src/presentation/**", "to": "src/db/**", "allow": false },
      { "from": "src/features/**", "to": "src/presentation/**", "allow": false }
    ]
  }
}
```

Then enforce it:

```bash
# The agent literally cannot create an import that violates layer direction
codegraph check --staged --no-boundary-violations -T

# Detect all existing boundary violations for cleanup
codegraph check --no-boundary-violations -T
```

The agent doesn't need to "know" the rule. It tries an import, the check fails with a clear message, and it restructures. The harness teaches through failure.

### Silent Success, Loud Failure

Running full test suites (4,000+ lines of passing tests) floods the agent's context window. The agent loses track of its task and starts hallucinating about test files it just read (documented by both HumanLayer and Anthropic).

Codegraph is designed for this — compact output by default:

```bash
# Compact impact summary, not a wall of data
codegraph diff-impact --staged -T
```

```
3 functions changed → 12 callers affected across 7 files
```

The `--json` flag gives structured data when needed, but the default output is human-and-agent-readable without flooding context.

Claude Code hooks follow the same principle: exit 0 produces no output, only failures surface messages.

### Blast Radius Awareness Before Editing

The harness engineering principle: the agent should know what breaks *before* writing code, not after. Codegraph provides this natively:

```bash
# Before editing: what depends on this function?
codegraph fn-impact resolveImports -T
# → 67 callers across 12 files. Highest-impact caller: buildGraph (47 transitive)

# Before editing: structural summary without reading raw source
codegraph audit --quick src/parser.js

# After editing: verify nothing unexpected broke
codegraph diff-impact --staged -T

# Compare branch vs main: cumulative impact of all changes
codegraph diff-impact main -T
```

This is the agent equivalent of "measure twice, cut once" — the harness forces the agent to assess impact before and after every change.

### Continuous Garbage Collection

Instead of periodic cleanup sprints, encode standards as rules and run them on cadence:

```bash
# Find dead code — zero fan-in, not exported
codegraph roles --role dead -T

# Risk-ranked priority queue — what to clean up first
codegraph triage -T --limit 30

# Code health violations — what exceeds thresholds right now
codegraph check -T

# Cycle inventory — architectural debt
codegraph cycles
```

Human taste is captured once in the rule, then enforced continuously. The engineering discipline shifts from code quality to **scaffolding quality**.

### CI Integration

All of the above works in CI pipelines, not just locally:

```yaml
# GitHub Actions example
- name: Build graph
  run: npx codegraph build

- name: Code health gate
  run: npx codegraph check -T

- name: Change validation
  run: npx codegraph check --staged --no-new-cycles --max-blast-radius 50 --no-boundary-violations -T

- name: Impact comment on PR
  run: |
    IMPACT=$(npx codegraph diff-impact --ref origin/${{ github.base_ref }} -T)
    gh pr comment ${{ github.event.number }} --body "$IMPACT"
```

---

## The Full Harness Stack with Codegraph

Here's how codegraph maps to each harness engineering practice:

| Harness Practice | Problem it solves | Codegraph implementation |
|---|---|---|
| **Deterministic guardrails** | Agent introduces cycles, boundary violations, high blast radius | `codegraph check --staged` with configurable predicates |
| **Remediation-focused errors** | Agent can't self-correct from opaque error messages | `check` output includes what violated, where, and how to fix |
| **Mechanical architecture** | Bad patterns compound exponentially without enforcement | `check --no-boundary-violations` + `.codegraphrc.json` boundary rules |
| **Silent success / loud failure** | Large output floods context, causes hallucinations | Compact default output; `--json` only when needed |
| **Blast radius awareness** | Agent edits functions without knowing who depends on them | `fn-impact`, `diff-impact --staged`, `audit --quick` |
| **Continuous garbage collection** | Technical debt accumulates between cleanup sprints | `triage`, `roles --role dead`, `check`, `cycles` on cadence |
| **End-to-end verification** | Agent marks features complete without verifying impact | `diff-impact --staged` as structural verification gate |
| **Progress tracking** | Agent loses context across sessions | Titan skills with JSON state files + `snapshot save/restore` |
| **Sub-agent isolation** | Context window pollution from intermediate work | `batch` for multi-target queries; MCP for structured tool access |

---

## What's on the Roadmap

Several planned features would make codegraph even more powerful as a harness engineering tool. These are tracked in the [roadmap](../roadmap/ROADMAP.md) and [backlog](../roadmap/BACKLOG.md):

### Stronger guardrails

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Async hygiene detection** | Proposed | AST-level detection of uncaught promises, `.then()` without `.catch()`. Currently agents rely on grep, which is fragile. `codegraph check --floating-promises` |
| **Resource leak detection** | Proposed | AST detection of `addEventListener`/`setInterval` without matching cleanup. Mechanical prevention of a class of bugs agents consistently introduce |
| **Empty catch detection** | Proposed | Find empty `catch` blocks — a pattern agents produce frequently when told to "add error handling" |
| **Magic literal detection** | Proposed | Find hardcoded strings/numbers in logic branches. Agents default to magic values unless the harness catches them |

### Smarter feedback

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Build-time semantic metadata** ([Phase 4.4](../roadmap/ROADMAP.md#44--build-time-semantic-metadata)) | Planned | LLM-generated `risk_score`, `complexity_notes`, and `side_effects` per function. The `check` output becomes "3 responsibilities, low cohesion — split before editing" instead of just a number |
| **Refactoring analysis** ([Phase 8.5](../roadmap/ROADMAP.md#85--refactoring-analysis)) | Planned | `split_analysis` and `extraction_candidates` — codegraph tells the agent *how* to fix a violation, not just *that* it violated |

### Pipeline integration

| Feature | Status | How it helps |
|---------|--------|-------------|
| **GitHub Action** ([Phase 7](../roadmap/ROADMAP.md#phase-7--github-integration--ci)) | Planned | Reusable GitHub Action that runs `diff-impact` + `check` on every PR, posts visual impact graphs, and fails if thresholds are exceeded |
| **Session state persistence** | Proposed | Built-in `codegraph session init/update/status` for multi-phase pipelines — replaces manual JSON state management in skills |
| **Concurrent-safe graph operations** | Proposed | `--read-only` flag for safe parallel querying. Multiple agents running simultaneously currently risk SQLite corruption |

### New backlog items surfaced by harness engineering patterns

Building harness systems for AI agents revealed gaps where codegraph could provide first-class support:

| ID | Title | Description | Category | Benefit | Backlog candidate |
|----|-------|-------------|----------|---------|-------------------|
| — | **Harness health dashboard** | Single command showing the state of all harness layers: which rules are active, which are passing, what's unguarded. Like `codegraph stats` but for the harness itself | Orchestration | Agents and humans see at a glance which guardrails are in place and which areas are unprotected | `codegraph harness-status` |
| — | **Rule suggestion from failures** | When `check` fails, suggest a `.codegraphrc.json` rule that would have caught it earlier. "This blast radius of 67 would have been caught by `max-blast-radius: 50`" | Intelligence | Accelerates the harness growth loop — every failure produces a concrete rule suggestion | Enhancement to `check` output |
| — | **Remediation templates** | Configurable fix-suggestion templates attached to `check` rules. When boundary violation fires, the message includes a project-specific remediation: "Extract to `src/shared/` per our architecture guide" | Developer Experience | Makes error messages maximally actionable for agents in a specific codebase, not just generic advice | `manifesto.remediationTemplates` config |
| — | **Duplicate code detection** | Identify semantically similar functions — near-duplicates that agents create when they can't find existing utilities | Analysis | Agents frequently reinvent existing functions. Catching duplicates in `check` prevents code bloat | `codegraph check --no-duplicates` or `codegraph duplicates` |
| — | **Mutation tracking** | Detect functions that mutate their arguments or external state | Analysis | Agents produce side-effect-heavy code by default. Making mutations visible in `audit` helps both agents and reviewers | Enhancement to `dataflow` |

---

## Getting Started

### 1. Install and build the graph

```bash
npm install -g @optave/codegraph
cd your-project
codegraph build
```

### 2. Add your first guardrail

Start with cycle detection — it catches the most common structural mistake:

```bash
# Test it manually first
codegraph check --no-new-cycles -T

# Then add to pre-commit hook
echo 'codegraph build && codegraph check --staged --no-new-cycles -T' > .husky/pre-commit
```

### 3. Add blast radius limits

Pick a threshold that matches your codebase. Start generous and tighten over time:

```bash
codegraph check --staged --max-blast-radius 100 -T
```

### 4. Define architecture boundaries

```json
// .codegraphrc.json
{
  "manifesto": {
    "boundaries": [
      { "from": "src/ui/**", "to": "src/db/**", "allow": false }
    ]
  }
}
```

### 5. Iterate

Every time the agent makes a mistake, add a rule:

- Agent introduced a cycle? → `--no-new-cycles` (already there)
- Agent broke 50 callers? → `--max-blast-radius 30`
- Agent imported db from ui? → Add a boundary rule
- Agent exceeded complexity? → Set `manifesto.rules.cognitive.fail: 15`

The harness grows with every failure. That's the whole point.

### With Claude Code hooks

For the full automated experience — hooks that run codegraph checks on every commit, inject dependency context on every file read, and rebuild the graph after every edit:

```bash
cp -r node_modules/@optave/codegraph/docs/examples/claude-code-hooks/ .claude/hooks/
```

See [Claude Code Hooks Guide](../examples/claude-code-hooks/README.md) for details.

---

## Further Reading

- [Recommended Practices](../guides/recommended-practices.md) — Git hooks, CI/CD, and AI agent integration patterns
- [AI Agent Guide](../guides/ai-agent-guide.md) — The 6-step agent workflow with codegraph
- [Titan Paradigm](./titan-paradigm.md) — Multi-agent autonomous codebase cleanup (uses harness engineering as its Layer 1)
- [Claude Code Hooks](../examples/claude-code-hooks/README.md) — Ready-to-use hook scripts
