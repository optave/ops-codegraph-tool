# AI Agent Guide for Codegraph

How to use codegraph to make AI coding agents faster, cheaper, and safer.

## The Problem

AI agents waste tokens and make blind edits because they lack structural awareness:

- **Token waste:** Agents `cat` entire files to find one function. A 500-line file costs ~2000 tokens when the agent only needs a 15-line function and its signature.
- **Stale context:** Grep-based navigation misses structural changes. Renaming a function shows the definition but not all the call sites that broke.
- **Blast radius blindness:** Agents edit a function without knowing who calls it. The fix works locally but breaks three callers upstream.
- **Scattered dependencies:** Understanding a function requires reading its callees, their callees, the tests — agents piece this together with 10+ file reads.

Codegraph solves these problems by providing a pre-built dependency graph that agents can query in a single call.

### Token Savings

| Task | Without codegraph | With codegraph | Savings |
|------|------------------|----------------|---------|
| Understand a function | Read 3–5 full files (~10K tokens) | `context <name>` (~400 tokens) | ~96% |
| Find what a file does | Read the file + imports (~4K tokens) | `explain <file>` (~300 tokens) | ~92% |
| Locate a symbol | Grep + read matches (~3K tokens) | `where <name>` (~60 tokens) | ~98% |
| Assess change impact | Read callers manually (~5K tokens) | `fn-impact <name>` (~200 tokens) | ~96% |
| Pre-commit check | Manual review (~8K tokens) | `diff-impact --staged` (~300 tokens) | ~96% |

---

## The 6-Step Agent Workflow

Use this sequence for any coding task — bug fix, feature, or refactor:

### Step 1: Orient

Get a high-level view of the codebase before diving in.

```bash
codegraph map --limit 20       # Most-connected modules
codegraph stats                # Graph health: nodes, edges, languages, quality score
codegraph structure            # Directory tree with cohesion scores
```

**When to use:** Start of a session, or when working in an unfamiliar codebase.

### Step 2: Locate

Find where the relevant symbol lives.

```bash
codegraph where <name>              # Fast lookup: definition + usage sites
codegraph where --file <path>       # File overview: symbols, imports, exports
codegraph search "error handling"   # Semantic search (requires prior `embed`)
```

**When to use:** You know what you're looking for (a function name, a concept) but not where it is.

### Step 3: Understand

Get a structural summary without reading raw source.

```bash
codegraph explain <file>            # File summary: public API, internal API, data flow
codegraph explain <function>        # Function summary: signature, calls, callers, tests
```

**When to use:** Before modifying anything. Understand the shape of the code first.

### Step 4: Gather Context

Pull everything needed to make the change — in one call.

```bash
codegraph context <name> -T         # Source + deps + callers + tests (no test files)
codegraph context <name> --depth 1  # Include callee source code too
codegraph fn <name> -T              # Lighter: just callers/callees chain
```

**When to use:** You've decided what to change and need the full picture to write correct code.

### Step 5: Assess Impact

Check what will break before making changes.

```bash
codegraph fn-impact <name> -T       # Function-level blast radius
codegraph impact <file>             # File-level transitive dependents
codegraph diff-impact main          # Impact of all changes vs a branch
```

**When to use:** Before editing, to know the blast radius. After editing, to verify nothing unexpected is affected.

### Step 6: Verify

Check staged changes before committing.

```bash
codegraph diff-impact --staged -T   # Impact of what you're about to commit
codegraph cycles                    # Ensure no new circular dependencies
codegraph stats                     # Confirm graph quality hasn't degraded
```

**When to use:** After staging changes, before the commit.

---

## Command Reference

Every command listed with its purpose, syntax, MCP tool name, key flags, and when an agent should reach for it.

### Navigation Commands

#### `where` — Fast symbol/file lookup

Find where a symbol is defined and every place it's used.

```bash
codegraph where <name>              # Symbol lookup
codegraph where --file <path>       # File overview: symbols, imports, exports
```

| | |
|---|---|
| **MCP tool** | `where` |
| **Key flags** | `-f, --file <path>` (file mode), `-T` (no tests), `-j` (JSON) |
| **When to use** | First step when you know a name but not where it lives |
| **Output** | Definition location (file:line), usage sites, export status |

#### `explain` — Structural summary

Get a human-readable summary of a file or function without reading raw source.

