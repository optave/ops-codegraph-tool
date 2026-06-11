//! codegraph-core — native (napi-rs) engine.
//!
//! # Structure parity with the TypeScript engine
//!
//! This crate mirrors the `src/` TypeScript tree so each module has a
//! predictable counterpart in the other engine. When changing resolution or
//! extraction behavior in one engine, apply the equivalent change to the
//! mirrored module in the other (both engines must produce identical results).
//!
//! | Rust module                          | TypeScript counterpart                          |
//! |--------------------------------------|-------------------------------------------------|
//! | `lib.rs`                             | `src/index.ts` (public API surface)             |
//! | `types.rs`                           | `src/types.ts`                                  |
//! | `shared/constants.rs`                | `src/shared/constants.ts`                       |
//! | `infrastructure/config.rs`           | `src/infrastructure/config.ts`                  |
//! | `db/connection.rs`                   | `src/db/connection.ts` + `src/db/migrations.ts` |
//! | `db/repository/*`                    | `src/db/repository/*`                           |
//! | `domain/parser.rs`                   | `src/domain/parser.ts`                          |
//! | `domain/parallel.rs`                 | `src/domain/wasm-worker-pool.ts`                |
//! | `domain/graph/resolve.rs`            | `src/domain/graph/resolve.ts`                   |
//! | `domain/graph/journal.rs`            | `src/domain/graph/journal.ts`                   |
//! | `domain/graph/builder/pipeline.rs`   | `src/domain/graph/builder/pipeline.ts`          |
//! | `domain/graph/builder/incremental.rs`| `src/domain/graph/builder/incremental.ts`       |
//! | `domain/graph/builder/stages/*`      | `src/domain/graph/builder/stages/*`             |
//! | `ast_analysis/*`                     | `src/ast-analysis/*`                            |
//! | `graph/algorithms/*`                 | `src/graph/algorithms/*`                        |
//! | `graph/classifiers/roles.rs`         | `src/graph/classifiers/roles.ts`                |
//! | `features/structure.rs`              | `src/features/structure.ts`                     |
//! | `extractors/*`                       | `src/extractors/*`                              |

pub mod ast_analysis;
pub mod db;
pub mod domain;
pub mod extractors;
pub mod features;
pub mod graph;
pub mod infrastructure;
pub mod shared;
pub mod types;

use napi_derive::napi;
use types::*;

/// Parse a single file and return extracted symbols.
/// When `include_dataflow` is true, dataflow analysis is also extracted.
/// When `include_ast_nodes` is false, AST node walking is skipped for performance.
#[napi]
pub fn parse_file(
    file_path: String,
    source: String,
    include_dataflow: Option<bool>,
    include_ast_nodes: Option<bool>,
) -> Option<FileSymbols> {
    domain::parallel::parse_file(
        &file_path,
        &source,
        include_dataflow.unwrap_or(false),
        include_ast_nodes.unwrap_or(true),
    )
}

/// Parse multiple files in parallel and return all extracted symbols.
/// When `include_dataflow` is true, dataflow analysis is also extracted.
/// When `include_ast_nodes` is false, AST node walking is skipped for performance.
#[napi]
pub fn parse_files(
    file_paths: Vec<String>,
    root_dir: String,
    include_dataflow: Option<bool>,
    include_ast_nodes: Option<bool>,
) -> Vec<FileSymbols> {
    domain::parallel::parse_files_parallel(
        &file_paths,
        &root_dir,
        include_dataflow.unwrap_or(false),
        include_ast_nodes.unwrap_or(true),
    )
}

/// Parse multiple files in parallel with ALL analysis data extracted in a single pass.
/// Always includes: symbols, AST nodes, complexity, CFG, and dataflow.
/// Eliminates the need for any downstream re-parse (WASM or native standalone).
#[napi]
pub fn parse_files_full(
    file_paths: Vec<String>,
    root_dir: String,
) -> Vec<FileSymbols> {
    domain::parallel::parse_files_parallel_full(
        &file_paths,
        &root_dir,
    )
}

/// Resolve a single import path.
#[napi]
pub fn resolve_import(
    from_file: String,
    import_source: String,
    root_dir: String,
    aliases: Option<PathAliases>,
) -> String {
    let aliases = aliases.unwrap_or(PathAliases {
        base_url: None,
        paths: vec![],
    });
    domain::graph::resolve::resolve_import_path(&from_file, &import_source, &root_dir, &aliases)
}

/// Batch resolve multiple imports.
#[napi]
pub fn resolve_imports(
    inputs: Vec<ImportResolutionInput>,
    root_dir: String,
    aliases: Option<PathAliases>,
    known_files: Option<Vec<String>>,
) -> Vec<ResolvedImport> {
    let aliases = aliases.unwrap_or(PathAliases {
        base_url: None,
        paths: vec![],
    });
    let known_set =
        known_files.map(|v| v.into_iter().collect::<std::collections::HashSet<String>>());
    domain::graph::resolve::resolve_imports_batch(&inputs, &root_dir, &aliases, known_set.as_ref())
}

/// Compute proximity-based confidence for call resolution.
#[napi]
pub fn compute_confidence(
    caller_file: String,
    target_file: String,
    imported_from: Option<String>,
) -> f64 {
    domain::graph::resolve::compute_confidence(&caller_file, &target_file, imported_from.as_deref())
}

/// Detect cycles using Tarjan's SCC algorithm.
/// Returns arrays of node names forming each cycle.
#[napi]
pub fn detect_cycles(edges: Vec<GraphEdge>) -> Vec<Vec<String>> {
    graph::algorithms::tarjan::detect_cycles(&edges)
}

/// Returns the engine name.
#[napi]
pub fn engine_name() -> String {
    "native".to_string()
}

/// Returns the engine version (crate version).
#[napi]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Analyze complexity metrics for all functions in the given source.
/// Returns per-function results (name, line, endLine, complexity metrics).
/// When `lang_id` is provided, it takes priority over extension-based detection.
#[napi]
pub fn analyze_complexity(
    source: String,
    file_path: String,
    lang_id: Option<String>,
) -> Vec<types::FunctionComplexityResult> {
    ast_analysis::engine::analyze_complexity_standalone(&source, &file_path, lang_id.as_deref())
}

/// Build control-flow graphs for all functions in the given source.
/// Returns per-function results (name, line, endLine, CFG blocks + edges).
/// When `lang_id` is provided, it takes priority over extension-based detection.
#[napi]
pub fn build_cfg_analysis(
    source: String,
    file_path: String,
    lang_id: Option<String>,
) -> Vec<types::FunctionCfgResult> {
    ast_analysis::engine::build_cfg_standalone(&source, &file_path, lang_id.as_deref())
}

/// Extract dataflow analysis for the given source.
/// Returns file-level dataflow (parameters, returns, assignments, arg flows, mutations).
/// When `lang_id` is provided, it takes priority over extension-based detection.
#[napi]
pub fn extract_dataflow_analysis(
    source: String,
    file_path: String,
    lang_id: Option<String>,
) -> Option<types::DataflowResult> {
    ast_analysis::engine::extract_dataflow_standalone(&source, &file_path, lang_id.as_deref())
}
