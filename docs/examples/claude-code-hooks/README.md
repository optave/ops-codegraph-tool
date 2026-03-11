# Claude Code Hooks for Codegraph

Ready-to-use [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) that enforce code quality through codegraph analysis. These hooks exist because **Claude ignores CLAUDE.md instructions** — it won't voluntarily run `codegraph context`, `fn-impact`, or `diff-impact` before editing. Hooks compensate by injecting context passively and blocking bad commits automatically.

## Quick setup

```bash
# 1. Copy hooks into your project
mkdir -p .claude/hooks
cp docs/examples/claude-code-hooks/*.sh .claude/hooks/
cp docs/examples/claude-code-hooks/*.js .claude/hooks/
chmod +x .claude/hooks/*.sh

# 2. Copy settings (or merge into your existing .claude/settings.json)
cp docs/examples/claude-code-hooks/settings.json .claude/settings.json

# 3. Add session logs to .gitignore
echo ".claude/session-edits.log" >> .gitignore
```

## Design philosophy

Hooks fall into two categories:

- **Blocking hooks** (`permissionDecision: "deny"`) — actually work. Claude cannot bypass these.
- **Informational hooks** (`additionalContext`) — inject context Claude would otherwise skip. Partially effective.

If an instruction matters, make it a blocking hook. If it's in CLAUDE.md but not enforced, Claude will ignore it.

## Hooks

### Passive context injection

| Hook | Trigger | What it does |
|------|---------|-------------|
| `enrich-context.sh` | PreToolUse on Read/Grep | Injects `codegraph deps` output (imports, importers, definitions) into Claude's context when it reads a file. This is the only codegraph context Claude actually sees since it won't run the commands itself |

### Pre-commit gates (blocking)

| Hook | Trigger | What it does |
|------|---------|-------------|
| `pre-commit.sh` + `pre-commit-checks.js` | PreToolUse on Bash (git commit) | **Single Node.js process** that runs all codegraph checks: cycle detection (blocks), dead export detection (blocks), signature change warnings (informational), and diff-impact blast radius (informational) |
| `lint-staged.sh` | PreToolUse on Bash (git commit) | Blocks commits if staged files have lint errors (runs biome on session-edited files only) |

### Parallel session safety (blocking)

| Hook | Trigger | What it does |
|------|---------|-------------|
| `guard-git.sh` | PreToolUse on Bash | Blocks `git add .`, `git reset`, `git restore`, `git clean`, `git stash`; validates commits only include files the session actually edited |
| `track-edits.sh` | PostToolUse on Edit/Write | Logs every file edited to `.claude/session-edits.log` — required by guard-git.sh and pre-commit.sh |
| `track-moves.sh` | PostToolUse on Bash | Logs files affected by `mv`/`git mv`/`cp` to the edit log |

### Graph maintenance (passive)

| Hook | Trigger | What it does |
|------|---------|-------------|
| `update-graph.sh` | PostToolUse on Edit/Write | Runs `codegraph build` incrementally after source file edits to keep the graph fresh |
| `post-git-ops.sh` | PostToolUse on Bash | Detects `git rebase/revert/cherry-pick/merge/pull` and rebuilds the graph + logs changed files to the edit log |

## Pre-commit consolidation

Previous versions used 3 separate hooks (`show-diff-impact.sh`, `check-commit.sh`, `check-dead-exports.sh`) that each spawned their own Node.js process on every commit. These are now consolidated into `pre-commit.sh` + `pre-commit-checks.js` — a single Node.js invocation that runs all codegraph checks:

1. **Cycles** (blocking) — blocks if circular dependencies involve files you edited
2. **Dead exports** (blocking) — blocks if edited src/ files have exports with zero consumers
3. **Signature changes** (informational) — warns with risk level and transitive caller count
4. **Diff-impact** (informational) — shows blast radius of staged changes

## Worktree isolation

All session-local state files (`session-edits.log`) use `git rev-parse --show-toplevel` to resolve the working tree root, rather than `CLAUDE_PROJECT_DIR`. This ensures each git worktree gets its own isolated state — session A's edit log doesn't leak into session B's commit validation.

## Customization

**Subset installation:** Pick what fits your workflow:

- **Solo developer:** `enrich-context.sh` + `update-graph.sh` + `post-git-ops.sh`
- **With pre-commit checks:** Add `pre-commit.sh` + `pre-commit-checks.js` + `lint-staged.sh`
- **Multi-agent / worktrees:** Add `guard-git.sh` + `track-edits.sh` + `track-moves.sh`

**Branch name validation:** The `guard-git.sh` in this repo's `.claude/hooks/` validates branch names against conventional prefixes (`feat/`, `fix/`, etc.). The example version omits this — add your own validation if needed.

## Requirements

- Node.js >= 20
- `codegraph` installed globally or available via `npx`
- Graph built at least once (`codegraph build`)
- For `lint-staged.sh`: [Biome](https://biomejs.dev/) (or replace `npx biome check` with your linter)
