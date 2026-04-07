#!/usr/bin/env bash
# Dynamic call tracer for native/compiled languages.
# Handles: C, C++, Rust, Swift, Dart, Zig, Haskell, OCaml, F#, Gleam, Solidity, C#
#
# Uses language-specific instrumentation:
#   C/C++:    -finstrument-functions (GCC/Clang)
#   Rust:     Custom proc-macro or manual instrumentation
#   C#/F#:    dotnet build + StackTrace instrumentation
#   Others:   Language-specific approaches
#
# Usage: bash native-tracer.sh <fixture-dir> <language>
# Outputs: { "edges": [...] } JSON to stdout

set -euo pipefail

FIXTURE_DIR="${1:-}"
LANG="${2:-}"

if [[ -z "$FIXTURE_DIR" || -z "$LANG" ]]; then
    echo "Usage: native-tracer.sh <fixture-dir> <language>" >&2
    exit 1
fi

FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Portable sed -i (GNU vs BSD)
sedi() {
    if sed --version 2>/dev/null | grep -q GNU; then
        sed -i "$@"
    else
        sed -i '' "$@"
    fi
}

empty_result() {
    local reason="${1:-toolchain not available}"
    echo "{\"edges\":[],\"error\":\"$reason\"}"
    exit 0
}

# ── C / C++ ──────────────────────────────────────────────────────────────
trace_c_cpp() {
    local compiler="$1"
    local ext="$2"

    if ! command -v "$compiler" &>/dev/null; then
        empty_result "$compiler not available"
    fi

    cp "$FIXTURE_DIR"/*."$ext" "$TMP_DIR/" 2>/dev/null || true
    cp "$FIXTURE_DIR"/*.h "$TMP_DIR/" 2>/dev/null || true

    # Create instrumentation support
    cat > "$TMP_DIR/trace_support.c" <<'CTRACE'
#include <stdio.h>
#include <string.h>
#include <dlfcn.h>

#define MAX_EDGES 1024
#define MAX_STACK 256

typedef struct {
    char source_name[128];
    char source_file[128];
    char target_name[128];
    char target_file[128];
} Edge;

static Edge edges[MAX_EDGES];
static int edge_count = 0;
static char seen[MAX_EDGES][512];
static int seen_count = 0;

typedef struct { char name[128]; char file[128]; } Frame;
static Frame call_stack[MAX_STACK];
static int stack_depth = 0;

static const char* extract_name(void* addr) {
    Dl_info info;
    if (dladdr(addr, &info) && info.dli_sname) {
        return info.dli_sname;
    }
    return "unknown";
}

static const char* extract_file(void* addr) {
    Dl_info info;
    if (dladdr(addr, &info) && info.dli_fname) {
        const char* s = strrchr(info.dli_fname, '/');
        return s ? s + 1 : info.dli_fname;
    }
    return "unknown";
}

void __cyg_profile_func_enter(void* callee, void* caller)
    __attribute__((no_instrument_function));
void __cyg_profile_func_exit(void* callee, void* caller)
    __attribute__((no_instrument_function));

void __cyg_profile_func_enter(void* callee, void* caller) {
    const char* callee_name = extract_name(callee);
    const char* callee_file = extract_file(callee);

    if (stack_depth > 0 && edge_count < MAX_EDGES) {
        Frame* top = &call_stack[stack_depth - 1];
        char key[512];
        snprintf(key, sizeof(key), "%s@%s->%s@%s",
            top->name, top->file, callee_name, callee_file);

        int found = 0;
        for (int i = 0; i < seen_count; i++) {
            if (strcmp(seen[i], key) == 0) { found = 1; break; }
        }
        if (!found && seen_count < MAX_EDGES) {
            strncpy(seen[seen_count++], key, 511);
            strncpy(edges[edge_count].source_name, top->name, 127);
            strncpy(edges[edge_count].source_file, top->file, 127);
            strncpy(edges[edge_count].target_name, callee_name, 127);
            strncpy(edges[edge_count].target_file, callee_file, 127);
            edge_count++;
        }
    }

    if (stack_depth < MAX_STACK) {
        strncpy(call_stack[stack_depth].name, callee_name, 127);
        strncpy(call_stack[stack_depth].file, callee_file, 127);
        stack_depth++;
    }
}

void __cyg_profile_func_exit(void* callee, void* caller) {
    if (stack_depth > 0) stack_depth--;
}

void __attribute__((destructor, no_instrument_function)) dump_trace() {
    printf("{\n  \"edges\": [\n");
    for (int i = 0; i < edge_count; i++) {
        printf("    {\n");
        printf("      \"source_name\": \"%s\",\n", edges[i].source_name);
        printf("      \"source_file\": \"%s\",\n", edges[i].source_file);
        printf("      \"target_name\": \"%s\",\n", edges[i].target_name);
        printf("      \"target_file\": \"%s\"\n", edges[i].target_file);
        printf("    }%s\n", (i < edge_count - 1) ? "," : "");
    }
    printf("  ]\n}\n");
}
CTRACE

    cd "$TMP_DIR"
    local src_files
    src_files="$(ls *."$ext" 2>/dev/null | tr '\n' ' ')"

    if [[ "$compiler" == "gcc" || "$compiler" == "cc" ]]; then
        if $compiler -finstrument-functions -rdynamic -ldl $src_files trace_support.c -o traced 2>/dev/null; then
            ./traced 2>/dev/null || echo '{"edges":[]}'
        else
            empty_result "$compiler compilation failed"
        fi
    else
        if $compiler -finstrument-functions -rdynamic $src_files trace_support.c -o traced -ldl -lstdc++ 2>/dev/null; then
            ./traced 2>/dev/null || echo '{"edges":[]}'
        else
            empty_result "$compiler compilation failed"
        fi
    fi
}

# ── Rust ─────────────────────────────────────────────────────────────────
trace_rust() {
    if ! command -v cargo &>/dev/null; then
        empty_result "cargo not available"
    fi

    # Create a Cargo project
    mkdir -p "$TMP_DIR/src"
    cp "$FIXTURE_DIR"/*.rs "$TMP_DIR/src/"

    cat > "$TMP_DIR/Cargo.toml" <<'TOML'
[package]
name = "fixture-trace"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "trace"
path = "src/main.rs"
TOML

    # Create trace_support module with RAII-based call tracing
    cat > "$TMP_DIR/src/trace_support.rs" <<'RSTRACE'
use std::cell::RefCell;
use std::collections::HashSet;

struct Edge {
    source_name: String,
    source_file: String,
    target_name: String,
    target_file: String,
}

struct Frame {
    name: String,
    file: String,
}

pub struct TraceGuard;

impl Drop for TraceGuard {
    fn drop(&mut self) {
        TRACER.with(|t| {
            let mut t = t.borrow_mut();
            t.stack.pop();
        });
    }
}

struct Tracer {
    edges: Vec<Edge>,
    seen: HashSet<String>,
    stack: Vec<Frame>,
}

thread_local! {
    static TRACER: RefCell<Tracer> = RefCell::new(Tracer {
        edges: Vec::new(),
        seen: HashSet::new(),
        stack: Vec::new(),
    });
}

pub fn trace_call(name: &str, file: &str) -> TraceGuard {
    TRACER.with(|t| {
        let mut t = t.borrow_mut();
        if let Some(caller) = t.stack.last() {
            let key = format!("{}@{}->{}@{}", caller.name, caller.file, name, file);
            if !t.seen.contains(&key) {
                t.seen.insert(key);
                t.edges.push(Edge {
                    source_name: caller.name.clone(),
                    source_file: caller.file.clone(),
                    target_name: name.to_string(),
                    target_file: file.to_string(),
                });
            }
        }
        t.stack.push(Frame {
            name: name.to_string(),
            file: file.to_string(),
        });
    });
    TraceGuard
}

pub fn dump_trace() {
    TRACER.with(|t| {
        let t = t.borrow();
        print!("{{\n  \"edges\": [\n");
        for (i, e) in t.edges.iter().enumerate() {
            print!("    {{\n");
            print!("      \"source_name\": \"{}\",\n", e.source_name);
            print!("      \"source_file\": \"{}\",\n", e.source_file);
            print!("      \"target_name\": \"{}\",\n", e.target_name);
            print!("      \"target_file\": \"{}\"\n", e.target_file);
            if i < t.edges.len() - 1 {
                print!("    }},\n");
            } else {
                print!("    }}\n");
            }
        }
        println!("  ]\n}}");
    });
}
RSTRACE

    # Add mod trace_support to main.rs
    sedi '1s/^/mod trace_support;\n/' "$TMP_DIR/src/main.rs"

    # Inject trace_call into every fn body using a bash loop that tracks impl blocks
    for rsfile in "$TMP_DIR/src"/*.rs; do
        base="$(basename "$rsfile")"
        [[ "$base" == "trace_support.rs" ]] && continue

        local current_impl=""
        local tmpfile="$(mktemp)"

        while IFS= read -r line || [[ -n "$line" ]]; do
            # Track impl blocks: "impl TypeName" or "impl TypeName for Trait"
            if [[ "$line" =~ ^impl[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) ]]; then
                current_impl="${BASH_REMATCH[1]}"
            fi

            # End of impl block (top-level closing brace)
            if [[ "$line" == "}" && -n "$current_impl" ]]; then
                printf '%s\n' "$line" >> "$tmpfile"
                current_impl=""
                continue
            fi

            # Detect fn declarations ending with {
            if [[ "$line" =~ fn[[:space:]]+([a-z_][a-z0-9_]*) ]] && [[ "$line" =~ \{[[:space:]]*$ ]]; then
                local fname="${BASH_REMATCH[1]}"
                local qualname="$fname"
                if [[ -n "$current_impl" ]]; then
                    qualname="${current_impl}.${fname}"
                fi
                printf '%s\n' "$line" >> "$tmpfile"
                printf '        let _tg = crate::trace_support::trace_call("%s", "%s");\n' "$qualname" "$base" >> "$tmpfile"
                continue
            fi

            printf '%s\n' "$line" >> "$tmpfile"
        done < "$rsfile"

        mv "$tmpfile" "$rsfile"
    done

    # Inject dump_trace() at end of main()
    sedi '/^fn main/,/^\}/ {
        /^\}/ i\    crate::trace_support::dump_trace();
    }' "$TMP_DIR/src/main.rs"

    # Redirect eprintln/println in fixture code to stderr to keep stdout clean for JSON
    for rsfile in "$TMP_DIR/src"/*.rs; do
        base="$(basename "$rsfile")"
        [[ "$base" == "trace_support.rs" ]] && continue
        sedi 's/println!/eprintln!/g' "$rsfile" 2>/dev/null || true
    done

    cd "$TMP_DIR"
    if cargo build --release 2>/dev/null; then
        ./target/release/trace 2>/dev/null || echo '{"edges":[]}'
    else
        empty_result "cargo build failed"
    fi
}

# ── C# / F# (.NET) ──────────────────────────────────────────────────────
trace_dotnet() {
    local sublang="$1"
    if ! command -v dotnet &>/dev/null; then
        empty_result "dotnet not available"
    fi

    mkdir -p "$TMP_DIR/src"
    case "$sublang" in
        csharp) cp "$FIXTURE_DIR"/*.cs "$TMP_DIR/src/" ;;
        fsharp) cp "$FIXTURE_DIR"/*.fs "$TMP_DIR/src/" ;;
    esac

    cd "$TMP_DIR"
    case "$sublang" in
        csharp)
            dotnet new console -o . --force 2>/dev/null || true
            cp src/*.cs . 2>/dev/null || true

            # Create CallTracer using StackTrace
            cat > "$TMP_DIR/CallTracer.cs" <<'CSTRACE'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace Benchmark;

public static class CallTracer
{
    private static readonly List<Dictionary<string, string>> Edges = new();
    private static readonly HashSet<string> Seen = new();

    public static void TraceCall()
    {
        var st = new StackTrace(true);
        if (st.FrameCount < 3) return;

        var calleeFrame = st.GetFrame(1);
        var callerFrame = st.GetFrame(2);
        if (calleeFrame == null || callerFrame == null) return;

        var calleeMethod = calleeFrame.GetMethod();
        var callerMethod = callerFrame.GetMethod();
        if (calleeMethod == null || callerMethod == null) return;

        string calleeName = CleanName(calleeMethod);
        string calleeFile = Path.GetFileName(calleeFrame.GetFileName() ?? "");
        string callerName = CleanName(callerMethod);
        string callerFile = Path.GetFileName(callerFrame.GetFileName() ?? "");

        if (string.IsNullOrEmpty(calleeFile) || string.IsNullOrEmpty(callerFile)) return;
        if (calleeFile == "CallTracer.cs" || callerFile == "CallTracer.cs") return;

        string key = $"{callerName}@{callerFile}->{calleeName}@{calleeFile}";
        if (Seen.Contains(key)) return;
        Seen.Add(key);

        Edges.Add(new Dictionary<string, string>
        {
            ["source_name"] = callerName,
            ["source_file"] = callerFile,
            ["target_name"] = calleeName,
            ["target_file"] = calleeFile,
        });
    }

    private static string CleanName(System.Reflection.MethodBase method)
    {
        string cls = method.DeclaringType?.Name ?? "";
        string name = method.Name;
        if (name == ".ctor") return cls;
        if (name == "Main") return "Main.main";
        if (!string.IsNullOrEmpty(cls) && cls != "Program")
            return $"{cls}.{name}";
        return name;
    }

    public static void Dump()
    {
        Console.WriteLine("{");
        Console.WriteLine("  \"edges\": [");
        for (int i = 0; i < Edges.Count; i++)
        {
            var e = Edges[i];
            Console.WriteLine("    {");
            Console.WriteLine($"      \"source_name\": \"{e["source_name"]}\",");
            Console.WriteLine($"      \"source_file\": \"{e["source_file"]}\",");
            Console.WriteLine($"      \"target_name\": \"{e["target_name"]}\",");
            Console.WriteLine($"      \"target_file\": \"{e["target_file"]}\"");
            Console.Write("    }");
            if (i < Edges.Count - 1) Console.Write(",");
            Console.WriteLine();
        }
        Console.WriteLine("  ]");
        Console.WriteLine("}");
    }
}
CSTRACE

            # Inject CallTracer.TraceCall() into method bodies (Allman brace style)
            # Track: if previous line looks like a method declaration, inject after {
            for csfile in "$TMP_DIR"/*.cs; do
                base="$(basename "$csfile")"
                [[ "$base" == "CallTracer.cs" ]] && continue
                local prev_is_method=false
                local tmpfile="$(mktemp)"

                while IFS= read -r line || [[ -n "$line" ]]; do
                    local trimmed="${line#"${line%%[![:space:]]*}"}"
                    # Detect method declarations (line ends with ) )
                    if [[ "$trimmed" =~ \)$ ]] && [[ ! "$trimmed" =~ ^(using|namespace|class|interface|struct|enum|if|while|for|switch|catch|return|new) ]]; then
                        prev_is_method=true
                        printf '%s\n' "$line" >> "$tmpfile"
                        continue
                    fi
                    # If previous line was a method decl and this line is {
                    if $prev_is_method && [[ "$trimmed" == "{" ]]; then
                        printf '%s\n' "$line" >> "$tmpfile"
                        printf '        CallTracer.TraceCall();\n' >> "$tmpfile"
                        prev_is_method=false
                        continue
                    fi
                    prev_is_method=false
                    printf '%s\n' "$line" >> "$tmpfile"
                done < "$csfile"

                mv "$tmpfile" "$csfile"
            done

            # Inject Dump at end of Main
            sedi '/public static void Main/,/^\s*\}/ {
                /^\s*\}/ i\        CallTracer.Dump();
            }' "$TMP_DIR/Program.cs" 2>/dev/null || true

            # Also call RunWithValidation if it exists
            sedi '/CallTracer.Dump/i\        RunWithValidation();' "$TMP_DIR/Program.cs" 2>/dev/null || true

            # Redirect Console.WriteLine in fixture code to stderr
            for csfile in "$TMP_DIR"/*.cs; do
                base="$(basename "$csfile")"
                [[ "$base" == "CallTracer.cs" ]] && continue
                sedi 's/Console\.WriteLine/Console.Error.WriteLine/g' "$csfile" 2>/dev/null || true
            done

            if dotnet build 2>/dev/null; then
                dotnet run --no-build 2>/dev/null || echo '{"edges":[]}'
            else
                empty_result "dotnet build failed"
            fi
            ;;
        fsharp)
            dotnet new console -lang F# -o . --force 2>/dev/null || true
            cp src/*.fs . 2>/dev/null || true
            if dotnet build 2>/dev/null; then
                dotnet run --no-build 2>/dev/null || echo '{"edges":[]}'
            else
                empty_result "dotnet build failed"
            fi
            ;;
    esac
}

# ── Swift ────────────────────────────────────────────────────────────────
trace_swift() {
    if ! command -v swiftc &>/dev/null; then
        empty_result "swiftc not available"
    fi

    cp "$FIXTURE_DIR"/*.swift "$TMP_DIR/"

    # Create trace support using Thread.callStackSymbols
    cat > "$TMP_DIR/TraceSupport.swift" <<'SWTRACE'
import Foundation

struct TraceEdge {
    let sourceName: String
    let sourceFile: String
    let targetName: String
    let targetFile: String
}

class CallTracer {
    static let shared = CallTracer()
    private var edges: [TraceEdge] = []
    private var seen: Set<String> = []
    private var stack: [(name: String, file: String)] = []

    func traceCall(_ name: String, _ file: String) {
        if let caller = stack.last {
            let key = "\(caller.name)@\(caller.file)->\(name)@\(file)"
            if !seen.contains(key) {
                seen.insert(key)
                edges.append(TraceEdge(sourceName: caller.name, sourceFile: caller.file,
                                       targetName: name, targetFile: file))
            }
        }
        stack.append((name: name, file: file))
    }

    func traceReturn() {
        if !stack.isEmpty { stack.removeLast() }
    }

    func dump() {
        print("{")
        print("  \"edges\": [")
        for (i, e) in edges.enumerated() {
            print("    {")
            print("      \"source_name\": \"\(e.sourceName)\",")
            print("      \"source_file\": \"\(e.sourceFile)\",")
            print("      \"target_name\": \"\(e.targetName)\",")
            print("      \"target_file\": \"\(e.targetFile)\"")
            print("    }\(i < edges.count - 1 ? "," : "")")
        }
        print("  ]")
        print("}")
    }
}
SWTRACE

    # Inject traceCall into every func body using bash loop
    for swfile in "$TMP_DIR"/*.swift; do
        base="$(basename "$swfile")"
        [[ "$base" == "TraceSupport.swift" ]] && continue
        local current_class=""
        local tmpfile="$(mktemp)"

        while IFS= read -r line || [[ -n "$line" ]]; do
            local trimmed="${line#"${line%%[![:space:]]*}"}"
            # Track class/struct declarations
            if [[ "$trimmed" =~ ^(class|struct)[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) ]]; then
                current_class="${BASH_REMATCH[2]}"
            fi
            # End of class (top-level })
            if [[ "$trimmed" == "}" && -n "$current_class" ]] && [[ ! "$line" =~ ^[[:space:]] ]]; then
                printf '%s\n' "$line" >> "$tmpfile"
                current_class=""
                continue
            fi
            # Detect func declarations ending with {
            if [[ "$trimmed" =~ ^(override[[:space:]]+)?func[[:space:]]+([a-zA-Z_][a-zA-Z0-9_]*) ]] && [[ "$trimmed" =~ \{[[:space:]]*$ ]]; then
                local fname="${BASH_REMATCH[2]}"
                local qualname="$fname"
                if [[ -n "$current_class" ]]; then
                    qualname="${current_class}.${fname}"
                fi
                printf '%s\n' "$line" >> "$tmpfile"
                printf '        CallTracer.shared.traceCall("%s", "%s"); defer { CallTracer.shared.traceReturn() }\n' "$qualname" "$base" >> "$tmpfile"
                continue
            fi
            printf '%s\n' "$line" >> "$tmpfile"
        done < "$swfile"
        mv "$tmpfile" "$swfile"
    done

    # Inject dump at end of main (top-level code or main function)
    if grep -q 'func main' "$TMP_DIR/main.swift" 2>/dev/null; then
        sedi '/^func main/,/^\}/ {
            /^\}/ i\    CallTracer.shared.dump()
        }' "$TMP_DIR/main.swift"
    else
        echo 'CallTracer.shared.dump()' >> "$TMP_DIR/main.swift"
    fi

    cd "$TMP_DIR"
    if swiftc *.swift -o traced 2>/dev/null; then
        ./traced 2>/dev/null || echo '{"edges":[]}'
    else
        empty_result "swift compilation failed"
    fi
}

# ── Dart ─────────────────────────────────────────────────────────────────
trace_dart() {
    if ! command -v dart &>/dev/null; then
        empty_result "dart not available"
    fi

    cp "$FIXTURE_DIR"/*.dart "$TMP_DIR/"

    # Create trace support library
    cat > "$TMP_DIR/trace_support.dart" <<'DARTTRACE'
class _Edge {
  final String sourceName, sourceFile, targetName, targetFile;
  _Edge(this.sourceName, this.sourceFile, this.targetName, this.targetFile);
}

class CallTracer {
  static final CallTracer instance = CallTracer._();
  CallTracer._();

  final List<_Edge> _edges = [];
  final Set<String> _seen = {};
  final List<Map<String, String>> _stack = [];

  void traceCall(String name, String file) {
    if (_stack.isNotEmpty) {
      final caller = _stack.last;
      final key = '${caller["name"]}@${caller["file"]}->$name@$file';
      if (!_seen.contains(key)) {
        _seen.add(key);
        _edges.add(_Edge(caller["name"]!, caller["file"]!, name, file));
      }
    }
    _stack.add({"name": name, "file": file});
  }

  void traceReturn() {
    if (_stack.isNotEmpty) _stack.removeLast();
  }

  void dump() {
    final sb = StringBuffer();
    sb.writeln('{');
    sb.writeln('  "edges": [');
    for (var i = 0; i < _edges.length; i++) {
      final e = _edges[i];
      sb.writeln('    {');
      sb.writeln('      "source_name": "${e.sourceName}",');
      sb.writeln('      "source_file": "${e.sourceFile}",');
      sb.writeln('      "target_name": "${e.targetName}",');
      sb.writeln('      "target_file": "${e.targetFile}"');
      sb.write('    }');
      if (i < _edges.length - 1) sb.write(',');
      sb.writeln();
    }
    sb.writeln('  ]');
    sb.writeln('}');
    print(sb);
  }
}
DARTTRACE

    # Add import of trace_support to all dart files
    for dartfile in "$TMP_DIR"/*.dart; do
        base="$(basename "$dartfile")"
        [[ "$base" == "trace_support.dart" ]] && continue
        sedi "1s|^|import 'trace_support.dart';\n|" "$dartfile"
    done

    # Inject traceCall into function/method bodies
    for dartfile in "$TMP_DIR"/*.dart; do
        base="$(basename "$dartfile")"
        [[ "$base" == "trace_support.dart" ]] && continue
        local current_class=""
        local tmpfile="$(mktemp)"

        while IFS= read -r line || [[ -n "$line" ]]; do
            local trimmed="${line#"${line%%[![:space:]]*}"}"
            # Track class
            if [[ "$trimmed" =~ ^class[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) ]]; then
                current_class="${BASH_REMATCH[1]}"
            fi
            if [[ "$trimmed" == "}" && -n "$current_class" ]] && [[ ! "$line" =~ ^[[:space:]] ]]; then
                printf '%s\n' "$line" >> "$tmpfile"
                current_class=""
                continue
            fi
            # Detect function declarations (return_type name(args) {)
            if [[ "$trimmed" =~ [[:space:]]([a-zA-Z_][a-zA-Z0-9_]*)\( ]] && [[ "$trimmed" =~ \{[[:space:]]*$ ]] && [[ ! "$trimmed" =~ ^(import|if|while|for|switch|catch|class) ]]; then
                local fname="${BASH_REMATCH[1]}"
                local qualname="$fname"
                if [[ -n "$current_class" ]]; then
                    qualname="${current_class}.${fname}"
                fi
                printf '%s\n' "$line" >> "$tmpfile"
                printf '    CallTracer.instance.traceCall("%s", "%s"); try {\n' "$qualname" "$base" >> "$tmpfile"
                continue
            fi
            printf '%s\n' "$line" >> "$tmpfile"
        done < "$dartfile"
        mv "$tmpfile" "$dartfile"
    done

    # Inject dump at end of main
    sedi '/^void main/,/^\}/ {
        /^\}/ i\  CallTracer.instance.dump();
    }' "$TMP_DIR/main.dart" 2>/dev/null || true

    # Redirect print to stderr in fixture files
    for dartfile in "$TMP_DIR"/*.dart; do
        base="$(basename "$dartfile")"
        [[ "$base" == "trace_support.dart" ]] && continue
        [[ "$base" == "main.dart" ]] && continue
        sedi 's/print(/stderr.writeln(/g' "$dartfile" 2>/dev/null || true
    done

    cd "$TMP_DIR"
    if dart run main.dart 2>/dev/null; then
        true  # output already printed
    else
        echo '{"edges":[],"error":"dart execution failed"}'
    fi
}

# ── Zig ──────────────────────────────────────────────────────────────────
trace_zig() {
    if ! command -v zig &>/dev/null; then
        empty_result "zig not available"
    fi

    cp "$FIXTURE_DIR"/*.zig "$TMP_DIR/"

    # Create trace support module
    cat > "$TMP_DIR/trace_support.zig" <<'ZIGTRACE'
const std = @import("std");

const Edge = struct {
    source_name: []const u8,
    source_file: []const u8,
    target_name: []const u8,
    target_file: []const u8,
};

const MAX_EDGES = 256;
const MAX_STACK = 64;

var edges: [MAX_EDGES]Edge = undefined;
var edge_count: usize = 0;
var stack_names: [MAX_STACK][]const u8 = undefined;
var stack_files: [MAX_STACK][]const u8 = undefined;
var stack_depth: usize = 0;

pub fn traceCall(name: []const u8, file: []const u8) void {
    if (stack_depth > 0 and edge_count < MAX_EDGES) {
        const caller_name = stack_names[stack_depth - 1];
        const caller_file = stack_files[stack_depth - 1];
        edges[edge_count] = Edge{
            .source_name = caller_name,
            .source_file = caller_file,
            .target_name = name,
            .target_file = file,
        };
        edge_count += 1;
    }
    if (stack_depth < MAX_STACK) {
        stack_names[stack_depth] = name;
        stack_files[stack_depth] = file;
        stack_depth += 1;
    }
}

pub fn traceReturn() void {
    if (stack_depth > 0) stack_depth -= 1;
}

pub fn dumpTrace() void {
    const stdout = std.io.getStdOut().writer();
    stdout.print("{{\n  \"edges\": [\n", .{}) catch return;
    var i: usize = 0;
    while (i < edge_count) : (i += 1) {
        const e = edges[i];
        stdout.print("    {{\n", .{}) catch return;
        stdout.print("      \"source_name\": \"{s}\",\n", .{e.source_name}) catch return;
        stdout.print("      \"source_file\": \"{s}\",\n", .{e.source_file}) catch return;
        stdout.print("      \"target_name\": \"{s}\",\n", .{e.target_name}) catch return;
        stdout.print("      \"target_file\": \"{s}\"\n", .{e.target_file}) catch return;
        if (i < edge_count - 1) {
            stdout.print("    }},\n", .{}) catch return;
        } else {
            stdout.print("    }}\n", .{}) catch return;
        }
    }
    stdout.print("  ]\n}}\n", .{}) catch return;
}
ZIGTRACE

    # Inject traceCall into fn bodies
    for zigfile in "$TMP_DIR"/*.zig; do
        base="$(basename "$zigfile")"
        [[ "$base" == "trace_support.zig" ]] && continue

        # Add import of trace_support at top
        sedi "1s|^|const trace_support = @import(\"trace_support.zig\");\n|" "$zigfile"

        # Use bash loop to inject trace calls
        local tmpfile="$(mktemp)"
        while IFS= read -r line || [[ -n "$line" ]]; do
            local trimmed="${line#"${line%%[![:space:]]*}"}"
            if [[ "$trimmed" =~ ^(pub[[:space:]]+)?fn[[:space:]]+([a-zA-Z_][a-zA-Z0-9_]*) ]] && [[ "$trimmed" =~ \{[[:space:]]*$ ]]; then
                local fname="${BASH_REMATCH[2]}"
                printf '%s\n' "$line" >> "$tmpfile"
                printf '    trace_support.traceCall("%s", "%s"); defer trace_support.traceReturn();\n' "$fname" "$base" >> "$tmpfile"
                continue
            fi
            printf '%s\n' "$line" >> "$tmpfile"
        done < "$zigfile"
        mv "$tmpfile" "$zigfile"
    done

    # Inject dump at end of main
    sedi '/^pub fn main/,/^\}/ {
        /^\}/ i\    trace_support.dumpTrace();
    }' "$TMP_DIR/main.zig" 2>/dev/null || true

    cd "$TMP_DIR"
    if zig build-exe main.zig 2>/dev/null; then
        ./main 2>/dev/null || echo '{"edges":[]}'
    else
        empty_result "zig compilation failed"
    fi
}

# ── Haskell ──────────────────────────────────────────────────────────────
trace_haskell() {
    if ! command -v ghc &>/dev/null; then
        empty_result "ghc not available"
    fi

    cp "$FIXTURE_DIR"/*.hs "$TMP_DIR/"
    cd "$TMP_DIR"

    # Compile with profiling — -fprof-auto instruments every function as a
    # cost centre.  Running with +RTS -p produces a .prof file whose
    # indentation-tree encodes caller→callee relationships.
    if ! ghc -prof -fprof-auto -fprof-cafs -rtsopts Main.hs -o traced 2>/dev/null; then
        empty_result "ghc profiling compilation failed"
    fi

    ./traced +RTS -p -RTS 2>/dev/null || true

    local prof_file
    prof_file="$(ls *.prof 2>/dev/null | head -1)"
    if [[ -z "$prof_file" || ! -s "$prof_file" ]]; then
        empty_result "no .prof output produced"
    fi

    # Parse the cost-centre tree from the .prof file.
    # Lines look like:  "  createUser   Service  Service.hs:20:1-47  ..."
    # Indentation depth encodes the call tree — deeper = callee of shallower.
    # We track a stack of (indent, name, module) and emit edges when a child
    # appears under a parent.
    awk '
    BEGIN {
        in_tree = 0
        depth = 0
        print "{\"edges\":["
        first = 1
    }
    # The tree section starts after the header row containing "COST CENTRE"
    # and the dashed separator line.
    /^COST CENTRE/ { in_tree = 1; next }
    in_tree && /^-+/ { next }
    !in_tree { next }
    # blank line ends the tree section
    /^[[:space:]]*$/ && in_tree { in_tree = 0; next }
    in_tree {
        # Count leading spaces to determine depth
        match($0, /^[[:space:]]*/);
        indent = RLENGTH

        name   = $1
        modul  = $2
        src    = $3

        # Extract filename from src (e.g. "Service.hs:20:1-47" → "Service.hs")
        split(src, parts, ":")
        file = parts[1]

        # Skip CAF and MAIN entries
        if (name == "CAF" || name == "MAIN" || name == "main" && modul == "GHC.Internal.TopHandler") next

        # Pop stack entries with indent >= current (siblings or deeper)
        while (depth > 0 && stack_indent[depth] >= indent) {
            depth--
        }

        # If there is a parent, emit an edge
        if (depth > 0) {
            caller_name = stack_name[depth]
            caller_file = stack_file[depth]
            # Deduplicate
            key = caller_name "@" caller_file "->" name "@" file
            if (!(key in seen)) {
                seen[key] = 1
                if (!first) printf ","
                first = 0
                printf "\n    {\"source_name\":\"%s\",\"source_file\":\"%s\",\"target_name\":\"%s\",\"target_file\":\"%s\"}", caller_name, caller_file, name, file
            }
        }

        # Push this entry
        depth++
        stack_name[depth]   = name
        stack_file[depth]   = file
        stack_indent[depth] = indent
    }
    END { print "\n]}" }
    ' "$prof_file"
}

