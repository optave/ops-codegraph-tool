#!/usr/bin/env bash
# Shared helpers for the dynamic call tracer scripts in this directory.
# Each tracer (native-tracer.sh, jvm-tracer.sh, go-tracer.sh, ...) is spawned
# as its own subprocess by run-tracer.mjs, so sharing logic between them means
# sourcing this file rather than importing a function — source it with a path
# relative to the caller's own location so it resolves regardless of the
# invoking process's working directory:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/tracer-common.sh"

# Portable sed -i (GNU vs BSD)
sedi() {
    if sed --version 2>/dev/null | grep -q GNU; then
        sed -i "$@"
    else
        sed -i '' "$@"
    fi
}

# GNU sed accepts the single-line "i\text" / "a\text" shortcut for its insert
# and append commands; BSD sed (macOS) rejects it and requires the text on
# the line *after* the backslash (see #1759). The three helpers below build
# that portable multi-line form internally so call sites never hand-roll the
# GNU-only shortcut (see #1913).

# Insert TEXT on the line immediately before the first line matching PATTERN.
sedi_insert_before() {
    local pattern="$1" text="$2" file="$3"
    sedi "${pattern} i\\
${text}" "$file"
}

# Insert TEXT immediately before the first line matching INSERT_PATTERN,
# scoped to the START_PATTERN,END_PATTERN address range. Used to splice a
# dump()-style call just before a function's closing brace without touching
# unrelated braces elsewhere in the file. INSERT_PATTERN is taken separately
# from END_PATTERN because some callers close the range on a looser match
# (e.g. any line containing `}`) than the line they actually inject before.
sedi_insert_before_end() {
    local start_pattern="$1" end_pattern="$2" insert_pattern="$3" text="$4" file="$5"
    sedi "${start_pattern},${end_pattern} {
${insert_pattern} i\\
${text}
}" "$file"
}

# Append TEXT after every line matching OUTER_PATTERN, except lines that also
# match NEGATE_PATTERN (used to skip class/interface/object declaration lines
# that share the same brace-opening shape as method signatures). Runs with
# extended regex (-E) since every current caller relies on ERE alternation.
sedi_append_unless() {
    local outer_pattern="$1" negate_pattern="$2" text="$3" file="$4"
    sedi -E "${outer_pattern}{
${negate_pattern}!a\\
${text}
}" "$file"
}
