# Harness AI Engineering

A practical guide to building systems that prevent AI coding agents from repeating mistakes.

---

## What is Harness Engineering?

The term was coined by Mitchell Hashimoto (creator of Terraform and Ghostty). The core principle:

> Every time an agent makes a mistake, you invest time engineering a solution so the agent never makes that mistake again.

The formula: **Model + Harness = Agent**. The harness is the set of constraints, tools, documentation, and feedback loops that keep an agent productive. A mediocre model with a great harness outperforms a great model with no harness.

This is not a one-time setup — it's a discipline that grows with every failure.

---

## The 4-Layer Defense Model

Based on the INNOQ model, quality control stacks in layers — each catches what the previous one missed.

### Layer 1: Deterministic Guardrails

Automated checks that mechanically prevent bad code from landing.

**Pre-commit hooks** (fast, local):
- Unit tests, integration tests
- Architecture tests (dependency direction, cycle detection)
- Linting and formatting
- Blast radius thresholds

**CI pipeline** (thorough, remote):
- End-to-end tests
- Security scans
- Static analysis
- Change validation gates

Zero-tolerance enforcement: the agent cannot proceed until all checks pass. No warnings — only blocking failures that force self-correction.

```bash
# Example: codegraph pre-commit gate
codegraph build
codegraph check --staged --no-new-cycles --max-blast-radius 50 -T
```

### Layer 2: AI Review

A separate AI agent reviews the code independently. It examines requirement fulfillment, architecture compliance, and code smells that static analysis misses. This provides consistent, fast evaluation without human bottlenecks.

### Layer 3: Selective Human Review

Developers focus exclusively on core business logic and domain decisions. Standard patterns, boilerplate, and mapping code stay within the harness's scope. Shift from "read every line" to "targeted attention based on risk."

### Layer 4: Product Testing

Functional verification: does the software work as intended? Feature testing, behavior verification, UX validation. Preview environments deployed per merge request.

**Accountability test:** "Would you ship this if you were on call tonight?" If no, the harness needs strengthening.

---

## Practice 1: AGENTS.md as Table of Contents

Your `CLAUDE.md` / `AGENTS.md` is the highest-leverage harness component. It's injected into the system prompt — roughly one-third of the instructions the agent can follow with consistency.

**Rules:**
- Keep it under ~100 lines. Every line should correspond to a specific observed failure.
- Use it as a pointer to deeper docs, not an encyclopedia.
- Never auto-generate it — LLM-generated instruction files increase cost ~20% with no accuracy improvement (ETH Zurich study). Human-written, failure-driven instructions are what work.

**Structure:**

```markdown
# CLAUDE.md

## Build
- Run full build: `npm run build`
- Run tests: `npm test`
- Run lint: `npm run lint`

## Architecture
- Dependency direction: Types -> Config -> Repo -> Service -> Runtime -> UI
- Never import from a layer to the right

## Coding rules
- All logging must be structured (JSON)
- Max file size: 500 lines

## When you finish a task
- Run tests before committing
- Write descriptive commit message
- Update progress file
```

Start small. Add rules only when the agent fails repeatedly on the same point. The Ghostty project's `AGENTS.md` is deliberately terse: build commands, test commands, directory structure, and one anti-pattern rule. Each line earns its place by preventing a specific observed failure.

---

## Practice 2: Remediation-Focused Linter Messages

OpenAI's key finding: custom linters with remediation-focused error messages are critical because **the error message becomes part of the agent's context when it fails**.

**Ineffective:**
```
Error: Invalid import
```

**Effective:**
```
Error: Service layer cannot import from UI layer.
Move this logic to a Provider or restructure the dependency.
See docs/ARCHITECTURE.md#layers
```

The remediation message teaches the agent how to fix the problem in-context, enabling self-correction without human intervention. Write linter messages as if they are instructions to an agent — because they are.

With codegraph, this is built-in:

```bash
# codegraph check provides actionable output
codegraph check --staged --no-new-cycles --max-blast-radius 50 -T
# Output: "Cycle detected: A -> B -> C -> A. Break the cycle by..."
# Output: "Blast radius 67 exceeds threshold 50. Function X affects..."
```

---

## Practice 3: Silent Success, Loud Failure

Running full test suites (thousands of passing tests) floods the context window. The agent loses track of its task and starts hallucinating about test files it just read.

**Rule:** Configure scripts so stdout on success is minimal. Only surface errors.

```bash
# Bad: 4,000 lines of passing tests flood context
npm test

# Good: swallow passing output, surface only failures
npm test > /dev/null 2>&1 || npm test
```

With Claude Code hooks, this is the default pattern — hooks that exit 0 produce no output. Only non-zero exits surface messages to the agent.

---

## Practice 4: Mechanical Architecture Enforcement

Don't document "please follow this pattern" — enforce it mechanically. Agents replicate patterns that already exist in the repository, even suboptimal ones. Without mechanical enforcement, bad patterns compound exponentially.

**Dependency direction:**
```
Types -> Config -> Repo -> Service -> Runtime -> UI
```

**Enforcement tools:**
- `codegraph check --no-boundary-violations` — blocks imports that violate layer direction
- `codegraph cycles` — detects circular dependencies
- Custom ESLint rules or `dependency-cruiser` for additional constraints
- CI gates that fail the build on violations

The agent literally cannot create an import that violates the direction. It doesn't need to "know" the rule — the harness enforces it.

---