```bash
codegraph explain src/parser.js     # File: public API, internal functions, data flow
codegraph explain buildGraph        # Function: signature, what it calls, who calls it
```

| | |
|---|---|
| **MCP tool** | `explain` |
| **Key flags** | `-T` (no tests), `-j` (JSON) |
| **When to use** | Before modifying code — understand structure first |
| **Output** | For files: public/internal API, imports, dependents. For functions: signature, callees, callers, tests |

#### `deps` — File-level dependencies

Show what a file imports and what imports it.

```bash
codegraph deps src/builder.js
```

| | |
|---|---|
| **MCP tool** | `file_deps` |
| **Key flags** | `-T` (no tests), `-j` (JSON) |
| **When to use** | Understanding a file's position in the dependency graph |
| **Output** | Imports list, importers list, symbols defined in the file |

#### `fn` — Function-level dependency chain

Show what a function calls (callees) and what calls it (callers), with transitive depth.

```bash
codegraph fn buildGraph -T          # Callers + callees, no test files
codegraph fn resolve --file resolve.js --depth 5
```

| | |
|---|---|
| **MCP tool** | `fn_deps` |
| **Key flags** | `--depth <n>` (default: 3), `-f, --file` (scope to file), `-k, --kind` (filter kind), `-T` (no tests), `-j` (JSON) |
| **When to use** | Tracing a call chain — "who calls this and what does it call?" |
| **Output** | Direct callees, direct callers, transitive callers up to depth N |

### Context Commands

#### `context` — Full function context in one call

Everything an agent needs to understand or modify a function: source code, dependencies with summaries, callers, related tests, and signature.

```bash
codegraph context buildGraph -T           # Source + deps + callers (no test files)
codegraph context buildGraph --depth 1    # Also include callee source code
codegraph context buildGraph --no-source  # Metadata only (fastest)
```

| | |
|---|---|
| **MCP tool** | `context` |
| **Key flags** | `--depth <n>` (callee source depth, default: 0), `-f, --file` (scope), `-k, --kind`, `--no-source` (metadata only), `--include-tests` (test source), `-T` (no tests), `-j` (JSON) |
| **When to use** | The primary command for gathering everything before writing code |
| **Output** | Source code, signature, callees with summaries, callers, related test files |

#### `search` — Semantic search

Find functions by natural language description. Requires embeddings (`codegraph embed` first).

```bash
codegraph search "parse import statements"
codegraph search "error handling in database layer" -T --limit 5
```

| | |
|---|---|
| **MCP tool** | `semantic_search` |
| **Key flags** | `-n, --limit` (default: 15), `--min-score` (default: 0.2), `-k, --kind`, `--file <pattern>`, `-T` (no tests), `-m, --model` |
| **When to use** | You know what you want but not what it's called |
| **Output** | Ranked results with similarity scores, file locations, symbol kinds |

**Multi-query tip:** Semantic search supports multi-query RRF ranking. Phrase the same intent multiple ways for better recall:

```bash
codegraph search "parse imports, resolve dependencies, extract require statements"
```

### Impact Commands

#### `fn-impact` — Function-level blast radius

Show all functions that transitively depend on a given function — what breaks if it changes.

```bash
codegraph fn-impact buildGraph -T
codegraph fn-impact resolve --file resolve.js --depth 3
```

| | |
|---|---|
| **MCP tool** | `fn_impact` |
| **Key flags** | `--depth <n>` (default: 5), `-f, --file` (scope), `-k, --kind`, `-T` (no tests), `-j` (JSON) |
| **When to use** | Before modifying a function — know who depends on it |
| **Output** | Affected functions at each depth level, total count |

#### `path` — Shortest path between two symbols

Find how symbol A reaches symbol B through the call graph.

```bash
codegraph path buildGraph openDb -T           # Forward: A calls...calls B
codegraph path validateToken handleRoute --reverse  # Backward: B is called by...A
codegraph path parseConfig loadFile --max-depth 5
```

| | |
|---|---|
| **MCP tool** | `symbol_path` |
| **Key flags** | `--max-depth <n>` (default: 10), `--kinds <kinds>` (default: calls), `--reverse`, `--from-file`, `--to-file`, `-k, --kind`, `-T` (no tests), `-j` (JSON) |
| **When to use** | Understanding how two functions are connected through the call chain |
| **Output** | Ordered path with edge kinds, hop count, alternate path count |

