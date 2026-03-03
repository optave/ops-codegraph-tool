# Claude Code Hooks for Codegraph

Ready-to-use [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) that keep the codegraph database fresh and provide automatic dependency context as Claude edits your codebase.

## Quick setup

```bash
# 1. Copy hooks into your project
mkdir -p .claude/hooks
cp docs/examples/claude-code-hooks/*.sh .claude/hooks/
chmod +x .claude/hooks/*.sh

# 2. Copy settings (or merge into your existing .claude/settings.json)
cp docs/examples/claude-code-hooks/settings.json .claude/settings.json

# 3. Add session logs to .gitignore
echo ".claude/session-edits.log" >> .gitignore
echo ".claude/codegraph-checked.log" >> .gitignore
```

## Hooks

### Core hooks (recommended for all projects)

| Hook | Trigger | What it does |
|------|---------|-------------|
| `enrich-context.sh` | PreToolUse on Read/Grep | Injects `codegraph deps` output (imports, importers, definitions) into Claude's context when it reads a file |
| `remind-codegraph.sh` | PreToolUse on Edit/Write | Reminds Claude to run `codegraph where`, `explain`, `context`, and `fn-impact` before editing a file. Fires once per file per session |
| `update-graph.sh` | PostToolUse on Edit/Write | Runs `codegraph build` incrementally after each source file edit to keep the graph fresh |
| `post-git-ops.sh` | PostToolUse on Bash | Detects `git rebase/revert/cherry-pick/merge/pull` and rebuilds the graph, logs changed files, and resets the remind tracker |

### Doc hygiene hooks

| Hook | Trigger | What it does |
|------|---------|-------------|
| `check-readme.sh` | PreToolUse on Bash | Blocks `git commit` when source files are staged but `README.md`, `CLAUDE.md`, or `ROADMAP.md` aren't — prompts the agent to review whether docs need updating |

### Parallel session safety hooks (recommended for multi-agent workflows)

| Hook | Trigger | What it does |
|------|---------|-------------|
| `guard-git.sh` | PreToolUse on Bash | Blocks `git add .`, `git reset`, `git restore`, `git clean`, `git stash`; validates commits only include files the session actually edited |
| `track-edits.sh` | PostToolUse on Edit/Write | Logs every file edited via Edit/Write to `.claude/session-edits.log` |
| `track-moves.sh` | PostToolUse on Bash | Logs files affected by `mv`/`git mv`/`cp` commands to `.claude/session-edits.log` |

## Git operation resilience

Git operations like `rebase`, `revert`, `cherry-pick`, `merge`, and `pull` change file contents without going through Edit/Write tools. Without `post-git-ops.sh`, this causes three problems:

1. **Stale graph** — `enrich-context.sh` provides outdated dependency info
2. **Blocked commits** — `guard-git.sh` rejects commits with rebase-modified files not in the edit log
3. **Stale reminders** — `remind-codegraph.sh` won't re-fire for files changed by the git operation

`post-git-ops.sh` fixes all three by detecting these git commands after they run and:
- Rebuilding the codegraph (`codegraph build`)
- Appending changed files (via `git diff --name-only ORIG_HEAD HEAD`) to the session edit log
- Removing changed files from the remind tracker so the agent re-checks context

## Worktree isolation

All session-local state files (`session-edits.log`, `codegraph-checked.log`) use `git rev-parse --show-toplevel` to resolve the working tree root, rather than `CLAUDE_PROJECT_DIR`. This ensures each git worktree gets its own isolated state — session A's edit log doesn't leak into session B's commit validation.

Without this fix, `CLAUDE_PROJECT_DIR` (which always points to the main project root) causes all worktree sessions to share a single edit log, defeating the parallel session safety model.

## Customization

**Subset installation:** You don't need all hooks. The core hooks work independently of the parallel session hooks. Pick what fits your workflow:

- **Solo developer:** `enrich-context.sh` + `update-graph.sh` + `post-git-ops.sh`
- **With reminders:** Add `remind-codegraph.sh`
- **Doc hygiene:** Add `check-readme.sh` to catch source commits that may need doc updates
- **Multi-agent / worktrees:** Add `guard-git.sh` + `track-edits.sh` + `track-moves.sh`

**Branch name validation:** The `guard-git.sh` in this repo's `.claude/hooks/` validates branch names against conventional prefixes (`feat/`, `fix/`, etc.). The example version omits this — add your own validation if needed.

## Requirements

- Node.js >= 20
- `codegraph` installed globally or available via `npx`
- Graph built at least once (`codegraph build`)
