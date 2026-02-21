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

### MCP server

Start the MCP server so AI assistants can query your graph:

```bash
codegraph mcp
```

The server exposes tools for `query_function`, `file_deps`, `impact_analysis`, `find_cycles`, and `module_map`.

### CLAUDE.md for your project

Add this to your project's `CLAUDE.md` so AI agents know codegraph is available:

```markdown
## Code Navigation

This project uses codegraph. The database is at `.codegraph/graph.db`.

- **Before modifying a function**: `codegraph fn <name> --no-tests`
- **Before modifying a file**: `codegraph deps <file>`
- **To assess PR impact**: `codegraph diff-impact --no-tests`
- **To find entry points**: `codegraph map`
- **To trace breakage**: `codegraph fn-impact <name> --no-tests`

Rebuild after major structural changes: `codegraph build`
```

### Claude Code hooks

You can configure [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to automatically rebuild the graph after file edits:

```json
// .claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "codegraph build --incremental"
      }
    ]
  }
}
```

This ensures the graph stays fresh as the AI agent modifies files.

---

## Developer Workflow

### Watch mode during development

Keep the graph updating in the background while you code:

```bash
codegraph watch
```

Changes are picked up incrementally — no manual rebuilds needed.

### Explore before you edit

Before touching a function, check its blast radius:

```bash
codegraph fn myFunction --no-tests      # callers, callees, call chain
codegraph fn-impact myFunction --no-tests  # what breaks if this changes
```

Before touching a file:

```bash
codegraph deps src/utils/auth.ts         # imports and importers
codegraph impact src/utils/auth.ts       # transitive reverse deps
```

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
codegraph embed --model nomic            # ~137 MB, best quality
```

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

# 6. (Optional) Build embeddings for semantic search
codegraph embed

# 7. (Optional) Add CLAUDE.md for AI agents
# See the AI Agent Integration section above
```
