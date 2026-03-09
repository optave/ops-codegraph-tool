#!/usr/bin/env bash
# check-commit.sh — PreToolUse hook for Bash (git commit)
# Combined cycle-detection (blocking) + signature-change warning (informational).
# Runs checkData() ONCE with both predicates, single DB connection.

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

# Load session edit log for cycle scoping
LOG_FILE="$WORK_ROOT/.claude/session-edits.log"
EDITED_FILES=""
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)
fi

# Single Node.js invocation: run checkData once, process both predicates
RESULT=$(node -e "
  const path = require('path');
  const root = process.argv[1];
  const editedRaw = process.argv[2] || '';

  const { checkData } = require(path.join(root, 'src/check.js'));
  const { openReadonlyOrFail } = require(path.join(root, 'src/db.js'));

  // Run check with cycles + signatures only (skip boundaries for speed)
  const data = checkData(undefined, {
    staged: true,
    noTests: true,
    boundaries: false,
  });

  if (!data || data.error || !data.predicates) process.exit(0);

  const output = { action: 'allow' };

  // ── Cycle check (blocking) ──
  const cyclesPred = data.predicates.find(p => p.name === 'cycles');
  if (cyclesPred && !cyclesPred.passed && cyclesPred.cycles?.length) {
    const edited = new Set(editedRaw.split('\n').filter(Boolean));
    // Only block if cycles involve files edited in this session
    if (edited.size > 0) {
      const relevant = cyclesPred.cycles.filter(
        cycle => cycle.some(f => edited.has(f))
      );
      if (relevant.length > 0) {
        const summary = relevant.slice(0, 5).map(c => c.join(' -> ')).join('\n  ');
        const extra = relevant.length > 5 ? '\n  ... and ' + (relevant.length - 5) + ' more' : '';
        output.action = 'deny';
        output.reason = 'BLOCKED: Circular dependencies detected involving files you edited:\n  ' + summary + extra + '\nFix the cycles before committing.';
      }
    }
  }

  // ── Signature warning (informational, never blocks) ──
  const sigPred = data.predicates.find(p => p.name === 'signatures');
  if (sigPred && !sigPred.passed && sigPred.violations?.length) {
    // Enrich with role + transitive caller count using a single DB connection
    const db = openReadonlyOrFail();
    const stmtNode = db.prepare(
      'SELECT id, role FROM nodes WHERE name = ? AND file = ? AND line = ?'
    );
    const stmtCallers = db.prepare(
      'SELECT DISTINCT n.id FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ? AND e.kind = \\'calls\\''
    );

    const lines = [];
    for (const v of sigPred.violations) {
      const node = stmtNode.get(v.name, v.file, v.line);
      const role = node?.role || 'unknown';

      let callerCount = 0;
      if (node) {
        const visited = new Set([node.id]);
        let frontier = [node.id];
        for (let d = 0; d < 3; d++) {
          const next = [];
          for (const fid of frontier) {
            for (const c of stmtCallers.all(fid)) {
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
      output.sigWarning = lines.join('\n');
    }
  }

  process.stdout.write(JSON.stringify(output));
" "$WORK_ROOT" "$EDITED_FILES" 2>/dev/null) || true

if [ -z "$RESULT" ]; then
  exit 0
fi

ACTION=$(echo "$RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).action||'allow')}catch{process.stdout.write('allow')}})" 2>/dev/null) || ACTION="allow"

if [ "$ACTION" = "deny" ]; then
  REASON=$(echo "$RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).reason||'')}catch{}})" 2>/dev/null) || true
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: process.argv[1]
      }
    }));
  " "$REASON"
  exit 0
fi

# Signature warning (non-blocking)
SIG_WARNING=$(echo "$RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const w=JSON.parse(d).sigWarning;if(w)process.stdout.write(w)}catch{}})" 2>/dev/null) || true

if [ -n "$SIG_WARNING" ]; then
  ESCAPED=$(printf '%s' "$SIG_WARNING" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)))" 2>/dev/null) || true
  if [ -n "$ESCAPED" ]; then
    node -e "
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: '[codegraph] Signature changes detected in staged files:\\n' + JSON.parse(process.argv[1])
        }
      }));
    " "$ESCAPED" 2>/dev/null || true
  fi
fi

exit 0
