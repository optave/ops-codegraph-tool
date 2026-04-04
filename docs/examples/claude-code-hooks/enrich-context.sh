#!/usr/bin/env bash
# enrich-context.sh — PreToolUse hook for Read and Grep tools
# Provides dependency context from codegraph when reading/searching files.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract file path and convert to relative — all in node to avoid
# bash backslash issues on Windows/Git Bash
REL_PATH=$(printf '%s' "$INPUT" | CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}" node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const o=JSON.parse(d).tool_input||{};
    let p=(o.file_path||o.path||'').replace(/\\\\/g,'/');
    if(!p)return;
    let dir=(process.env.CLAUDE_PROJECT_DIR||'.').replace(/\\\\/g,'/');
    if(p.startsWith(dir))p=p.slice(dir.length+1);
    process.stdout.write(p);
  });
" 2>/dev/null) || true

# Guard: no file path found
if [ -z "$REL_PATH" ]; then
  exit 0
fi

# Guard: codegraph DB must exist
# Use git worktree root so each worktree reads its own DB (avoids WAL contention)
WORK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || WORK_ROOT="${CLAUDE_PROJECT_DIR:-.}"
DB_PATH="$WORK_ROOT/.codegraph/graph.db"
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Run codegraph deps and capture output
DEPS=""
if command -v codegraph &>/dev/null; then
  DEPS=$(codegraph deps "$REL_PATH" --json -d "$DB_PATH" 2>/dev/null) || true
else
  DEPS=$(npx --yes @optave/codegraph deps "$REL_PATH" --json -d "$DB_PATH" 2>/dev/null) || true
fi

# Guard: no output or error
if [ -z "$DEPS" ] || [ "$DEPS" = "null" ]; then
  exit 0
fi

# Output as additionalContext so it surfaces in Claude's context
printf '%s' "$DEPS" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const o=JSON.parse(d);
      const r=o.results?.[0]||{};
      const imports=(r.imports||[]).map(i=>i.file).join(', ');
      const importedBy=(r.importedBy||[]).map(i=>i.file).join(', ');
      const defs=(r.definitions||[]).map(d=>d.kind+' '+d.name).join(', ');
      const file=o.file||'unknown';
      let ctx='[codegraph] '+file;
      if(imports)ctx+='\n  Imports: '+imports;
      if(importedBy)ctx+='\n  Imported by: '+importedBy;
      if(defs)ctx+='\n  Defines: '+defs;
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: ctx
        }
      }));
    } catch(e) {}
  });
" 2>/dev/null || true

exit 0
