#!/usr/bin/env bash
# check-dead-exports.sh — PreToolUse hook for Bash (git commit)
# Blocks commits if any src/ file edited in THIS SESSION has exports with zero consumers.
# Batches all files in a single Node.js invocation (one DB open) for speed.

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

# Only trigger on git commit commands
if ! echo "$COMMAND" | grep -qE '(^|\s|&&\s*)git\s+commit\b'; then
  exit 0
fi

# Guard: codegraph DB must exist
WORK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || WORK_ROOT="${CLAUDE_PROJECT_DIR:-.}"
if [ ! -f "$WORK_ROOT/.codegraph/graph.db" ]; then
  exit 0
fi

# Guard: must have staged changes
STAGED=$(git diff --cached --name-only 2>/dev/null) || true
if [ -z "$STAGED" ]; then
  exit 0
fi

# Load session edit log to scope checks to files we actually edited
LOG_FILE="$WORK_ROOT/.claude/session-edits.log"
if [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; then
  exit 0
fi
EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)

# Filter staged files to src/*.js that were edited in this session
FILES_TO_CHECK=""
while IFS= read -r file; do
  if ! echo "$file" | grep -qE '^src/.*\.(js|ts|tsx)$'; then
    continue
  fi
  if echo "$EDITED_FILES" | grep -qxF "$file"; then
    FILES_TO_CHECK="${FILES_TO_CHECK:+$FILES_TO_CHECK
}$file"
  fi
done <<< "$STAGED"

if [ -z "$FILES_TO_CHECK" ]; then
  exit 0
fi

# Single Node.js invocation: check all files in one process
# Excludes exports that are re-exported from index.js (public API) or consumed
# via dynamic import() — codegraph's static graph doesn't track those edges.
DEAD_EXPORTS=$(node --input-type=module -e "
  import fs from 'node:fs';
  import path from 'node:path';
  const root = process.argv[2];
  const files = process.argv[3].split('\n').filter(Boolean);

  const { pathToFileURL } = await import('node:url');
  const fileUrl = pathToFileURL(path.join(root, 'src/queries.js')).href;
  const { exportsData } = await import(fileUrl);

  // Build set of names exported from index.js (public API surface)
  const indexSrc = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  const publicAPI = new Set();
  // Match: export { foo, bar as baz } from '...'
  for (const m of indexSrc.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) publicAPI.add(name);
    }
  }
  // Match: export default ...
  if (/export\s+default\b/.test(indexSrc)) publicAPI.add('default');

  // Scan all src/ files for dynamic import() consumers
  const srcDir = path.join(root, 'src');
  function scanDynamic(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) { scanDynamic(path.join(dir, ent.name)); continue; }
      if (!ent.name.endsWith('.js')) continue;
      try {
        const src = fs.readFileSync(path.join(dir, ent.name), 'utf8');
        // Multi-line-safe: match const { ... } = [await] import('...')
        for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*(?:await\s+)?import\s*\([\u0022']/gs)) {
          for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim().split('\n').pop().trim();
            if (name && /^\w+$/.test(name)) publicAPI.add(name);
          }
        }
        // Also match single-binding: const X = [await] import('...')  (default import)
        for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:await\s+)?import\s*\([\u0022']/g)) {
          publicAPI.add(m[1]);
        }
      } catch {}
    }
  }
  scanDynamic(srcDir);

  const dead = [];
  for (const file of files) {
    try {
      const data = exportsData(file, undefined, { noTests: true, unused: true });
      if (data && data.results) {
        for (const r of data.results) {
          if (publicAPI.has(r.name)) continue; // public API or dynamic import consumer
          dead.push(r.name + ' (' + data.file + ':' + r.line + ')');
        }
      }
    } catch {}
  }

  if (dead.length > 0) {
    process.stdout.write(dead.join(', '));
  }
" "$WORK_ROOT" "$FILES_TO_CHECK" 2>/dev/null) || true

if [ -n "$DEAD_EXPORTS" ]; then
  REASON="BLOCKED: Dead exports (zero consumers) detected in files you edited: $DEAD_EXPORTS. Either add consumers, remove the exports, or verify these are intentionally public API."

  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: process.argv[2]
      }
    }));
  " "$REASON"
  exit 0
fi

exit 0
