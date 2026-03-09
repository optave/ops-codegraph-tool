#!/usr/bin/env bash
# warn-signature-changes.sh — PreToolUse hook for Bash (git commit)
# Warns when staged changes modify function signatures, highlighting risk
# level based on the symbol's role (core > utility > others).
# Informational only — never blocks.

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

# Run check --staged to get signature violations, then enrich with role + caller count
WARNING=$(echo "" | node --input-type=module -e "
  import path from 'path';
  const workRoot = process.argv[2];
  const { checkData } = await import(path.join(workRoot, 'src/check.js'));
  const { openReadonlyOrFail } = await import(path.join(workRoot, 'src/db.js'));

  const result = checkData(undefined, { staged: true, noTests: true });
  if (!result || result.error) process.exit(0);

  const sigPred = (result.predicates || []).find(p => p.name === 'signatures');
  if (!sigPred || sigPred.passed || !sigPred.violations.length) process.exit(0);

  const db = openReadonlyOrFail();
  const lines = [];

  for (const v of sigPred.violations) {
    // Get role from DB
    const node = db.prepare(
      'SELECT role FROM nodes WHERE name = ? AND file = ? AND line = ?'
    ).get(v.name, v.file, v.line);
    const role = node?.role || 'unknown';

    // Count transitive callers (BFS, depth 3)
    const defNode = db.prepare(
      'SELECT id FROM nodes WHERE name = ? AND file = ? AND line = ?'
    ).get(v.name, v.file, v.line);

    let callerCount = 0;
    if (defNode) {
      const visited = new Set([defNode.id]);
      let frontier = [defNode.id];
      for (let d = 0; d < 3; d++) {
        const next = [];
        for (const fid of frontier) {
          const callers = db.prepare(
            'SELECT DISTINCT n.id FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ? AND e.kind = \\'calls\\''
          ).all(fid);
          for (const c of callers) {
            if (!visited.has(c.id)) {
              visited.add(c.id);
              next.push(c.id);
              callerCount++;
            }
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }
    }

    const risk = role === 'core' ? 'HIGH' : role === 'utility' ? 'MEDIUM' : 'low';
    lines.push(risk + ': ' + v.name + ' (' + v.kind + ') [' + role + '] at ' + v.file + ':' + v.line + ' — ' + callerCount + ' transitive callers');
  }

  db.close();

  if (lines.length > 0) {
    process.stdout.write(lines.join('\\n'));
  }
" -- "$WORK_ROOT" 2>/dev/null) || true

if [ -z "$WARNING" ]; then
  exit 0
fi

# Escape for JSON
ESCAPED=$(printf '%s' "$WARNING" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));
" 2>/dev/null) || true

if [ -z "$ESCAPED" ]; then
  exit 0
fi

# Inject as additionalContext — informational, never blocks
node -e "
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: '[codegraph] Signature changes detected in staged files:\\n' + JSON.parse(process.argv[1])
    }
  }));
" "$ESCAPED" 2>/dev/null || true

exit 0
