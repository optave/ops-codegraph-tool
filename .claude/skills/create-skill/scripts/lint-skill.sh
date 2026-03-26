#!/usr/bin/env bash
# lint-skill.sh — Static analysis for SKILL.md files
# Catches the most common issues found in 250+ Greptile review comments.
# Exit 0 = warnings only, Exit 1 = errors found.

set -euo pipefail

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "lint-skill.sh requires bash 4+ (for associative arrays). On macOS: brew install bash" >&2
  exit 1
fi

SKILL_FILE="${1:?Usage: lint-skill.sh <path-to-SKILL.md>}"

if [ ! -f "$SKILL_FILE" ]; then
  echo "ERROR: File not found: $SKILL_FILE"
  exit 1
fi

ERRORS=0
WARNINGS=0

error() { echo "ERROR: $1"; ERRORS=$((ERRORS + 1)); }
warn()  { echo "WARN:  $1"; WARNINGS=$((WARNINGS + 1)); }

# ── Check 1: Cross-fence variable usage ──────────────────────────────
# Extract bash blocks (skip quadruple-backtick example regions) and check
# if UPPER_CASE variables assigned in one block are referenced in a later
# block without file-based persistence.
BLOCKS_FILE=$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX.blocks")
trap 'rm -f "$BLOCKS_FILE"' EXIT

# Extract bash blocks with block index, skipping those inside ```` regions.
# Patterns use ^\s* to match indented blocks (e.g. inside Markdown list items).
awk '
  /^\s*````/       { quad = !quad; next }
  quad              { next }
  /^\s*```bash/    { inblock = 1; blocknum++; next }
  /^\s*```/ && inblock { inblock = 0; next }
  inblock          { print blocknum "\t" $0 }
' "$SKILL_FILE" > "$BLOCKS_FILE"

# Collect variable assignments per block and build reassignment lookup (O(1) per check)
declare -A VAR_BLOCK
declare -A REASSIGNED
while IFS=$'\t' read -r bnum line; do
  # Match UPPER_CASE_VAR= assignments (skip lowercase/mixed to reduce false positives)
  for var in $(echo "$line" | grep -oE '\b[A-Z][A-Z0-9_]+=' | sed 's/=$//'); do
    if [ -z "${VAR_BLOCK[$var]+x}" ]; then
      VAR_BLOCK["$var"]="$bnum"
    else
      # Track re-assignments in later blocks for O(1) lookup
      REASSIGNED["${var}:${bnum}"]=1
    fi
  done
done < "$BLOCKS_FILE"

# Check for references in later blocks without file persistence
while IFS=$'\t' read -r bnum line; do
  for var in "${!VAR_BLOCK[@]}"; do
    assigned_in="${VAR_BLOCK[$var]}"
    if [ "$bnum" -gt "$assigned_in" ]; then
      # Check if this line references the variable ($VAR or ${VAR})
      if echo "$line" | grep -qE '\$'"${var}"'([^A-Za-z0-9_]|$)' \
          || echo "$line" | grep -qF "\${${var}}"; then
        # Check if the same block also assigns it (re-assignment is fine) — O(1) lookup
        if [ -z "${REASSIGNED[${var}:${bnum}]+x}" ]; then
          # Check it's not read from a file (cat, $(...) with cat/read)
          if ! echo "$line" | grep -qE 'cat |read |< |<"|\$\(<'; then
            error "Cross-fence variable: \$$var assigned in bash block $assigned_in, referenced in block $bnum without file persistence (Pattern 1)"
          fi
        fi
      fi
    fi
  done
done < "$BLOCKS_FILE"

# ── Check 2: Bare 2>/dev/null without justification ─────────────────
line_num=0
in_quad=false
in_block=false
prev_line=""
while IFS= read -r line; do
  line_num=$((line_num + 1))
  stripped="${line#"${line%%[! ]*}"}"
  case "$stripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; prev_line="$line"; continue ;;
  esac
  $in_quad && { prev_line="$line"; continue; }
  case "$stripped" in
    '```bash'*) in_block=true; prev_line="$line"; continue ;;
    '```'*) in_block=false; prev_line="$line"; continue ;;
  esac
  if $in_block && echo "$line" | grep -qE '2>/dev/null|>[ ]?/dev/null 2>&1'; then
    # Check same line or previous line for justification comment
    justification_re='#.*intentional|#.*tolera|#.*acceptable|#.*expected|#.*safe to ignore|#.*may fail|#.*optional|#.*fallback|#.*portable|#.*suppress|#.*provid'
    if ! echo "${prev_line}${line}" | grep -qiE "$justification_re"; then
      warn "Line $line_num: '2>/dev/null' without justification comment (Pattern 2)"
    fi
  fi
  prev_line="$line"
done < "$SKILL_FILE"

# ── Check 3: git add . or git add -A (inside bash blocks only) ───────
while IFS=$'\t' read -r bnum line; do
  if echo "$line" | grep -qE '^\s*git add (\.|(-A|--all))'; then
    error "bash block $bnum: 'git add .' or 'git add -A' — stage named files only"
  fi
done < "$BLOCKS_FILE"

