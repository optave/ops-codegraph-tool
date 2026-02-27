#!/usr/bin/env bash
# track-moves.sh — PostToolUse hook for Bash tool calls
# Detects mv/git mv/cp commands and logs all affected paths
# (both source and destination) to .claude/session-edits.log so that
# guard-git.sh can validate commits that include moved/copied files.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

INPUT=$(cat)

# Extract the command from tool_input JSON
COMMAND=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).tool_input?.command||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only care about mv / git mv / cp commands
if ! echo "$COMMAND" | grep -qE '(^|\s|&&\s*)(mv|git\s+mv|cp)\s+'; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"

# Use node to parse the command and extract all file paths involved
PATHS=$(echo "$COMMAND" | node -e "
  const path = require('path');
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    const base = path.resolve(process.argv[1]);
    const results = new Set();

    // Split on && or ; to handle chained commands
    const parts = d.split(/\s*(?:&&|;)\s*/);

    for (const part of parts) {
      // Match: mv / cp / git mv followed by arguments
      const m = part.match(/(?:git\s+mv|mv|cp)\s+(.+)/);
      if (!m) continue;

      // Simple arg splitting that respects quotes
      const raw = m[1];
      const args = [];
      let cur = '';
      let q = null;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (q)        { if (c === q) q = null; else cur += c; }
        else if (c === '\"' || c === \"'\") { q = c; }
        else if (c === ' ' || c === '\\t') { if (cur) { args.push(cur); cur = ''; } }
        else          { cur += c; }
      }
      if (cur) args.push(cur);

      // Filter out flags (-f, -v, --force, etc.)
      const paths = args.filter(a => !a.startsWith('-'));

      // Resolve each path relative to project root
      for (const p of paths) {
        const abs = path.resolve(p);
        const rel = path.relative(base, abs).split(path.sep).join('/');
        if (!rel.startsWith('..')) results.add(rel);
      }
    }

    process.stdout.write([...results].join('\\n'));
  });
" "$PROJECT_DIR" 2>/dev/null) || true

if [ -z "$PATHS" ]; then
  exit 0
fi

# Append timestamped entries for every affected path
mkdir -p "$(dirname "$LOG_FILE")"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
while IFS= read -r rel_path; do
  if [ -n "$rel_path" ]; then
    echo "$TS $rel_path" >> "$LOG_FILE"
  fi
done <<< "$PATHS"

exit 0