#### `impact` — File-level transitive impact

Show all files that transitively depend on a given file.

```bash
codegraph impact src/parser.js
```

| | |
|---|---|
| **MCP tool** | `impact_analysis` |
| **Key flags** | `-T` (no tests), `-j` (JSON) |
| **When to use** | Assessing file-level change impact |
| **Output** | Affected files grouped by dependency depth, total count |

#### `diff-impact` — Git diff impact analysis

Analyze actual git changes to find which functions changed and their transitive callers.

```bash
codegraph diff-impact              # Unstaged changes vs HEAD
codegraph diff-impact --staged -T  # Staged changes, no tests
codegraph diff-impact main         # Current branch vs main
```

| | |
|---|---|
| **MCP tool** | `diff_impact` |
| **Key flags** | `--staged` (staged only), `--depth <n>` (default: 3), `-T` (no tests), `-j` (JSON) |
| **When to use** | Pre-commit verification, PR impact assessment |
| **Output** | Changed files, affected functions, affected files, summary |

### Overview Commands

#### `map` — Module overview

High-level view of the most-connected files in the codebase.

```bash
codegraph map --limit 20
```

| | |
|---|---|
| **MCP tool** | `module_map` |
| **Key flags** | `-n, --limit` (default: 20), `-T` (no tests), `-j` (JSON) |
| **When to use** | Orientation — understanding codebase structure at a glance |
| **Output** | Top N files ranked by connections, with in/out edge counts |

#### `stats` — Graph health

Show graph statistics: node/edge counts, languages, cycles, hotspots, embeddings status, and quality score.

```bash
codegraph stats
```

| | |
|---|---|
| **MCP tool** | (use via CLI) |
| **Key flags** | `-T` (no tests), `-j` (JSON) |
| **When to use** | Checking graph health, verifying build completeness |
| **Output** | Counts by kind, edge counts, language breakdown, quality score (0–100) |

#### `structure` — Directory tree with metrics

Project directory hierarchy with cohesion scores, fan-in/out, and symbol density per directory.

```bash
codegraph structure --depth 2 --sort cohesion
```

| | |
|---|---|
| **MCP tool** | `structure` |
| **Key flags** | `--depth <n>`, `--sort <metric>` (cohesion, fan-in, fan-out, density, files), `-T` (no tests), `-j` (JSON) |
| **When to use** | Understanding project layout and identifying well/poorly-cohesive modules |
| **Output** | Tree with per-directory metrics |

#### `hotspots` — Structural hotspots

Find files or directories with extreme fan-in, fan-out, or symbol density.

```bash
codegraph hotspots --metric coupling --limit 5
codegraph hotspots --level directory --metric fan-out
```

| | |
|---|---|
| **MCP tool** | `hotspots` |
| **Key flags** | `--metric` (fan-in, fan-out, density, coupling; default: fan-in), `--level` (file, directory), `-n, --limit` (default: 10), `-T` (no tests), `-j` (JSON) |
| **When to use** | Finding the most critical or problematic parts of the codebase |
| **Output** | Ranked list of files/directories by the chosen metric |

#### `cycles` — Circular dependency detection

Detect circular dependencies at file or function level.

```bash
codegraph cycles
codegraph cycles --functions
```

| | |
|---|---|
| **MCP tool** | `find_cycles` |
| **Key flags** | `--functions` (function-level instead of file-level), `-T` (no tests), `-j` (JSON) |
| **When to use** | Verifying no new cycles were introduced |
| **Output** | List of cycles, each shown as a chain of files/functions |

### Risk & Orchestration Commands

#### `audit` — Composite risk report

Combines explain + impact + complexity metrics in one call per function or file.

```bash
codegraph audit src/parser.js -T        # Audit all functions in a file
codegraph audit buildGraph -T           # Audit a single function
```

| | |
|---|---|
| **MCP tool** | `audit` |
| **Key flags** | `-T` (no tests), `-j` (JSON) |
| **When to use** | Getting everything needed to assess a function in one call instead of 3-4 |
| **Output** | Per-function: explain summary, impact (callers), complexity metrics |

#### `triage` — Risk-ranked audit queue

Merges connectivity, hotspots, node roles, and complexity into a single prioritized list.

```bash
codegraph triage -T --limit 20
```

