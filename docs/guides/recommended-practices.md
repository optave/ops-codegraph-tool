# Recommended Practices

Practical patterns for integrating codegraph into your development workflow.

---

## Git Hooks

### Pre-commit: rebuild the graph

Keep your graph up to date automatically. Add this to your git hooks so the database is always fresh before you commit.

**With [husky](https://typicode.github.io/husky/) (recommended):**

```bash
npm install -D husky
npx husky init
echo "codegraph build" > .husky/pre-commit
```

**With a plain git hook:**

```bash
echo '#!/bin/sh
codegraph build' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

### Pre-push: impact check

See what your branch will affect before pushing:

```bash
# .husky/pre-push
codegraph build
codegraph diff-impact --ref origin/main --no-tests
```

This prints a summary like:

```
3 functions changed → 12 callers affected across 7 files
```

If you want to **block pushes** that exceed a threshold, add a check:

```bash
# .husky/pre-push
codegraph build
IMPACT=$(codegraph diff-impact --ref origin/main --no-tests --json)
AFFECTED=$(echo "$IMPACT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.summary?.callersAffected || 0)
")
if [ "$AFFECTED" -gt 50 ]; then
  echo "WARNING: $AFFECTED callers affected. Review with 'codegraph diff-impact' before pushing."
  exit 1
fi
```

### Commit message enrichment

Automatically append impact info to commit messages:

```bash
# .husky/prepare-commit-msg
IMPACT=$(codegraph diff-impact --staged --no-tests --json 2>/dev/null)
SUMMARY=$(echo "$IMPACT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  if (d.summary) console.log('Impact: ' + d.summary.functionsChanged + ' functions changed, ' + d.summary.callersAffected + ' callers affected');
" 2>/dev/null)
if [ -n "$SUMMARY" ]; then
  echo "" >> "$1"
  echo "$SUMMARY" >> "$1"
fi
```

---

## CI / GitHub Actions

### Basic: PR impact comments

Copy the included workflow to your repo:

```bash
cp node_modules/@optave/codegraph/.github/workflows/codegraph-impact.yml .github/workflows/
```

Every PR gets a comment:
> **3 functions changed** -> **12 callers affected** across **7 files**

### Advanced: fail on high-impact PRs

Add a threshold check to your CI pipeline:

```yaml
- name: Check impact threshold
  run: |
    npx codegraph build
    IMPACT=$(npx codegraph diff-impact --ref origin/${{ github.base_ref }} --json)
    AFFECTED=$(echo "$IMPACT" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.summary?.callersAffected || 0)
    ")
    echo "Callers affected: $AFFECTED"
    if [ "$AFFECTED" -gt 100 ]; then
      echo "::error::High impact PR — $AFFECTED callers affected. Requires additional review."
      exit 1
    fi
```

### Code health gate

Use `check` to enforce code health rules in CI — it exits with code 1 when any function exceeds a fail-level threshold:

```yaml
- name: Code health gate
  run: |
    npx codegraph build
    npx codegraph check -T  # exits 1 on fail-level breach (manifesto mode)
```

### Change validation gate

Use `check` for pass/fail CI validation with configurable predicates:

```yaml
- name: Validate changes
  run: |
    npx codegraph build
    npx codegraph check --staged --no-new-cycles --max-blast-radius 50 --no-boundary-violations -T
```

Combine multiple predicates — exit code 1 if any fails. Available predicates: `--no-new-cycles`, `--max-complexity <n>`, `--max-blast-radius <n>`, `--no-boundary-violations`.

### Caching the graph database

Speed up CI by caching `.codegraph/`:

```yaml
- uses: actions/cache@v4
  with:
    path: .codegraph
    key: codegraph-${{ hashFiles('src/**', 'lib/**') }}
    restore-keys: codegraph-
- run: npx codegraph build  # incremental — only re-parses changed files
```

---

## AI Agent Integration

> **Comprehensive guide:** See [AI Agent Guide](./ai-agent-guide.md) for the full reference — 6-step agent workflow, complete command reference with MCP tool mappings, Claude Code hooks, CLAUDE.md template, and CI/CD integration patterns.

### MCP server

Start the MCP server so AI assistants can query your graph:

```bash
codegraph mcp                  # Single-repo mode (default) — only local project
codegraph mcp --multi-repo     # Multi-repo — all registered repos accessible
codegraph mcp --repos a,b      # Multi-repo with allowlist
```

By default, the MCP server runs in **single-repo mode** — the AI agent can only query the current project's graph. The `repo` parameter and `list_repos` tool are not exposed, preventing agents from silently accessing other codebases.

#### Register with Claude Code

To give Claude Code direct access to codegraph tools (no Bash needed), register the MCP server:

```bash
# Linux / macOS
claude mcp add --transport stdio codegraph -- codegraph mcp

# Windows
claude mcp add --transport stdio codegraph -- cmd /c codegraph mcp
```

This saves the server to your local Claude Code config. Once registered, Claude can call codegraph tools (`where`, `explain`, `fn_impact`, `diff_impact`, etc.) natively — including from custom subagents.

Use `--scope project` to check it into `.mcp.json` so the whole team gets it:

```bash
claude mcp add --transport stdio codegraph --scope project -- codegraph mcp
```

Verify with:

```bash
claude mcp list
```

Enable `--multi-repo` to let the agent query any registered repository, or use `--repos` to restrict access to a specific set of repos.

The server exposes 31 tools (32 in multi-repo mode): `query`, `file_deps`, `impact_analysis`, `find_cycles`, `module_map`, `fn_impact`, `context`, `explain`, `where`, `diff_impact`, `semantic_search`, `export_graph`, `list_functions`, `structure`, `hotspots`, `node_roles`, `co_changes`, `execution_flow`, `complexity`, `communities`, `manifesto`, `code_owners`, `audit`, `batch_query`, `triage`, `check`, `branch_compare`, `ast_query`, `cfg`, `dataflow`, `symbol_children`, and `list_repos` (multi-repo only). See the [AI Agent Guide MCP reference](./ai-agent-guide.md#mcp-server-reference) for the full tool-to-CLI mapping table.

### CLAUDE.md for your project

Add this to your project's `CLAUDE.md` so AI agents know codegraph is available. A full template is in the [AI Agent Guide](./ai-agent-guide.md#claudemd-template). Here's the short version:

```markdown
## Code Navigation

This project uses codegraph. The database is at `.codegraph/graph.db`.

### Before modifying code, always:
1. `codegraph where <name>` — find where the symbol lives
2. `codegraph audit --quick <file-or-function>` — understand the structure
3. `codegraph context <name> -T` — get full context (source, deps, callers)
4. `codegraph fn-impact <name> -T` — check blast radius before editing

### After modifying code:
5. `codegraph diff-impact --staged -T` — verify impact before committing

### Other useful commands
- `codegraph build .` — rebuild the graph (incremental by default)
- `codegraph map` — module overview
- `codegraph fn <name> -T` — function call chain
- `codegraph path <from> <to> -T` — shortest call path between two symbols
- `codegraph deps <file>` — file-level dependencies
- `codegraph roles --role dead -T` — find dead code (unreferenced symbols)
- `codegraph roles --role core -T` — find core symbols (high fan-in)
- `codegraph co-change <file>` — files that historically change together
- `codegraph complexity -T` — per-function complexity metrics (cognitive, cyclomatic, MI)
- `codegraph communities --drift -T` — module boundary drift analysis
- `codegraph check -T` — pass/fail rule check (CI gate, exit code 1 on fail)
- `codegraph audit <target> -T` — combined structural summary + impact + health in one report
- `codegraph triage -T` — ranked audit priority queue
- `codegraph check --staged` — CI validation predicates (exit code 0/1)
- `codegraph batch target1 target2` — batch query multiple targets at once
- `codegraph owners [target]` — CODEOWNERS mapping for symbols
- `codegraph snapshot save <name>` — checkpoint the graph DB before refactoring
- `codegraph branch-compare main HEAD -T` — structural diff between two refs
- `codegraph search "<query>"` — semantic search (requires `codegraph embed`)
- `codegraph cycles` — check for circular dependencies

### Flags
- `-T` / `--no-tests` — exclude test files (use by default)
- `-j` / `--json` — JSON output for programmatic use
- `-f, --file <path>` — scope to a specific file
- `-k, --kind <kind>` — filter by symbol kind
```

### Claude Code hooks

> **Detailed reference:** See [AI Agent Guide — Claude Code Hooks](./ai-agent-guide.md#claude-code-hooks) for full documentation of each hook's behavior, triggers, and a complete `settings.json` example.

You can configure [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to give Claude automatic dependency context and keep the graph fresh as it edits files:

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/check-readme.sh\"",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Read|Grep",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/enrich-context.sh\"",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/remind-codegraph.sh\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "codegraph build",
            "timeout": 30
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/post-git-ops.sh\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**Enrichment hook** (PreToolUse on Read/Grep): when Claude reads a file, the hook runs `codegraph deps` and injects import/export context into the conversation via `additionalContext`. This means Claude sees "this file imports X, Y and is imported by Z" without having to be told.

> **Important:** For `additionalContext` to surface in the agent's context, the hook output must include all three fields in `hookSpecificOutput`: `hookEventName: "PreToolUse"`, `permissionDecision: "allow"`, and `additionalContext`. Without `hookEventName` and `permissionDecision`, the context is silently dropped. Example output:
>
> ```json
> {
>   "hookSpecificOutput": {
>     "hookEventName": "PreToolUse",
>     "permissionDecision": "allow",
>     "additionalContext": "[codegraph] src/builder.js\n  Imports: src/config.js, src/db.js"
>   }
> }
> ```

**Doc check hook** (PreToolUse on Bash): when Claude runs `git commit` with source files staged (anything under `src/`, `cli.js`, `constants.js`, `parser.js`, `package.json`, or `grammars/`), the hook checks whether `README.md`, `CLAUDE.md`, and `ROADMAP.md` are also staged. If any are missing, it blocks the commit with a `deny` decision listing which docs weren't staged and what to review in each (language support tables, architecture docs, roadmap phases, etc.). Non-source-only commits (tests, docs, config) pass through without checks.

**Edit reminder hook** (PreToolUse on Edit/Write): before the agent writes code, a reminder is injected via `additionalContext` prompting it to check `where`, `audit --quick`, `context`, and `fn-impact` first. Only fires once per file per session (tracks in `.claude/codegraph-checked.log`, gitignored). Non-blocking — it nudges but never prevents the edit. Skips non-source files like `.md`, `.json`, `.yml`.

**Graph update hook** (PostToolUse on Edit/Write): keeps the graph incrementally updated after each file edit. Only changed files are re-parsed.

**Git operation hook** (PostToolUse on Bash): detects `git rebase`, `git revert`, `git cherry-pick`, `git merge`, and `git pull` commands and automatically: (1) rebuilds the codegraph so dependency context stays fresh, (2) logs all files changed by the operation to `session-edits.log` so commit validation doesn't block rebase-modified files, and (3) clears stale entries from `codegraph-checked.log` so the edit reminder re-fires for affected files. Uses `ORIG_HEAD` (set by all these git operations) to detect which files changed. If the operation failed (e.g. merge conflicts), the diff safely returns nothing.

> **Windows note:** If your hooks use bash scripts, normalize backslashes inside `node -e` rather than bash (`${VAR//\\//}` fails on Git Bash). See this repo's `.claude/hooks/enrich-context.sh` for the pattern.

**Ready-to-use examples** are in [`docs/examples/claude-code-hooks/`](../examples/claude-code-hooks/) with a complete `settings.json` and setup instructions:
- `enrich-context.sh` — dependency context injection
- `remind-codegraph.sh` — pre-edit reminder to check context/impact
- `update-graph.sh` — incremental graph updates after edits
- `post-git-ops.sh` — graph rebuild + edit tracking after rebase/revert/merge
- `check-readme.sh` — blocks commits when source changes may require doc updates
- `guard-git.sh` — blocks dangerous git commands + validates commits
- `track-edits.sh` — logs edited files for commit validation
- `track-moves.sh` — logs file moves/copies for commit validation

#### Parallel session safety hooks

When multiple AI agents work on the same repo concurrently, add hooks to prevent cross-session interference:

- **Edit tracker** (PostToolUse on Edit|Write): log every file path touched to `.claude/session-edits.log`
- **Git guard** (PreToolUse on Bash): block `git add .`, `git reset`, `git restore`, `git clean`, `git stash`; validate that `git commit` only includes files from the session edit log; validate branch names match conventional prefixes

Pair with the `/worktree` command so each session gets an isolated copy of the repo.

#### Git operation resilience

Git operations like `rebase`, `revert`, `cherry-pick`, `merge`, and `pull` change file contents without going through the Edit/Write tools. Without special handling, this leaves the codegraph database stale, the edit tracker unaware of changed files, and the edit reminder not re-firing for modified files.

The **`post-git-ops.sh`** hook (PostToolUse on Bash) detects these operations and fixes all three problems:

1. **Graph rebuild** — runs `codegraph build` so that dependency context from `enrich-context.sh` reflects the post-operation state
2. **Edit log update** — uses `git diff --name-only ORIG_HEAD HEAD` to find files changed by the operation and appends them to `session-edits.log`, so `guard-git.sh` won't block commits that include rebase-modified files
3. **Reminder reset** — removes changed files from `codegraph-checked.log` so the agent is prompted to re-check context and impact before editing those files again

The codegraph incremental build itself is naturally resilient to git operations — it uses content hashing (not timestamps alone) to detect changes, and its reverse-dependency cascade ensures all affected import edges are rebuilt. The hook simply ensures the rebuild is triggered automatically rather than requiring a manual `codegraph build`.

#### Worktree isolation

All session-local state files (`session-edits.log`, `codegraph-checked.log`) use `git rev-parse --show-toplevel` to resolve the working tree root, rather than `CLAUDE_PROJECT_DIR`. This ensures each worktree gets its own isolated state — session A's edit log doesn't leak into session B's commit validation. Without this, `CLAUDE_PROJECT_DIR` (which points to the main project root) would cause all sessions to share a single edit log, defeating the parallel session safety model.

---

## Developer Workflow

### Watch mode during development

Keep the graph updating in the background while you code:

```bash
codegraph watch
```

Changes are picked up incrementally — no manual rebuilds needed.

### Explore before you edit

Before touching a function, understand its role and blast radius:

```bash
codegraph where myFunction               # where it's defined and used
codegraph roles --file src/utils/auth.ts # role of every symbol in the file (entry/core/utility/dead)
codegraph fn myFunction --no-tests       # callers, callees, call chain
codegraph fn-impact myFunction --no-tests  # what breaks if this changes
codegraph path myFunction otherFunction -T # how two symbols are connected
```

Check complexity before refactoring:

```bash
codegraph complexity --file src/utils/auth.ts -T  # complexity metrics for functions in a file
```

Before touching a file:

```bash
codegraph deps src/utils/auth.ts         # imports and importers
codegraph impact src/utils/auth.ts       # transitive reverse deps
codegraph co-change src/utils/auth.ts    # files that historically change together with this one
```

### Understand architectural roles

Every symbol is auto-classified based on its connectivity pattern. Use this to prioritize what to review, find dead code, or understand a module's structure:

```bash
codegraph roles -T                       # all roles across the codebase
codegraph roles --role dead -T           # unreferenced, non-exported symbols (cleanup candidates)
codegraph roles --role entry -T          # entry points (high fan-out, low fan-in)
codegraph roles --role core -T           # core symbols (high fan-in — break these, break everything)
codegraph roles --role core --file src/builder.js  # core symbols in a specific file
```

### Surface hidden coupling with co-change analysis

Static imports don't tell the full story. Files that always change together in git history are coupled — even if they don't import each other:

```bash
codegraph co-change --analyze            # scan git history (run once, then incremental)
codegraph co-change src/parser.js        # what files always change with parser.js?
codegraph co-change                      # top co-changing file pairs globally
codegraph co-change --min-jaccard 0.5    # only strong coupling
```

Co-change data is automatically included in `diff-impact` output — historically coupled files appear alongside the static dependency analysis.

### Find circular dependencies early

```bash
codegraph cycles                         # file-level cycles
codegraph cycles --functions             # function-level cycles
```

### Semantic search for discovery

When you're not sure where something lives:

```bash
codegraph search "handle authentication"
codegraph search "parse config file" --min-score 0.4
```

Build embeddings first (one-time):

```bash
codegraph embed                          # ~23 MB model, fast
codegraph embed --model jina-code        # ~137 MB, best for code search
codegraph embed --model bge-large        # ~335 MB, best general retrieval
```

### Multi-query search

When a single query doesn't capture what you're looking for, combine multiple angles with `;`. Results are ranked using Reciprocal Rank Fusion (RRF) — functions that score well across multiple queries rise to the top.

Use **2-4 sub-queries**. Each sub-query should attack the problem from a different angle. The framework below covers the four most effective angles — pick 2-3 that fit your situation:

#### 1. Name what it does vs. what it's called

Codebases are inconsistent. The function you want might be called `authenticate`, `checkAuth`, `verifyUser`, or `ensureLoggedIn`. Cover the likely naming variations:

```bash
# You think "validate input" — but the author might have written "sanitize", "check", or "parse"
codegraph search "validate input; sanitize request; check params"

# You think "send email" — but it could be "notify", "mail", or "deliver"
codegraph search "send email; notify user; deliver message"
```

#### 2. Describe the behavior at different abstraction levels

A high-level description ("handle payment") and a low-level one ("charge credit card") often match different but related functions. Combining them surfaces the full chain:

```bash
# High-level intent + low-level implementation
codegraph search "handle payment; charge credit card; create Stripe session"

# Architecture concept + concrete operation
codegraph search "rate limiting; count requests per window; throttle API"
```

#### 3. Cover the input side and the output side

Many operations have a clear "read" half and a "write" half. Querying both surfaces the full pipeline:

```bash
# Reading config + applying config
codegraph search "parse config file; apply settings; load environment"

# Receiving data + transforming data
codegraph search "deserialize JSON payload; map response to model"
```

#### 4. Include the domain term and the technical term

Business logic often uses domain language that differs from the technical implementation. Bridge both:

```bash
# Domain language + implementation pattern
codegraph search "onboard new tenant; create organization; provision workspace"

# User-facing concept + internal mechanism
codegraph search "user permissions; role-based access; check authorization"
```

#### Putting it together

A real-world search typically mixes 2-3 of these angles:

```bash
# Refactoring a caching layer — synonyms + abstraction levels + domain terms
codegraph search "cache invalidation; expire stale entries; TTL cleanup" --kind function

# Finding all auth-related code before a security review
codegraph search "authenticate request; verify JWT; check session token" --file "src/api/*"

# Understanding how errors propagate — input/output + abstraction
codegraph search "catch exception; format error response; report failure to client"
```

**Additional tips:**

- Keep each sub-query to **2-4 words** — embedding models work best on short, focused phrases
- Use `--kind function` or `--kind method` to cut noise from class/type matches
- Use `--file <pattern>` to scope to a directory when you roughly know where the code lives
- Lower `--rrf-k` (e.g., `--rrf-k 30`) to make top-ranked results dominate more sharply

---

## Secure Credential Management

Codegraph's LLM features (semantic search with LLM-generated descriptions, future `codegraph ask`) require an API key. Use `apiKeyCommand` to fetch it from a secret manager at runtime instead of hardcoding it in config files or leaking it through environment variables.

### Why not environment variables?

Environment variables are better than plaintext in config files, but they still leak via `ps e`, `/proc/<pid>/environ`, child processes, shell history, and CI logs. `apiKeyCommand` keeps the secret in your vault and only materializes it in process memory for the duration of the call.

### Examples

**1Password CLI:**

```json
{
  "llm": {
    "provider": "openai",
    "apiKeyCommand": "op read op://Development/openai/api-key"
  }
}
```

**Bitwarden CLI:**

```json
{
  "llm": {
    "provider": "anthropic",
    "apiKeyCommand": "bw get password anthropic-api-key"
  }
}
```

**macOS Keychain:**

```json
{
  "llm": {
    "provider": "openai",
    "apiKeyCommand": "security find-generic-password -s codegraph-llm -w"
  }
}
```

**HashiCorp Vault:**

```json
{
  "llm": {
    "provider": "openai",
    "apiKeyCommand": "vault kv get -field=api_key secret/codegraph/openai"
  }
}
```

**`pass` (GPG-encrypted):**

```json
{
  "llm": {
    "provider": "openai",
    "apiKeyCommand": "pass show codegraph/openai-key"
  }
}
```

### Priority chain

The resolution order is:

1. **`apiKeyCommand`** output (highest priority)
2. **`CODEGRAPH_LLM_API_KEY`** environment variable
3. **`llm.apiKey`** in config file
4. **`null`** (default)

If the command fails (timeout, not found, non-zero exit), codegraph logs a warning and falls back to the next available source. The command has a 10-second timeout.

### Security notes

- The command is split on whitespace and executed with `execFileSync` (array args, no shell) — no shell injection risk
- stdout is captured; stderr is discarded
- The resolved key is held only in process memory, never written to disk
- Keep `.codegraphrc.json` out of version control if it contains `apiKeyCommand` paths specific to your vault layout, or use a shared command that works across the team

---

## .gitignore

Add the codegraph database to `.gitignore` — it's a build artifact:

```
# codegraph
.codegraph/
```

The database is rebuilt from source with `codegraph build`. Don't commit it.

---

## Suggested setup checklist

```bash
# 1. Install codegraph
npm install -g @optave/codegraph

# 2. Build the graph
codegraph build

# 3. Add to .gitignore
echo ".codegraph/" >> .gitignore

# 4. Set up pre-commit hook (with husky)
npm install -D husky
npx husky init
echo "codegraph build" > .husky/pre-commit

# 5. Copy CI workflow
mkdir -p .github/workflows
cp node_modules/@optave/codegraph/.github/workflows/codegraph-impact.yml .github/workflows/

# 6. (Optional) Scan git history for co-change coupling
codegraph co-change --analyze

# 7. (Optional) Verify code health rules pass
codegraph check -T

# 8. (Optional) Set up CI validation gate
# codegraph check --staged --no-new-cycles --max-blast-radius 50 -T

# 9. (Optional) Build embeddings for semantic search
codegraph embed

# 10. (Optional) Register MCP server with Claude Code
claude mcp add --transport stdio codegraph -- codegraph mcp
# On Windows: claude mcp add --transport stdio codegraph -- cmd /c codegraph mcp

# 11. (Optional) Add CLAUDE.md for AI agents
# See docs/guides/ai-agent-guide.md for the full template
```
