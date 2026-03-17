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
DB_PATH="${CLAUDE_PROJECT_DIR:-.}/.codegraph/graph.db"
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Guard: codegraph must be available
if ! command -v codegraph &>/dev/null && ! command -v npx &>/dev/null; then
  exit 0
fi

# Run codegraph brief and capture output (silent no-op on older installs without the brief command)
BRIEF=""
if command -v codegraph &>/dev/null; then
  BRIEF=$(codegraph brief "$REL_PATH" --json -d "$DB_PATH" 2>/dev/null) || true
else
  BRIEF=$(npx --yes @optave/codegraph brief "$REL_PATH" --json -d "$DB_PATH" 2>/dev/null) || true
fi

# Guard: no output or error
if [ -z "$BRIEF" ] || [ "$BRIEF" = "null" ]; then
  exit 0
fi

# Output as additionalContext so it surfaces in Claude's context
printf '%s' "$BRIEF" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const o=JSON.parse(d);
      const r=o.results?.[0]||{};
      const file=r.file||o.file||'unknown';
      const risk=r.risk||'unknown';
      const imports=(r.imports||[]).join(', ');
      const importedBy=(r.importedBy||[]).join(', ');
      const transitive=r.totalImporterCount||0;
      const direct=(r.importedBy||[]).length;
      const extra=transitive-direct;
      const syms=(r.symbols||[]).map(s=>{
        const tags=[];
        if(s.role)tags.push(s.role);
        tags.push(s.callerCount+' caller'+(s.callerCount!==1?'s':''));
        return s.name+' ['+tags.join(', ')+']';
      }).join(', ');
      let ctx='[codegraph] '+file+' ['+risk.toUpperCase()+' RISK]';
      if(syms)ctx+='\n  Symbols: '+syms;
      if(imports)ctx+='\n  Imports: '+imports;
      if(importedBy){
        const suffix=extra>0?' (+'+extra+' transitive)':'';
        ctx+='\n  Imported by: '+importedBy+suffix;
      }
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