| | |
|---|---|
| **MCP tool** | `triage` |
| **Key flags** | `--limit <n>`, `-T` (no tests), `-j` (JSON) |
| **When to use** | Building a priority queue of what to audit first |
| **Output** | Ranked list with role, complexity, fan-in/out, and risk score per function |

#### `batch` — Multi-target batch querying

Accept a list of targets and return all results in one JSON payload.

```bash
codegraph batch target1 target2 target3 -T --json
```

| | |
|---|---|
| **MCP tool** | `batch_query` |
| **Key flags** | `-T` (no tests), `-j` (JSON) |
| **When to use** | Multi-agent dispatch — one orchestrator call feeds N sub-agents |
| **Output** | Array of results, one per target |

#### `check` — CI validation predicates

Configurable pass/fail gates with exit code 0 (pass) or 1 (fail).

```bash
codegraph check --staged --no-new-cycles --max-complexity 30
codegraph check --staged --max-blast-radius 50 --no-boundary-violations
```

| | |
|---|---|
| **MCP tool** | `check` |
| **Key flags** | `--staged`, `--no-new-cycles`, `--max-complexity <n>`, `--max-blast-radius <n>`, `--no-boundary-violations`, `-T` (no tests) |
| **When to use** | CI gates, state machines, rollback triggers — anywhere you need a pass/fail signal |
| **Output** | Per-predicate pass/fail results; exit code 0 or 1 |

#### `owners` — CODEOWNERS integration

Map graph symbols to CODEOWNERS entries.

```bash
codegraph owners src/queries.js -T
codegraph owners --boundary -T         # Cross-team boundaries
```

| | |
|---|---|
| **MCP tool** | `code_owners` |
| **Key flags** | `--owner <name>`, `--boundary`, `-T` (no tests), `-j` (JSON) |
| **When to use** | Finding who owns code, identifying cross-team boundaries |
| **Output** | Owner mapping per function, boundary crossings |

#### `snapshot` — Graph DB backup and restore

```bash
codegraph snapshot save before-refactor
codegraph snapshot restore before-refactor
codegraph snapshot list
```

| | |
|---|---|
| **MCP tool** | (use via CLI) |
| **When to use** | Checkpointing before refactoring, instant rollback without rebuilding |

### Utility Commands

#### `build` — Build/update the graph

Parse the codebase and build (or incrementally update) the dependency graph.

```bash
codegraph build .                   # Incremental (default)
codegraph build . --no-incremental  # Full rebuild
```

| | |
|---|---|
| **MCP tool** | (use via CLI) |
| **Key flags** | `--no-incremental` (full rebuild) |
| **When to use** | Initial setup, or after major changes |

#### `embed` — Build semantic embeddings

Generate embeddings for all symbols. Required before `search` works.

```bash
codegraph embed .
codegraph embed . --model jina-code
```

| | |
|---|---|
| **MCP tool** | (use via CLI) |
| **Key flags** | `-m, --model` (minilm, jina-small, jina-base, jina-code, nomic, nomic-v1.5, bge-large) |
| **When to use** | Initial setup, or after adding many new functions |

#### `query` — Basic symbol query

Find a function/class and show its direct callers and callees.

```bash
codegraph query buildGraph
```

| | |
|---|---|
| **MCP tool** | `query_function` |
| **Key flags** | `-T` (no tests), `-j` (JSON) |
| **When to use** | Quick one-off lookup (prefer `fn` or `context` for richer data) |

#### `export` — Export graph

Export the dependency graph as DOT (Graphviz), Mermaid, or JSON.

```bash
codegraph export --format mermaid --functions -o graph.md
```

| | |
|---|---|
| **MCP tool** | `export_graph` |
| **Key flags** | `-f, --format` (dot, mermaid, json), `--functions` (function-level), `-T` (no tests), `-o, --output` (file) |
| **When to use** | Visualization, documentation, or external tool integration |

#### `list_functions` (MCP only)

List all functions/methods/classes, optionally filtered by file or name pattern.

| | |
|---|---|
| **MCP tool** | `list_functions` |
| **Key flags** | `file` (filter by file), `pattern` (filter by name), `no_tests` |
| **When to use** | Discovering available symbols in a file or matching a pattern |

#### `watch` — Incremental rebuilds

Watch for file changes and keep the graph up to date.

