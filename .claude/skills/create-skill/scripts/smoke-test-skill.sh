#!/usr/bin/env bash
# smoke-test-skill.sh — Extract bash blocks from a SKILL.md and run bash -n
# Skips blocks inside quadruple-backtick example regions (Wrong/Correct pairs).
# Exit 0 = all blocks pass, Exit 1 = syntax errors found.

set -euo pipefail

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "smoke-test-skill.sh requires bash 4+ (for set -o pipefail reliability). On macOS: brew install bash" >&2
  exit 1
fi

SKILL_FILE="${1:?Usage: smoke-test-skill.sh <path-to-SKILL.md>}"

if [ ! -f "$SKILL_FILE" ]; then
  echo "ERROR: File not found: $SKILL_FILE"
  exit 1
fi

TMPBLOCK=$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX.sh")
trap 'rm -f "$TMPBLOCK"' EXIT

PASS=0
FAIL=0
SKIP=0

line_num=0
in_quad=false
in_block=false
block_start=0

while IFS= read -r line; do
  line_num=$((line_num + 1))

  # Strip leading whitespace for fence detection (indented blocks inside list items)
  stripped="${line#"${line%%[! ]*}"}"

  # Track quadruple-backtick regions (example pairs)
  case "$stripped" in
    '````'*)
      if $in_quad; then
        in_quad=false
      else
        in_quad=true
      fi
      continue
      ;;
  esac

  # Skip blocks inside example regions
  if $in_quad; then
    continue
  fi

  # Track triple-backtick bash blocks
  case "$stripped" in
    '```bash'*)
      in_block=true
      block_start=$line_num
      > "$TMPBLOCK"
      continue
      ;;
    '```'*)
      if $in_block; then
        in_block=false
        # Run syntax check on the collected block
        if [ -s "$TMPBLOCK" ]; then
          if output=$(bash -n "$TMPBLOCK" 2>&1); then
            echo "  OK    block at line $block_start"
            PASS=$((PASS + 1))
          else
            echo "  FAIL  block at line $block_start:"
            echo "$output" | sed 's/^/        /'
            FAIL=$((FAIL + 1))
          fi
        else
          echo "  SKIP  empty block at line $block_start"
          SKIP=$((SKIP + 1))
        fi
      fi
      continue
      ;;
  esac

  # Accumulate block contents
  if $in_block; then
    echo "$line" >> "$TMPBLOCK"
  fi

done < "$SKILL_FILE"

echo ""
echo "smoke-test-skill: $PASS passed, $FAIL failed, $SKIP skipped"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
