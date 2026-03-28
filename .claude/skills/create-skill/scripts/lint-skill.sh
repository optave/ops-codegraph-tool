#!/usr/bin/env bash
# lint-skill.sh — Static analysis for SKILL.md files
# Catches the most common issues found in 250+ Greptile review comments.
# Exit 0 = warnings only, Exit 1 = errors found.
#
# Performance note: all inner-loop checks use bash builtins ([[ =~ ]], case,
# parameter expansion) instead of echo|grep subshells. This keeps runtime
# under 5 s even on Windows, where process creation is ~100x slower than Linux.

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
# Patterns use ^[[:space:]]* to match indented blocks (e.g. inside Markdown list items).
awk '
  /^[[:space:]]*````/       { quad = !quad; next }
  quad                       { next }
  /^[[:space:]]*```bash/    { inblock = 1; blocknum++; next }
  /^[[:space:]]*```/ && inblock { inblock = 0; next }
  inblock                   { print blocknum "\t" $0 }
' "$SKILL_FILE" > "$BLOCKS_FILE"

# Collect variable assignments per block and build reassignment lookup (O(1) per check)
declare -A VAR_BLOCK
declare -A REASSIGNED
while IFS=$'\t' read -r bnum line; do
  # Skip comment lines — they document context but don't register variable assignments
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  # Match UPPER_CASE_VAR= assignments (skip lowercase/mixed to reduce false positives)
  # Use while-read instead of for-in-$() to avoid empty-string iteration when grep matches nothing
  while IFS= read -r var; do
    [ -z "$var" ] && continue
    if [ -z "${VAR_BLOCK[$var]+x}" ]; then
      VAR_BLOCK["$var"]="$bnum"
    else
      # Track re-assignments in later blocks for O(1) lookup
      REASSIGNED["${var}:${bnum}"]=1
    fi
  done < <(echo "$line" | grep -oE '\b[A-Z][A-Z0-9_]+\+?=' | sed -E 's/\+?=$//')
done < "$BLOCKS_FILE"

# Check for references in later blocks without file persistence
while IFS=$'\t' read -r bnum line; do
  # Skip comment lines — they document context but don't execute variables at runtime
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  for var in "${!VAR_BLOCK[@]}"; do
    assigned_in="${VAR_BLOCK[$var]}"
    if [ "$bnum" -gt "$assigned_in" ]; then
      # Check if this line references the variable ($VAR or ${VAR}) using bash builtins
      if [[ "$line" == *'$'"${var}"* ]] || [[ "$line" == *'${'"${var}"'}'* ]]; then
        # Narrow check: ensure the $VAR reference isn't followed by [A-Za-z0-9_]
        # (which would mean it's a different, longer variable name)
        if [[ "$line" =~ \$${var}([^A-Za-z0-9_]|$) ]] || [[ "$line" == *'${'"${var}"'}'* ]]; then
          # Check if the same block also assigns it (re-assignment is fine) — O(1) lookup
          if [ -z "${REASSIGNED[${var}:${bnum}]+x}" ]; then
            # Check it's not read from a file (cat, $(...) with cat/read)
            if [[ "$line" != *'cat '* ]] && [[ "$line" != *'read '* ]] && \
               [[ "$line" != *'< '* ]] && [[ "$line" != *'<"'* ]] && [[ "$line" != *'$(<'* ]]; then
              error "Cross-fence variable: \$$var assigned in bash block $assigned_in, referenced in block $bnum without file persistence (Pattern 1)"
            fi
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
  if $in_block; then
    if [[ "$line" =~ 2\>/dev/null ]] || [[ "$line" =~ \>[[:space:]]*/dev/null\ 2\>\&1 ]] || [[ "$line" == *'&>/dev/null'* ]]; then
      # Check same line or previous line for justification comment (case-insensitive via ,, lowercasing)
      combined="${prev_line}${line}"
      combined_lower="${combined,,}"
      if [[ "$combined_lower" != *'# '* ]] || {
        [[ "$combined_lower" != *'#'*'intentional'* ]] &&
        [[ "$combined_lower" != *'#'*'tolera'* ]] &&
        [[ "$combined_lower" != *'#'*'acceptable'* ]] &&
        [[ "$combined_lower" != *'#'*'expected'* ]] &&
        [[ "$combined_lower" != *'#'*'safe to ignore'* ]] &&
        [[ "$combined_lower" != *'#'*'may fail'* ]] &&
        [[ "$combined_lower" != *'#'*'optional'* ]] &&
        [[ "$combined_lower" != *'#'*'fallback'* ]] &&
        [[ "$combined_lower" != *'#'*'portable'* ]] &&
        [[ "$combined_lower" != *'#'*'suppress'* ]] &&
        [[ "$combined_lower" != *'#'*'provid'* ]]; }; then
        warn "Line $line_num: '2>/dev/null' without justification comment (Pattern 2)"
      fi
    fi
  fi
  prev_line="$line"
done < "$SKILL_FILE"