```bash
codegraph watch .
```

| | |
|---|---|
| **MCP tool** | (use via CLI) |
| **When to use** | Long-running development sessions |

#### `models` — List embedding models

Show available embedding models for `codegraph embed`.

```bash
codegraph models
```

| | |
|---|---|
| **MCP tool** | (use via CLI) |
| **When to use** | Choosing an embedding model before running `embed` |

#### `info` — Engine diagnostics

Show codegraph version, platform, engine availability (native vs WASM), and loaded grammars.

```bash
codegraph info
```

| | |
|---|---|
| **MCP tool** | (use via CLI) |
| **When to use** | Debugging parser or engine issues |

---

## MCP Server Reference

The MCP server exposes codegraph as tools that AI agents (Claude, Cursor, etc.) can call directly.

### Starting the Server

```bash
codegraph mcp                          # Single-repo (default)
codegraph mcp --multi-repo             # All registered repos
codegraph mcp --repos "myapp,lib"      # Restricted repo list
```

### Tool Mapping

| MCP Tool | CLI Equivalent | Description |
|----------|---------------|-------------|
| `query_function` | `query <name>` | Find callers and callees |
| `file_deps` | `deps <file>` | File imports and importers |
| `impact_analysis` | `impact <file>` | Transitive file-level impact |
| `find_cycles` | `cycles` | Circular dependency detection |
| `module_map` | `map` | Most-connected files overview |
| `fn_deps` | `fn <name>` | Function-level call chain |
| `fn_impact` | `fn-impact <name>` | Function-level blast radius |
| `symbol_path` | `path <from> <to>` | Shortest path between two symbols |
| `context` | `context <name>` | Full function context |
| `explain` | `explain <target>` | Structural summary |
| `where` | `where <name>` | Symbol definition and usage |
| `diff_impact` | `diff-impact [ref]` | Git diff impact analysis |
| `semantic_search` | `search <query>` | Natural language code search |
| `export_graph` | `export` | Graph export (DOT/Mermaid/JSON) |
| `list_functions` | *(MCP only)* | List/filter symbols |
| `structure` | `structure [dir]` | Directory tree with metrics |
| `hotspots` | `hotspots` | Structural hotspot detection |
| `node_roles` | `roles` | Node role classification |
| `co_changes` | `co-change` | Git co-change analysis |
| `execution_flow` | `flow` | Execution flow tracing |
| `list_entry_points` | `flow --entry-points` | Framework entry point detection |
| `complexity` | `complexity` | Per-function complexity metrics |
| `communities` | `communities` | Community detection & drift |
| `manifesto` | `manifesto` | Rule engine pass/fail |
| `code_owners` | `owners` | CODEOWNERS integration |
| `audit` | `audit <target>` | Composite risk report |
| `batch_query` | `batch <targets>` | Multi-target batch querying |
| `triage` | `triage` | Risk-ranked audit queue |
| `check` | `check` | CI validation predicates |
| `branch_compare` | `branch-compare` | Structural diff between refs |
| `list_repos` | `registry list` | List registered repos (multi-repo only) |

### Server Modes

- **Single-repo** (default): Tools operate on the local project only. No `repo` parameter. `list_repos` is not exposed.
- **Multi-repo** (`--multi-repo`): All tools gain an optional `repo` parameter. `list_repos` is exposed. Access to all registered repositories.
- **Restricted** (`--repos "a,b"`): Multi-repo mode limited to named repositories only.

### MCP Client Configuration

Add to your MCP client configuration (e.g., Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "npx",
      "args": ["@optave/codegraph", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

For multi-repo access:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "npx",
      "args": ["@optave/codegraph", "mcp", "--multi-repo"],
      "cwd": "/path/to/any/registered/project"
    }
  }
}
```

---

## Claude Code Hooks

Hooks automate codegraph integration so the agent gets structural context without asking for it.

### Overview

| Hook | Event | Purpose |
|------|-------|---------|
| `enrich-context.sh` | PreToolUse (Read, Grep) | Injects dependency info before file reads |
| `remind-codegraph.sh` | PreToolUse (Edit, Write) | Reminds agent to check context/impact before editing |
| `update-graph.sh` | PostToolUse (Edit, Write) | Rebuilds graph after code changes |
| `check-readme.sh` | PreToolUse (Bash) | Blocks commits when source changes may need doc updates |
| `guard-git.sh` | PreToolUse (Bash) | Blocks dangerous git ops, validates commits |
| `track-edits.sh` | PostToolUse (Edit, Write) | Logs edits for commit validation |

### `enrich-context.sh` — Auto-inject dependency context

**Trigger:** Before any Read or Grep operation.

**What it does:** Runs `codegraph deps <file> --json` and injects the result as `additionalContext`. The agent automatically sees what the file imports, what imports it, and what symbols it defines — without making a separate call.

**Example output the agent sees:**

```
[codegraph] src/builder.js
  Imports: src/parser.js, src/db.js, src/resolve.js, src/logger.js
  Imported by: src/cli.js, tests/integration/queries.test.js
  Defines: function buildGraph, function collectFiles, function hashFile
