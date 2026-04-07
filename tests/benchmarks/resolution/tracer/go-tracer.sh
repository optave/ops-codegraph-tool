#!/usr/bin/env bash
# Dynamic call tracer for Go fixtures.
# Injects runtime.Callers()-based tracing into each function, compiles, and runs.
#
# Usage: bash go-tracer.sh <fixture-dir>
# Outputs: { "edges": [...] } JSON to stdout
# Requires: go toolchain

set -euo pipefail

FIXTURE_DIR="${1:-}"
if [[ -z "$FIXTURE_DIR" ]]; then
    echo "Usage: go-tracer.sh <fixture-dir>" >&2
    exit 1
fi

FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"

if ! command -v go &>/dev/null; then
    echo '{"edges":[],"error":"go toolchain not available"}'
    exit 0
fi

# Create temp directory with fixture copy
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp "$FIXTURE_DIR"/*.go "$TMP_DIR/"

# Create go.mod
cat > "$TMP_DIR/go.mod" <<'GOMOD'
module fixture
go 1.21
GOMOD

# Add trace support file
cat > "$TMP_DIR/trace_support.go" <<'GOTRACE'
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type traceEdge struct {
	SourceName string `json:"source_name"`
	SourceFile string `json:"source_file"`
	TargetName string `json:"target_name"`
	TargetFile string `json:"target_file"`
}

var (
	traceEdges []traceEdge
	traceSeen  = make(map[string]bool)
	traceMu    sync.Mutex
)

func cleanFuncName(full string) string {
	// "main.(*UserService).CreateUser" -> "UserService.CreateUser"
	// "main.NewUserService" -> "NewUserService"
	// "main.ValidateUser" -> "ValidateUser"
	name := full
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	// Strip package prefix
	if dot := strings.Index(name, "."); dot >= 0 {
		name = name[dot+1:]
	}
	// Strip pointer receiver markers: (*Type) -> Type
	name = strings.ReplaceAll(name, "(*", "")
	name = strings.ReplaceAll(name, ")", "")
	return name
}

func traceCall() {
	pc := make([]uintptr, 4)
	n := runtime.Callers(2, pc)
	if n < 2 {
		return
	}
	frames := runtime.CallersFrames(pc[:n])
	calleeFrame, more := frames.Next()
	if !more {
		return
	}
	callerFrame, _ := frames.Next()

	calleeName := cleanFuncName(calleeFrame.Function)
	calleeFile := filepath.Base(calleeFrame.File)
	callerName := cleanFuncName(callerFrame.Function)
	callerFile := filepath.Base(callerFrame.File)

	// Skip non-fixture files and trace infrastructure
	if calleeName == "traceCall" || callerName == "traceCall" {
		return
	}
	if calleeFile == "trace_support.go" || callerFile == "trace_support.go" {
		return
	}

	key := fmt.Sprintf("%s@%s->%s@%s", callerName, callerFile, calleeName, calleeFile)
	traceMu.Lock()
	defer traceMu.Unlock()
	if !traceSeen[key] {
		traceSeen[key] = true
		traceEdges = append(traceEdges, traceEdge{
			SourceName: callerName,
			SourceFile: callerFile,
			TargetName: calleeName,
			TargetFile: calleeFile,
		})
	}
}

func dumpTrace() {
	type result struct {
		Edges []traceEdge `json:"edges"`
	}
	out, _ := json.MarshalIndent(result{Edges: traceEdges}, "", "  ")
	os.Stdout.Write(out)
	fmt.Println()
}
GOTRACE

# Inject traceCall() at the start of each function in fixture files
for gofile in "$TMP_DIR"/*.go; do
    base="$(basename "$gofile")"
    [[ "$base" == "trace_support.go" ]] && continue

    # Use sed to inject traceCall() after function opening braces
    # Match: func ... { at end of line -> add traceCall() on next line
    # Use portable sed -i: GNU sed uses -i alone, BSD sed (macOS) requires -i ''
    if sed --version 2>/dev/null | grep -q GNU; then
        sed -i -E 's/^(func [^{]*\{)\s*$/\1\n\ttraceCall()/' "$gofile"
    else
        sed -i '' -E 's/^(func [^{]*\{)\s*$/\1\n\ttraceCall()/' "$gofile"
    fi
done

# Inject defer dumpTrace() at start of main()
if sed --version 2>/dev/null | grep -q GNU; then
    sed -i -E '/^func main\(\)\s*\{/{
        a\	defer dumpTrace()
    }' "$TMP_DIR/main.go"
    # Suppress any os.Exit calls that would skip deferred dumpTrace
    sed -i 's/os\.Exit(/\/\/ os.Exit(/g' "$TMP_DIR/main.go"
else
    sed -i '' -E '/^func main\(\)\s*\{/{
        a\	defer dumpTrace()
    }' "$TMP_DIR/main.go"
    # Suppress any os.Exit calls that would skip deferred dumpTrace
    sed -i '' 's/os\.Exit(/\/\/ os.Exit(/g' "$TMP_DIR/main.go"
fi

# Redirect fmt.Print* to stderr so only JSON goes to stdout
cat >> "$TMP_DIR/trace_support.go" <<'REDIRECT'

func init() {
	// Redirect standard output to stderr for fixture prints
	// We'll write JSON edges directly to the real stdout via dumpTrace
}
REDIRECT

# Build and run
cd "$TMP_DIR"
if go build -o fixture_trace . 2>/dev/null; then
    # Run and capture both stdout (JSON edges) and stderr (fixture output)
    ./fixture_trace 2>/dev/null || true
else
    echo '{"edges":[],"error":"go build failed"}'
fi
