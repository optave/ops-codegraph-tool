#!/usr/bin/env bash
# Dynamic call tracer for Bash fixtures.
# Uses trap DEBUG + FUNCNAME/BASH_SOURCE to capture caller->callee edges.
#
# Usage: bash bash-tracer.sh <fixture-dir>
# Outputs: { "edges": [...] } JSON to stdout

set -euo pipefail

FIXTURE_DIR="${1:-}"
if [[ -z "$FIXTURE_DIR" ]]; then
    echo "Usage: bash-tracer.sh <fixture-dir>" >&2
    exit 1
fi

FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"

# Temp file to collect edges (associating in bash is limited)
EDGE_FILE="$(mktemp)"
trap 'rm -f "$EDGE_FILE"' EXIT

declare -A SEEN_EDGES=()

_tracer_hook() {
    # FUNCNAME[0] is _tracer_hook itself
    # FUNCNAME[1] is the current function being entered
    # FUNCNAME[2] is the caller
    local depth=${#FUNCNAME[@]}
    if [[ $depth -lt 3 ]]; then return; fi

    local callee="${FUNCNAME[1]}"
    local callee_file
    callee_file="$(basename "${BASH_SOURCE[1]}" 2>/dev/null || echo "")"
    local caller="${FUNCNAME[2]}"
    local caller_file
    caller_file="$(basename "${BASH_SOURCE[2]}" 2>/dev/null || echo "")"

    # Skip tracer internals and non-fixture files
    [[ "$callee" == "_tracer_hook" ]] && return
    [[ "$callee" == "source" ]] && return
    [[ "$callee" == "main" && "$callee_file" == "bash-tracer.sh" ]] && return
    [[ -z "$callee_file" || -z "$caller_file" ]] && return

    # Only trace fixture files
    local callee_path="${BASH_SOURCE[1]}"
    local caller_path="${BASH_SOURCE[2]}"
    [[ "$callee_path" != "$FIXTURE_DIR"/* && "$callee_path" != *.sh ]] && return

    local key="${caller}@${caller_file}->${callee}@${callee_file}"
    if [[ -z "${SEEN_EDGES[$key]+x}" ]]; then
        SEEN_EDGES[$key]=1
        printf '%s\t%s\t%s\t%s\n' "$caller" "$caller_file" "$callee" "$callee_file" >> "$EDGE_FILE"
    fi
}

# Enable DEBUG trap
set -o functrace
trap '_tracer_hook' DEBUG

# Run the fixture
source "$FIXTURE_DIR/main.sh" 2>/dev/null || true

# Disable trap
trap - DEBUG

# Escape a string for safe JSON embedding
_json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

# Output JSON from collected edges
echo '{'
echo '  "edges": ['
first=true
while IFS=$'\t' read -r src_name src_file tgt_name tgt_file; do
    if [[ "$first" == "true" ]]; then
        first=false
    else
        echo ','
    fi
    printf '    {\n      "source_name": "%s",\n      "source_file": "%s",\n      "target_name": "%s",\n      "target_file": "%s"\n    }' \
        "$(_json_escape "$src_name")" "$(_json_escape "$src_file")" "$(_json_escape "$tgt_name")" "$(_json_escape "$tgt_file")"
done < "$EDGE_FILE"
echo ''
echo '  ]'
echo '}'