```

**Requirements:** `.codegraph/graph.db` must exist (run `codegraph build` first). Fails gracefully if missing.

### `remind-codegraph.sh` — Nudge the agent to check before editing

**Trigger:** Before any Edit or Write operation (PreToolUse).

**What it does:** The first time the agent edits a source file, the hook injects a reminder via `additionalContext` to run `where`, `explain`, `context`, and `fn-impact` before proceeding. Subsequent edits to the same file in the same session are silently allowed (tracked in `.claude/codegraph-checked.log`).

**Example output the agent sees:**

```
[codegraph reminder] You are about to edit src/parser.js. Did you run codegraph first?
Before editing, always: (1) where <name>, (2) explain src/parser.js,
(3) context <name> -T, (4) fn-impact <name> -T. If you already did this, proceed.
```

**Design:** Non-blocking (always allows the edit), skips non-source files (`.md`, `.json`, `.yml`, etc.), and only fires once per file per session to avoid noise. The checked log is gitignored.

### `update-graph.sh` — Keep the graph fresh

**Trigger:** After any Edit or Write operation.

**What it does:** Runs `codegraph build` incrementally. Only source files trigger a rebuild (`.js`, `.ts`, `.tsx`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.php`, `.rb`, `.tf`, `.hcl`). Test fixtures are skipped.

**Result:** The graph stays current as the agent edits code. Subsequent `context`, `fn-impact`, and `diff-impact` calls reflect the latest changes.

### `check-readme.sh` — Enforce doc updates alongside source changes

**Trigger:** Before any Bash command (PreToolUse).

**What it does:** Intercepts `git commit` commands and checks whether source files are staged (anything under `src/`, `cli.js`, `constants.js`, `parser.js`, `package.json`, or `grammars/`). If so, it verifies that `README.md`, `CLAUDE.md`, and `ROADMAP.md` are also staged. Missing docs trigger a `deny` decision listing which files weren't staged and what to review in each — language support tables, architecture docs, feature lists, roadmap phases, etc.

**Allows:** Commits that only touch non-source files (tests, docs, config) pass through without checks. Commits where all three docs are staged also pass through.

### `guard-git.sh` — Prevent unsafe git operations

**Trigger:** Before any Bash command.

**What it does:**
- **Blocks** broad staging (`git add .`, `git add -A`), resets, reverts, clean, and stash
- **Validates branches** on push (must match conventional prefix: `feat/`, `fix/`, `docs/`, etc.)
- **Validates commits** by comparing staged files against the session edit log — blocks commits that include files the agent didn't edit

**Allows:** `git restore --staged <file>` for safe unstaging.

### `track-edits.sh` — Session edit audit trail

**Trigger:** After any Edit or Write operation.

**What it does:** Appends the edited file path with a timestamp to `.claude/session-edits.log`. This log is read by `guard-git.sh` to validate commits.

### Full Settings Configuration

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Grep",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/enrich-context.sh"
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/remind-codegraph.sh"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/check-readme.sh"
          },
          {
            "type": "command",
            "command": "bash .claude/hooks/guard-git.sh"
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
            "command": "bash .claude/hooks/update-graph.sh"
          },
          {
            "type": "command",
            "command": "bash .claude/hooks/track-edits.sh"
          }
        ]
      }
    ]
  }
}
```

---

## CLAUDE.md Template

Add this to your project's `CLAUDE.md` to teach Claude Code about codegraph:

```markdown
## Codegraph

This project uses codegraph for dependency analysis. The graph is at `.codegraph/graph.db`.