# ── Check 3: git add . or git add -A (inside bash blocks only) ───────
while IFS=$'\t' read -r bnum line; do
  if [[ "$line" =~ ^[[:space:]]*git[[:space:]]+add[[:space:]]+(--[[:space:]]+\.|\.|-A|--all)([[:space:]\;\#]|$) ]]; then
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
    # Save in_detect before fi-processing so inline commands on the same line
    # (e.g. "else npm test; fi") are evaluated in the correct detection context.
    was_in_detect=$in_detect
    if [[ "$line" =~ ^[[:space:]]*if[[:space:]] ]] && [[ "$line" =~ (-f[[:space:]]|-d[[:space:]]|lock|package|command\ -v|which[[:space:]]|find[[:space:]]) ]]; then
      in_detect=true
      was_in_detect=true
      # Only increment depth if fi does NOT also close on this line (one-liner guard)
      if [[ "$line" =~ (^|[^A-Za-z0-9_])fi([^A-Za-z0-9_]|$) ]]; then
        # One-liner: detection block is self-contained — reset so subsequent lines are checked normally
        in_detect=false
      else
        detect_depth=$((detect_depth + 1))
      fi
    elif [[ "$line" =~ ^[[:space:]]*elif[[:space:]] ]] && [[ "$line" =~ (-f[[:space:]]|-d[[:space:]]|lock|package|command\ -v|which[[:space:]]|find[[:space:]]) ]]; then
      # elif is a sibling branch — set in_detect but do NOT increment depth
      in_detect=true
      was_in_detect=true
      # Handle inline fi on this same elif line (e.g. "elif [ -f yarn.lock ]; then CMD=yarn; fi")
      if [[ "$line" =~ (^|[^A-Za-z0-9_])fi([^A-Za-z0-9_]|$) ]]; then
        if [ "$detect_depth" -gt 0 ]; then
          detect_depth=$((detect_depth - 1))
          [ "$detect_depth" -eq 0 ] && in_detect=false
        else
          in_detect=false
        fi
      fi
    elif [[ "$line" =~ ^[[:space:]]*if([^A-Za-z0-9_]|$) ]]; then
      # nested if (not a detection block) — track depth only when inside detection
      [ "$in_detect" = true ] && detect_depth=$((detect_depth + 1))
    elif [[ "$line" =~ ^[[:space:]]*fi([^A-Za-z0-9_]|$) ]]; then
      if [ "$detect_depth" -gt 0 ]; then
        detect_depth=$((detect_depth - 1))
        [ "$detect_depth" -eq 0 ] && in_detect=false
      else
        # Safety reset: in_detect was set by an elif without a preceding detection if
        in_detect=false
      fi
    elif $in_detect && [[ "$line" =~ (^|[^A-Za-z0-9_])fi([^A-Za-z0-9_]|$) ]]; then
      # fi appears inline (e.g. "else ...; fi") — still closes the outermost detection block
      if [ "$detect_depth" -gt 0 ]; then
        detect_depth=$((detect_depth - 1))
        [ "$detect_depth" -eq 0 ] && in_detect=false
      else
        in_detect=false
      fi
    fi
    # Use was_in_detect so commands on the same line as an inline fi
    # (e.g. "else npm test; fi") are not falsely flagged — the command
    # was part of the detection block, not after it.
    if ! $was_in_detect; then
      if [[ "$line" =~ ^[[:space:]]*((npm|yarn|pnpm)\ test|(npm|yarn|pnpm)\ run\ (test|lint))([^:A-Za-z0-9_]|$) ]]; then
        trimmed="${line#"${line%%[! ]*}"}"
        warn "Line $line_num: Hardcoded '$trimmed' — detect package manager first (Pattern 6)"
      fi
    fi
  fi
done < "$SKILL_FILE"

# ── Check 5: sed -i without .bak (inside bash blocks only) ──────────
while IFS=$'\t' read -r bnum line; do
  if [[ "$line" =~ sed[[:space:]]+-i[[:space:]]*(\'\'|\"|[^.]) ]]; then
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

# ── Check 8b: Missing Examples section ──────────────────────────────
if ! grep -qE '^## Examples' "$SKILL_FILE"; then
  error "Missing '## Examples' section — every skill needs 2-3 usage examples"
fi

# ── Check 6b: name field matches directory name ─────────────────────
expected_name=$(basename "$(dirname "$SKILL_FILE")")
actual_name=$(head -20 "$SKILL_FILE" | grep -m1 '^name:' | sed 's/^name:[[:space:]]*//')
if [ -n "$actual_name" ] && [ "$actual_name" != "$expected_name" ]; then
  error "Frontmatter 'name: $actual_name' does not match directory name '$expected_name' (Phase 4 checklist item 2)"
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
  # Skip content inside triple-backtick code blocks.
  # Limitation: nested fences inside ```markdown blocks (e.g. scaffold templates
  # containing ```bash examples) will toggle in_block incorrectly. Wrap such
  # regions in quadruple-backtick ```` fences to avoid false positives.
  case "$stripped" in
    '```'*) if $in_block; then in_block=false; else in_block=true; fi; continue ;;
  esac
  $in_block && continue

  if [[ "$line" =~ ^##\ Phase\ [0-9]+ ]]; then
    if [ -n "$prev_phase" ] && [ "$phase_has_exit" = false ]; then
      warn "Phase '$prev_phase' has no 'Exit condition' before the next phase"
    fi
    prev_phase="$line"
    phase_has_exit=false
  fi
  if [[ "${line,,}" == *'**exit condition'* ]]; then
    phase_has_exit=true
  fi
done < "$SKILL_FILE"
# Check last phase
if [ -n "$prev_phase" ] && [ "$phase_has_exit" = false ]; then
  warn "Phase '$prev_phase' has no 'Exit condition'"
fi

# ── Check 10: find with -quit (inside bash blocks only) ──────────────
while IFS=$'\t' read -r bnum line; do
  if [[ "$line" =~ find[[:space:]].*-quit ]]; then
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
    # Strip shell comments (# preceded by whitespace) but not # inside strings
    stripped="${line%%[[:space:]]#*}"
    if [[ "$stripped" =~ [\"/]/tmp/[a-zA-Z] ]]; then
      # Allow ${TMPDIR:-/tmp} pattern
      if [[ "$stripped" != *'${TMPDIR:-/tmp}'* ]]; then
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