# ── Check 4: Hardcoded npm test / npm run lint ───────────────────────
# Only flag if not inside an if/elif detection block
line_num=0
in_quad=false
in_block=false
in_detect=false
detect_depth=0
while IFS= read -r line; do
  line_num=$((line_num + 1))
  stripped="${line#"${line%%[! ]*}"}"
  case "$stripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; continue ;;
  esac
  $in_quad && continue
  case "$stripped" in
    '```bash'*) in_block=true; in_detect=false; detect_depth=0; continue ;;
    '```'*) in_block=false; in_detect=false; detect_depth=0; continue ;;
  esac
  if $in_block; then
    # Track if we're inside an if/elif chain (detection block) with depth.
    # Only `if` increments depth; `elif` is a sibling branch of the same if-statement,
    # not a new nesting level, so it sets in_detect but does NOT increment depth.
    if echo "$line" | grep -qE '^\s*if\s.*(-f\s|-d\s|lock|package|command -v|which\s)'; then
      in_detect=true
      detect_depth=$((detect_depth + 1))
    elif echo "$line" | grep -qE '^\s*elif\s.*(-f\s|-d\s|lock|package|command -v|which\s)'; then
      # elif is a sibling branch — set in_detect but do NOT increment depth
      in_detect=true
    elif echo "$line" | grep -qE '^\s*if\b'; then
      # nested if (not a detection block) — track depth only when inside detection
      [ "$in_detect" = true ] && detect_depth=$((detect_depth + 1))
    elif echo "$line" | grep -qE '^\s*fi\b'; then
      if [ "$detect_depth" -gt 0 ]; then
        detect_depth=$((detect_depth - 1))
        [ "$detect_depth" -eq 0 ] && in_detect=false
      else
        # Safety reset: in_detect was set by an elif without a preceding detection if
        in_detect=false
      fi
    fi
    if ! $in_detect; then
      if echo "$line" | grep -qE '^\s*(npm test|npm run test|npm run lint)\b'; then
        warn "Line $line_num: Hardcoded '$(echo "$line" | sed 's/^[[:space:]]*//')' — detect package manager first (Pattern 6)"
      fi
    fi
  fi
done < "$SKILL_FILE"

# ── Check 5: sed -i without .bak (inside bash blocks only) ──────────
while IFS=$'\t' read -r bnum line; do
  if echo "$line" | grep -qE "sed\s+-i\s*(''|\"|[^.])"; then
    warn "bash block $bnum: 'sed -i' without .bak extension — GNU/BSD incompatibility (Pattern 13)"
  fi
done < "$BLOCKS_FILE"

# ── Check 6: Missing frontmatter fields ─────────────────────────────
for field in name description argument-hint allowed-tools; do
  if ! head -20 "$SKILL_FILE" | grep -qE "^${field}:"; then
    error "Missing frontmatter field: '$field'"
  fi
done

# ── Check 7: Missing Phase 0 ────────────────────────────────────────
if ! grep -qE '^## Phase 0' "$SKILL_FILE"; then
  error "Missing '## Phase 0' heading — every skill needs pre-flight checks"
fi

# ── Check 8: Missing Rules section ───────────────────────────────────
if ! grep -qE '^## Rules' "$SKILL_FILE"; then
  error "Missing '## Rules' section"
fi

# ── Check 9: Missing exit conditions between phases ──────────────────
prev_phase=""
phase_has_exit=true
in_quad=false
in_block=false
while IFS= read -r line; do
  stripped="${line#"${line%%[! ]*}"}"
  # Skip content inside quadruple-backtick example regions
  case "$stripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; continue ;;
  esac
  $in_quad && continue
  # Skip content inside triple-backtick code blocks
  case "$stripped" in
    '```'*) if $in_block; then in_block=false; else in_block=true; fi; continue ;;
  esac
  $in_block && continue

  if echo "$line" | grep -qE '^## Phase [0-9]+'; then
    if [ -n "$prev_phase" ] && [ "$phase_has_exit" = false ]; then
      warn "Phase '$prev_phase' has no 'Exit condition' before the next phase"
    fi
    prev_phase="$line"
    phase_has_exit=false
  fi
  if echo "$line" | grep -qiE '\*\*Exit condition'; then
    phase_has_exit=true
  fi
done < "$SKILL_FILE"
# Check last phase
if [ -n "$prev_phase" ] && [ "$phase_has_exit" = false ]; then
  warn "Phase '$prev_phase' has no 'Exit condition'"
fi

# ── Check 10: find with -quit (inside bash blocks only) ──────────────
while IFS=$'\t' read -r bnum line; do
  if echo "$line" | grep -qE 'find\s+.*-quit'; then
    warn "bash block $bnum: 'find -quit' is GNU-only — use 'head -1' or 'grep -q' instead (Pattern 13)"
  fi
done < "$BLOCKS_FILE"

# ── Check 11: Hardcoded /tmp/ paths ─────────────────────────────────
line_num=0
in_quad=false
in_block=false
while IFS= read -r line; do
  line_num=$((line_num + 1))
  lstripped="${line#"${line%%[! ]*}"}"
  case "$lstripped" in
    '````'*) if $in_quad; then in_quad=false; else in_quad=true; fi; continue ;;
  esac
  $in_quad && continue
  case "$lstripped" in
    '```bash'*) in_block=true; continue ;;
    '```'*) in_block=false; continue ;;
  esac
  if $in_block; then
    # Skip comments and mktemp template syntax
    stripped=$(echo "$line" | sed 's/#.*//')
    if echo "$stripped" | grep -qE '"/tmp/[a-zA-Z]|/tmp/[a-zA-Z][a-zA-Z]'; then
      # Allow ${TMPDIR:-/tmp} pattern
      if ! echo "$stripped" | grep -qE '\$\{TMPDIR:-/tmp\}'; then
        warn "Line $line_num: Hardcoded '/tmp/' path — use mktemp instead (Pattern 4)"
      fi
    fi
  fi
done < "$SKILL_FILE"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "lint-skill: $ERRORS error(s), $WARNINGS warning(s)"
if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi
exit 0