# ── OCaml ────────────────────────────────────────────────────────────────
trace_ocaml() {
    if ! command -v ocamlfind &>/dev/null && ! command -v ocamlopt &>/dev/null; then
        empty_result "ocaml not available"
    fi

    cp "$FIXTURE_DIR"/*.ml "$TMP_DIR/"
    cd "$TMP_DIR"

    # Create trace support module — compiled first (OCaml link order matters).
    # Uses enter-only tracing: each function calls enter() which records the
    # edge from the current stack top. Without exit(), the stack grows — this
    # may produce some false cross-module edges but same-file edges (the goal)
    # are captured correctly because the true caller is on the stack when the
    # callee's enter() fires.
    cat > trace_support.ml << 'OCAML_TRACE'
type edge = {
  source_name : string;
  source_file : string;
  target_name : string;
  target_file : string;
}

let edges : edge list ref = ref []
let seen : (string, bool) Hashtbl.t = Hashtbl.create 64
let call_stack : (string * string) list ref = ref []

let enter name file =
  (match !call_stack with
   | (caller_name, caller_file) :: _ ->
     let key = caller_name ^ "@" ^ caller_file ^ "->" ^ name ^ "@" ^ file in
     if not (Hashtbl.mem seen key) then begin
       Hashtbl.add seen key true;
       edges := { source_name = caller_name; source_file = caller_file;
                  target_name = name; target_file = file } :: !edges
     end
   | [] -> ());
  call_stack := (name, file) :: !call_stack

let dump () =
  let buf = Buffer.create 256 in
  Buffer.add_string buf "{\"edges\":[";
  let edge_list = List.rev !edges in
  List.iteri (fun i e ->
    if i > 0 then Buffer.add_char buf ',';
    Buffer.add_string buf (Printf.sprintf
      "\n    {\"source_name\":\"%s\",\"source_file\":\"%s\",\"target_name\":\"%s\",\"target_file\":\"%s\"}"
      e.source_name e.source_file e.target_name e.target_file)
  ) edge_list;
  Buffer.add_string buf "\n]}";
  Buffer.contents buf
OCAML_TRACE

    # Inject Trace_support.enter calls after each top-level "let name ... ="
    # OCaml's sequencing (expr1; expr2) works: enter returns unit, then the
    # original body evaluates and returns its value normally.
    for ml_file in *.ml; do
        [[ "$ml_file" == "trace_support.ml" ]] && continue
        local bname
        bname="$(basename "$ml_file")"

        local tmp_out="${ml_file}.tmp"
        while IFS= read -r line; do
            echo "$line"
            # Match "let name ... =" but not "let () =" (main entry) or
            # "let name : type" (type annotations without body on this line)
            if echo "$line" | grep -qP '^let\s+[a-z_][a-z_0-9]*\s.*=\s*$'; then
                local fname
                fname="$(echo "$line" | sed -E 's/^let[[:space:]]+([a-z_][a-z_0-9]*).*/\1/')"
                echo "  Trace_support.enter \"$fname\" \"$bname\";"
            fi
        done < "$ml_file" > "$tmp_out"
        mv "$tmp_out" "$ml_file"
    done

    # Inject tracing into main.ml: enter "main" at start, dump at end
    if [[ -f main.ml ]]; then
        sedi 's/^let () =/let () = Trace_support.enter "main" "main.ml";/' main.ml
        echo '' >> main.ml
        echo 'let () = print_string (Trace_support.dump ())' >> main.ml
    fi

    # Compile: trace_support first, then library modules, then main
    local compile_order="trace_support.ml"
    for ml_file in validators.ml repository.ml service.ml; do
        [[ -f "$ml_file" ]] && compile_order="$compile_order $ml_file"
    done
    compile_order="$compile_order main.ml"

    if ocamlfind ocamlopt -package str -linkpkg $compile_order -o traced 2>/dev/null || \
       ocamlopt $compile_order -o traced 2>/dev/null; then
        ./traced 2>/dev/null || echo '{"edges":[]}'
    else
        empty_result "ocaml compilation failed"
    fi
}