### Before modifying code, always:
1. `codegraph where <name>` — find where the symbol lives
2. `codegraph explain <file-or-function>` — understand the structure
3. `codegraph context <name> -T` — get full context (source, deps, callers)
4. `codegraph fn-impact <name> -T` — check blast radius before editing

### After modifying code:
5. `codegraph diff-impact --staged -T` — verify impact before committing

### Commands
- `codegraph build .` — rebuild the graph (incremental by default)
- `codegraph map` — module overview
- `codegraph stats` — graph health and quality score
- `codegraph audit <target> -T` — combined explain + impact + health in one report
- `codegraph triage -T` — ranked audit priority queue
- `codegraph check --staged` — CI validation predicates (exit code 0/1)
- `codegraph batch target1 target2` — batch query multiple targets at once
- `codegraph fn <name> -T` — function call chain
- `codegraph deps <file>` — file-level dependencies
- `codegraph owners [target]` — CODEOWNERS mapping for symbols
- `codegraph snapshot save <name>` — checkpoint the graph DB before refactoring
- `codegraph search "<query>"` — semantic search (requires `codegraph embed`)
- `codegraph cycles` — check for circular dependencies

### Flags
- `-T` / `--no-tests` — exclude test files (use by default)
- `-j` / `--json` — JSON output for programmatic use
- `-f, --file <path>` — scope to a specific file
- `-k, --kind <kind>` — filter by symbol kind
```

---

## CI/CD Integration

### PR Impact Comments

Add a GitHub Actions workflow that posts `diff-impact` results on every PR:

```yaml
- name: Build graph
  run: npx @optave/codegraph build .

- name: Analyze PR impact
  run: |
    npx @optave/codegraph diff-impact origin/${{ github.base_ref }} --json -T > impact.json

- name: Comment on PR
  uses: actions/github-script@v7
  with:
    script: |
      const impact = require('./impact.json');
      const body = `### Codegraph Impact Analysis\n\n` +
        `**${impact.summary.changedFunctions} functions changed**, ` +
        `affecting **${impact.summary.totalAffected} functions** across ` +
        `**${impact.affectedFiles.length} files**`;
      github.rest.issues.createComment({
        issue_number: context.issue.number, owner: context.repo.owner,
        repo: context.repo.repo, body
      });
