pub mod types;
pub mod parser_registry;
pub mod extractors;
pub mod parallel;
pub mod import_resolution;
pub mod cycles;
pub mod incremental;
pub mod complexity;
pub mod cfg;
pub mod dataflow;

use napi_derive::napi;
use types::*;

/// Parse a single file and return extracted symbols.
#[napi]
pub fn parse_file(file_path: String, source: String) -> Option<FileSymbols> {
    parallel::parse_file(&file_path, &source)
}

/// Parse multiple files in parallel and return all extracted symbols.
#[napi]
pub fn parse_files(file_paths: Vec<String>, root_dir: String) -> Vec<FileSymbols> {
    parallel::parse_files_parallel(&file_paths, &root_dir)
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
) -> Vec<ResolvedImport> {
    let aliases = aliases.unwrap_or(PathAliases {
        base_url: None,
        paths: vec![],
    });
    import_resolution::resolve_imports_batch(&inputs, &root_dir, &aliases)
}

/// Compute proximity-based confidence for call resolution.
#[napi]
pub fn compute_confidence(
    caller_file: String,
    target_file: String,
    imported_from: Option<String>,
) -> f64 {
    import_resolution::compute_confidence(
        &caller_file,
        &target_file,
        imported_from.as_deref(),
    )
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