# ── Gleam ────────────────────────────────────────────────────────────────
trace_gleam() {
    if ! command -v gleam &>/dev/null; then
        empty_result "gleam not available"
    fi
    empty_result "gleam runtime tracing not yet implemented"
}

# ── Solidity ─────────────────────────────────────────────────────────────
trace_solidity() {
    if ! command -v forge &>/dev/null; then
        empty_result "forge (foundry) not available"
    fi
    empty_result "solidity tracing requires EVM execution environment"
}

# ── Objective-C ──────────────────────────────────────────────────────
trace_objc() {
    # Try clang with Objective-C support
    if ! command -v clang &>/dev/null; then
        empty_result "clang not available"
    fi

    cp "$FIXTURE_DIR"/*.m "$TMP_DIR/" 2>/dev/null || true
    cp "$FIXTURE_DIR"/*.h "$TMP_DIR/" 2>/dev/null || true
    cd "$TMP_DIR"

    if clang -ObjC -framework Foundation *.m -o traced 2>/dev/null; then
        ./traced 2>/dev/null || echo '{"edges":[]}'
    else
        empty_result "objc compilation failed"
    fi
}

# ── CUDA ─────────────────────────────────────────────────────────────
trace_cuda() {
    if ! command -v nvcc &>/dev/null; then
        empty_result "nvcc (CUDA toolkit) not available"
    fi

    cp "$FIXTURE_DIR"/*.cu "$TMP_DIR/" 2>/dev/null || true
    cp "$FIXTURE_DIR"/*.cuh "$TMP_DIR/" 2>/dev/null || true
    cd "$TMP_DIR"

    if nvcc *.cu -o traced 2>/dev/null; then
        ./traced 2>/dev/null || echo '{"edges":[]}'
    else
        empty_result "nvcc compilation failed"
    fi
}

# ── Dispatch ─────────────────────────────────────────────────────────────
case "$LANG" in
    c)        trace_c_cpp "gcc" "c" ;;
    cpp)      trace_c_cpp "g++" "cpp" ;;
    rust)     trace_rust ;;
    csharp)   trace_dotnet "csharp" ;;
    fsharp)   trace_dotnet "fsharp" ;;
    swift)    trace_swift ;;
    dart)     trace_dart ;;
    zig)      trace_zig ;;
    haskell)  trace_haskell ;;
    ocaml)    trace_ocaml ;;
    gleam)    trace_gleam ;;
    solidity) trace_solidity ;;
    objc)     trace_objc ;;
    cuda)     trace_cuda ;;
    verilog)  empty_result "verilog is a hardware description language — no runtime tracing" ;;
    hcl)      empty_result "HCL/Terraform has no callable functions — no runtime tracing" ;;
    *)        empty_result "unknown language: $LANG" ;;
esac
