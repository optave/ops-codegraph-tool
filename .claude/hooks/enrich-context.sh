#!/usr/bin/env bash
# enrich-context.sh — PreToolUse hook for Read and Grep tools
# Provides dependency context from codegraph when reading/searching files.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract file path based on tool type
# Read tool uses tool_input.file_path, Grep uses tool_input.path
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)

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
if [[ "$FILE_PATH" == "${CLAUDE_PROJECT_DIR}"* ]]; then
  REL_PATH="${FILE_PATH#"${CLAUDE_PROJECT_DIR}"/}"
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
echo "$DEPS" | jq -c '{
  hookSpecificOutput: (
    "Codegraph context for " + (.file // "unknown") + ":\n" +
    "  Imports: " + ((.results[0].imports // []) | length | tostring) + " files\n" +
    "  Imported by: " + ((.results[0].importedBy // []) | length | tostring) + " files\n" +
    "  Definitions: " + ((.results[0].definitions // []) | length | tostring) + " symbols"
  )
}' 2>/dev/null || true

exit 0
