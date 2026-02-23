#!/usr/bin/env bash
# enrich-context.sh — PreToolUse hook for Read and Grep tools
# Provides dependency context from codegraph when reading/searching files.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract file path based on tool type
# Read tool uses tool_input.file_path, Grep uses tool_input.path
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const o=JSON.parse(d).tool_input||{};
    const p=o.file_path||o.path||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

# Guard: no file path found
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Guard: codegraph DB must exist
DB_PATH="${CLAUDE_PROJECT_DIR:-.}/.codegraph/graph.db"
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Guard: codegraph must be available
if ! command -v codegraph &>/dev/null && ! command -v npx &>/dev/null; then
  exit 0
fi

# Convert absolute path to relative (strip project dir prefix)
REL_PATH="$FILE_PATH"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
if [[ "$FILE_PATH" == "${PROJECT_DIR}"* ]]; then
  REL_PATH="${FILE_PATH#"${PROJECT_DIR}"/}"
fi
# Normalize backslashes to forward slashes (Windows compatibility)
REL_PATH="${REL_PATH//\\//}"

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

# Output as informational context (never deny)
echo "$DEPS" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const o=JSON.parse(d);
      const r=o.results?.[0]||{};
      const imports=(r.imports||[]).length;
      const importedBy=(r.importedBy||[]).length;
      const defs=(r.definitions||[]).length;
      const file=o.file||'unknown';
      console.log(JSON.stringify({
        hookSpecificOutput: 'Codegraph context for '+file+':\\n  Imports: '+imports+' files\\n  Imported by: '+importedBy+' files\\n  Definitions: '+defs+' symbols'
      }));
    } catch(e) {}
  });
" 2>/dev/null || true

exit 0
