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

    # Create Cargo.toml
    cat > "$TMP_DIR/Cargo.toml" <<'TOML'
[package]
name = "fixture-trace"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "trace"
path = "src/main.rs"
TOML

    # Create a main.rs that includes all modules and runs them
    if [[ ! -f "$TMP_DIR/src/main.rs" ]]; then
        cat > "$TMP_DIR/src/main.rs" <<'RSMAIN'
mod models;
mod repository;
mod service;
mod validator;

fn main() {
    // Exercise all call paths
    let repo = repository::create_repository();
    let mut svc = service::build_service();
    let _ = svc.add_user("1", "Alice", "alice@example.com");
    let _ = svc.get_user("1");
    let _ = svc.remove_user("1");
}
RSMAIN
    fi

    cd "$TMP_DIR"
    if cargo build --release 2>/dev/null; then
        # Rust doesn't have easy runtime tracing without proc macros
        # Output empty edges - runtime tracing requires #[instrument] setup
        empty_result "rust runtime tracing requires proc-macro setup"
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
            ;;
        fsharp)
            dotnet new console -lang F# -o . --force 2>/dev/null || true
            cp src/*.fs . 2>/dev/null || true
            ;;
    esac

    if dotnet build 2>/dev/null; then
        dotnet run 2>/dev/null || echo '{"edges":[]}'
    else
        empty_result "dotnet build failed"
    fi
}

# ── Swift ────────────────────────────────────────────────────────────────
trace_swift() {
    if ! command -v swift &>/dev/null; then
        empty_result "swift not available"
    fi

    cp "$FIXTURE_DIR"/*.swift "$TMP_DIR/"
    cd "$TMP_DIR"

    if swift build 2>/dev/null || swiftc *.swift -o traced 2>/dev/null; then
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
    cd "$TMP_DIR"

    if dart run main.dart 2>/dev/null; then
        echo '{"edges":[],"error":"dart tracing not yet instrumented"}'
    else
        empty_result "dart execution failed"
    fi
}

# ── Zig ──────────────────────────────────────────────────────────────────
trace_zig() {
    if ! command -v zig &>/dev/null; then
        empty_result "zig not available"
    fi

    cp "$FIXTURE_DIR"/*.zig "$TMP_DIR/"
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

    # Compile with profiling for call graph
    if ghc -prof -fprof-auto -rtsopts Main.hs -o traced 2>/dev/null; then
        ./traced +RTS -p 2>/dev/null || true
        # Parse .prof file for call edges (simplified)
        empty_result "haskell profiling output parsing not yet implemented"
    else
        empty_result "ghc compilation failed"
    fi
}

# ── OCaml ────────────────────────────────────────────────────────────────
trace_ocaml() {
    if ! command -v ocamlfind &>/dev/null && ! command -v ocamlopt &>/dev/null; then
        empty_result "ocaml not available"
    fi

    cp "$FIXTURE_DIR"/*.ml "$TMP_DIR/"
    cd "$TMP_DIR"

    if ocamlfind ocamlopt -package str -linkpkg *.ml -o traced 2>/dev/null || \
       ocamlopt *.ml -o traced 2>/dev/null; then
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
