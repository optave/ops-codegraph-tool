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
