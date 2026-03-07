pub mod cfg;
pub mod complexity;
pub mod cycles;
pub mod dataflow;
pub mod extractors;
pub mod import_resolution;
pub mod incremental;
pub mod parallel;
pub mod parser_registry;
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
    parallel::parse_file(
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
    parallel::parse_files_parallel(
        &file_paths,
        &root_dir,
        include_dataflow.unwrap_or(false),
        include_ast_nodes.unwrap_or(true),
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
    import_resolution::resolve_import_path(&from_file, &import_source, &root_dir, &aliases)
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
    import_resolution::resolve_imports_batch(&inputs, &root_dir, &aliases, known_set.as_ref())
}

/// Compute proximity-based confidence for call resolution.
#[napi]
pub fn compute_confidence(
    caller_file: String,
    target_file: String,
    imported_from: Option<String>,
) -> f64 {
    import_resolution::compute_confidence(&caller_file, &target_file, imported_from.as_deref())
}

/// Detect cycles using Tarjan's SCC algorithm.
/// Returns arrays of node names forming each cycle.
#[napi]
pub fn detect_cycles(edges: Vec<GraphEdge>) -> Vec<Vec<String>> {
    cycles::detect_cycles(&edges)
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