## Practice 5: Sub-Agents as Context Firewalls

Sub-agents encapsulate discrete tasks in isolated context windows. The parent agent only sees the prompt sent and the final result — no intermediate tool calls, file reads, or search results pollute the parent's context.

**Good uses for sub-agents:**
- Research and code exploration
- Implementation of isolated features
- Code review
- Test generation

**Cost optimization:** Use expensive models (Opus) for orchestration, cheaper models (Sonnet/Haiku) for sub-agents. Return format should be highly condensed with `filepath:line` citations.

**Anti-pattern:** Role-based agents ("frontend engineer" vs "backend engineer") don't work well. Task-based agents work.

---

## Practice 6: Progress Files for Long-Running Tasks

Anthropic documented this pattern for agents that work across many sessions. The core challenge: each new context window starts with no memory.

**Two-agent architecture:**

1. **Initializer agent** (runs once):
   - Creates `init.sh` (one-command environment setup)
   - Creates `progress.txt` (work history log)
   - Creates `features.json` (comprehensive feature breakdown with pass/fail status)
   - Makes initial commit documenting everything

2. **Coding agent** (every subsequent session):
   - Read git logs and progress files for context
   - Select single highest-priority incomplete feature
   - Implement incrementally
   - Run end-to-end verification
   - Commit and update progress documentation

**Key details:**
- Use JSON for feature tracking (not markdown) — agents are less likely to overwrite structured data
- Track failed approaches and why they didn't work — prevents repeating dead ends
- One feature per session — scope creep across features degrades quality

---

## Practice 7: End-to-End Verification

Agents tend to mark features complete without adequate testing. Without explicit prompting, they use unit tests or curl commands but fail to verify end-to-end functionality.

**Solution:** Give the agent tools for end-to-end verification:
- Browser automation (Puppeteer MCP) for UI testing
- `codegraph diff-impact --staged` for structural impact verification
- Integration test suites that exercise real code paths

The agent must verify features work as a user would experience them, not just that the code compiles.

---

## Practice 8: Wrapper CLIs Over MCP Servers

MCP tool descriptions consume thousands of tokens from the system prompt. For simple integrations, a wrapper CLI with 5-6 usage examples in your AGENTS.md is cheaper and often more effective.

```markdown
## Issue tracking
Use `./scripts/issues.sh` to manage issues:
- `./scripts/issues.sh list --status open` — list open issues
- `./scripts/issues.sh get PROJ-123` — get issue details
- `./scripts/issues.sh update PROJ-123 --status done` — close an issue
```

Reserve MCP for tools that benefit from structured schema and dynamic discovery (like codegraph's 30+ tools). Use wrapper CLIs for simple CRUD operations.

---

## Practice 9: Continuous Garbage Collection

Instead of periodic cleanup sprints, encode golden principles as lint rules and run background agent tasks on cadence to auto-generate targeted refactoring PRs.

Human taste is captured once in the rule, then enforced continuously:

```bash
# Scheduled: find code that violates current standards
codegraph roles --role dead -T        # Find dead code
codegraph triage -T                   # Risk-ranked priority queue
codegraph check -T                    # Health gate violations
```

The engineering discipline shifts from code quality to **scaffolding quality** — the tooling, documentation, feedback loops, and architectural constraints that maintain coherence during autonomous code generation.

---

## Applying This to Codegraph Projects

Codegraph already implements most of these practices. Here's how they map:

| Harness Practice | Codegraph Implementation |
|---|---|
| Deterministic guardrails | `codegraph check` pre-commit gates, cycle detection, blast radius thresholds |
| Remediation-focused errors | `codegraph check` output includes what violated and where |
| Mechanical architecture | `codegraph check --no-boundary-violations`, `codegraph cycles` |
| Silent success / loud failure | Claude Code hooks exit silently on success |
| AGENTS.md | `CLAUDE.md` with codegraph workflow commands |
| Progress tracking | Titan Paradigm skills with state files |
| Sub-agent context isolation | Claude Code sub-agents with `/worktree` isolation |
| End-to-end verification | `codegraph diff-impact --staged` structural verification |
| Continuous garbage collection | `codegraph triage`, `codegraph roles --role dead` |

### Quick Start

To add harness engineering to an existing codegraph project:

1. **Create `CLAUDE.md`** with build commands and your top 5 failure-driven rules
2. **Add pre-commit hooks** using codegraph check:
   ```bash
   codegraph check --staged --no-new-cycles --max-blast-radius 50 -T
   ```
3. **Configure CI gates** with `codegraph check -T` in your pipeline
4. **Set up Claude Code hooks** — see [Claude Code Hooks Guide](../examples/claude-code-hooks/README.md) for ready-to-use scripts
5. **Add boundary rules** in `.codegraphrc.json` to enforce your architecture mechanically
6. **Iterate:** every time the agent makes a mistake, add a rule or a check. The harness grows with every failure.

---

## Sources

- [Mitchell Hashimoto — My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
- [Ghostty AGENTS.md](https://github.com/ghostty-org/ghostty/blob/main/AGENTS.md)
- [Anthropic — Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [OpenAI — Harness Engineering](https://openai.com/index/harness-engineering/)
- [INNOQ — From Vibe Coder to Code Owner](https://www.innoq.com/en/blog/2026/02/from-vibe-coder-to-code-owner/)
- [HumanLayer — Skill Issue: Harness Engineering for Coding Agents](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [Martin Fowler — Harness Engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html)