```

### Threshold Gates

Fail the build if impact exceeds a threshold:

```yaml
- name: Check impact threshold
  run: |
    AFFECTED=$(npx @optave/codegraph diff-impact origin/main --json -T | node -e "
      const d = require('fs').readFileSync('/dev/stdin','utf8');
      console.log(JSON.parse(d).summary.totalAffected);
    ")
    if [ "$AFFECTED" -gt 50 ]; then
      echo "::error::Impact too high: $AFFECTED functions affected (threshold: 50)"
      exit 1
    fi
```

### Graph Caching

Cache the graph database between CI runs:

```yaml
- uses: actions/cache@v4
  with:
    path: .codegraph/
    key: codegraph-${{ hashFiles('src/**', 'package.json') }}
    restore-keys: codegraph-
```

---

## Git Hooks

### Pre-commit: Rebuild Graph

Ensure the graph is current before every commit:

```bash
#!/bin/sh
# .git/hooks/pre-commit
npx @optave/codegraph build . 2>/dev/null
```

### Pre-push: Impact Check

Warn if changes have high impact:

```bash
#!/bin/sh
# .git/hooks/pre-push
IMPACT=$(npx @optave/codegraph diff-impact origin/main --json -T 2>/dev/null)
AFFECTED=$(echo "$IMPACT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>console.log(JSON.parse(d).summary?.totalAffected||0));
")
if [ "$AFFECTED" -gt 30 ]; then
  echo "Warning: pushing changes that affect $AFFECTED functions"
  echo "Run 'codegraph diff-impact origin/main -T' to review"
fi
```

### Commit Message Enrichment

Append impact summary to commit messages:

```bash
#!/bin/sh
# .git/hooks/prepare-commit-msg
IMPACT=$(npx @optave/codegraph diff-impact --staged --json -T 2>/dev/null)
if [ $? -eq 0 ]; then
  SUMMARY=$(echo "$IMPACT" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const j=JSON.parse(d);
      if(j.summary) console.log('Impact: '+j.summary.changedFunctions+' changed, '+j.summary.totalAffected+' affected');
    });
  ")
  if [ -n "$SUMMARY" ]; then
    echo "" >> "$1"
    echo "$SUMMARY" >> "$1"
  fi
fi
```

---

## Quick Reference Cheat Sheet

### "I want to..." Table

| I want to... | Command |
|---------------|---------|
| Find where a function is defined | `codegraph where <name>` |
| See what a file does | `codegraph explain <file>` |
| Understand a function fully | `codegraph context <name> -T` |
| See what calls a function | `codegraph fn <name> -T` |
| See what a function calls | `codegraph fn <name> -T` |
| Check impact before editing | `codegraph fn-impact <name> -T` |
| Check impact of staged changes | `codegraph diff-impact --staged -T` |
| Compare branch impact vs main | `codegraph diff-impact main -T` |
| Find code by description | `codegraph search "description"` |
| Get a codebase overview | `codegraph map` |
| Check graph health | `codegraph stats` |
| Find circular dependencies | `codegraph cycles` |
| Find hotspots | `codegraph hotspots --metric coupling` |
| See project structure | `codegraph structure --depth 2` |
| List symbols in a file | `codegraph where --file <path>` |
| Get a full risk report for a function | `codegraph audit <name> -T` |
| Get a ranked list of riskiest functions | `codegraph triage -T --limit 20` |
| Batch query multiple targets at once | `codegraph batch t1 t2 t3 -T --json` |
| Validate staged changes pass CI rules | `codegraph check --staged --no-new-cycles` |
| Find who owns a piece of code | `codegraph owners <target>` |
| Checkpoint the graph before refactoring | `codegraph snapshot save <name>` |
| Restore graph after failed refactoring | `codegraph snapshot restore <name>` |
| Compare structure between branches | `codegraph branch-compare main HEAD -T` |
| Export graph for visualization | `codegraph export --format mermaid` |
| Build/update the graph | `codegraph build .` |
| Build semantic embeddings | `codegraph embed .` |
| List embedding models | `codegraph models` |
| Check engine/parser status | `codegraph info` |

### Common Flags

| Flag | Short | Description | Available on |
|------|-------|-------------|-------------|
| `--no-tests` | `-T` | Exclude test/spec files | All query commands (fn, fn-impact, context, explain, where, diff-impact, search, map, deps, impact, query, stats, hotspots, cycles, export, structure, audit, triage, check, batch, owners, branch-compare) |
| `--json` | `-j` | JSON output | Most commands |
| `--file <path>` | `-f` | Scope to a file | fn, fn-impact, context, where |
| `--kind <kind>` | `-k` | Filter by symbol kind | fn, fn-impact, context |
| `--depth <n>` | | Traversal depth | fn (3), fn-impact (5), context (0), diff-impact (3) |
| `--db <path>` | `-d` | Custom database path | Most commands |

### Symbol Kinds

`function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module`

---

## Tips for Agents

1. **Always use `-T` / `--no-tests`** unless you're specifically working on tests. Test files add noise to impact and context results.

2. **Prefer `context` over raw file reads.** One `context` call replaces 3–5 file reads and gives you structured, relevant data.

3. **Use `--file` to disambiguate.** Many codebases have functions with the same name in different files. `codegraph fn parse --file parser.js` avoids ambiguity.

4. **Check impact before and after.** Run `fn-impact` before editing to know the blast radius. Run `diff-impact --staged` after to verify your changes.

5. **Use `explain` for orientation, `context` for implementation.** `explain` gives you the shape of the code. `context` gives you the actual source you need to write changes.

6. **Multi-query semantic search.** When searching, phrase the same intent multiple ways: `codegraph search "parse imports, resolve require, extract dependencies"`. RRF ranking combines the results.

7. **Use `where --file` for file inventory.** Before editing a file, `where --file <path>` gives you a quick list of all symbols, imports, and exports — cheaper than reading the file.

8. **Check `stats` for quality.** The quality score (0–100) tells you if the graph is trustworthy. Low scores mean missing edges or unresolved imports — rebuild or investigate.

9. **Scope with `--kind`.** If you only care about classes, `--kind class` filters out functions and methods. Valid kinds: function, method, class, interface, type, struct, enum, trait, record, module.

10. **JSON for programmatic use.** When chaining commands or processing results, always use `-j` for reliable machine-readable output.
