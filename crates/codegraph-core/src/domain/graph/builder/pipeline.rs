//! Full Rust build orchestrator — runs the entire build pipeline with zero
//! napi boundary crossings after the initial `build_graph()` call.
//!
//! Replaces the JS `runPipelineStages()` in `pipeline.ts` when the native
//! engine is available. The JS pipeline remains as the WASM fallback.
//!
//! Pipeline stages (all internal, single rusqlite connection):
//! 1. Deserialize config/aliases/opts
//! 2. Collect files (with gitignore + extension filter)
//! 3. Detect changes (tiered: journal/mtime/hash)
//! 4. Parse files in parallel (existing `parallel::parse_files_parallel`)
//! 5. Insert nodes (existing `insert_nodes::do_insert_nodes`) — file_hashes
//!    for changed files is NOT written here; see step 7
//! 6. Resolve imports (existing `resolve::resolve_imports_batch`)
//!    6b. Re-parse barrel candidates (incremental only)
//! 7. Build import edges + call edges + barrel resolution, then commit
//!    file_hashes for changed files (`insert_nodes::commit_file_hashes`) now
//!    that their edges match this revision (#1731)
//! 8. Structure metrics + role classification
//! 9. Finalize (metadata, journal)
//!
//! Steps 5 and 7 propagate write failures via `?` instead of discarding
//! them: a transaction that never started (or never committed) for nodes or
//! edges now aborts `run_pipeline` with `Err`, which `NativeDatabase::build_graph`
//! turns into a thrown napi error. The JS caller (`tryNativeOrchestrator`)
//! already catches that and falls back to the JS/WASM pipeline, so a write
//! failure now triggers a real retry instead of a "successful" build over an
//! incomplete graph (#1827).

use crate::db::repository::ast::{self, AstInsertNode, FileAstBatch};
use crate::domain::graph::builder::entrypoints;
use crate::domain::graph::builder::stages::collect_files;
use crate::domain::graph::builder::stages::detect_changes;
use crate::domain::graph::builder::stages::import_edges::{self, ImportEdgeContext};
use crate::domain::graph::journal;
use crate::domain::graph::resolve;
use crate::domain::parallel;
use crate::features::structure;
use crate::graph::classifiers::roles;
use crate::infrastructure::config::{BuildConfig, BuildOpts, BuildPathAliases};
use crate::shared::constants::{FAST_PATH_MAX_CHANGED_FILES, FAST_PATH_MIN_EXISTING_FILES};
use crate::types::{FileSymbols, ImportResolutionInput, TypeMapEntry};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

/// Per-file return-type index: `rel_path → (fn_name → (type_name, confidence))`.
type ReturnTypeIndex = HashMap<String, HashMap<String, (String, f64)>>;

/// Flat map for qualified `Type.method` lookups: `qualified_name → (type_name, confidence)`.
type GlobalReturnTypes = HashMap<String, (String, f64)>;

/// Timing result for each pipeline phase (returned as JSON to JS).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTiming {
    pub setup_ms: f64,
    pub collect_ms: f64,
    pub detect_ms: f64,
    pub parse_ms: f64,
    pub insert_ms: f64,
    pub resolve_ms: f64,
    pub edges_ms: f64,
    pub structure_ms: f64,
    pub roles_ms: f64,
    pub ast_ms: f64,
    pub complexity_ms: f64,
    pub cfg_ms: f64,
    pub dataflow_ms: f64,
    pub finalize_ms: f64,
}

/// Result of the build pipeline.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildPipelineResult {
    pub phases: PipelineTiming,
    pub node_count: i64,
    pub edge_count: i64,
    pub file_count: usize,
    pub early_exit: bool,
    /// Analysis scope: files whose content genuinely changed (reverse-dep-only
    /// files excluded). `None` for full builds (all files), `Some` for
    /// incremental builds. Consumers (e.g. the JS analysis phase) use this to
    /// scope expensive AST/complexity/CFG/dataflow work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_files: Option<Vec<String>>,
    pub changed_count: usize,
    pub removed_count: usize,
    pub is_full_build: bool,
    /// Whether the Rust pipeline handled the structure phase (directory nodes,
    /// contains edges, file and directory metrics). Always true — the Rust
    /// pipeline handles both the small-incremental fast path and full builds.
    pub structure_handled: bool,
    /// Whether the Rust pipeline wrote AST/complexity/CFG/dataflow to the DB.
    /// When true, the JS caller can skip `runPostNativeAnalysis` entirely.
    pub analysis_complete: bool,
}

/// Normalize path to forward slashes.
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// Make a path relative to root_dir, normalized.
fn relative_path(root_dir: &str, abs_path: &str) -> String {
    let root = Path::new(root_dir);
    let abs = Path::new(abs_path);
    match abs.strip_prefix(root) {
        Ok(rel) => normalize_path(rel.to_str().unwrap_or("")),
        Err(_) => normalize_path(abs_path),
    }
}

/// Deserialized pipeline inputs assembled in Stage 1.
struct PipelineSetup {
    config: BuildConfig,
    napi_aliases: crate::types::PathAliases,
    opts: BuildOpts,
    incremental: bool,
    include_dataflow: bool,
    include_ast: bool,
    force_full_rebuild: bool,
    /// Monorepo workspace packages, keyed by package name. Detected by the JS
    /// caller (`detectWorkspaces()` in infrastructure/config.ts — no Rust
    /// equivalent; see `resolve::resolve_via_workspace`'s doc comment) and
    /// serialized alongside aliases/opts. Empty when the project has no
    /// workspace config (issue #1927).
    workspaces: HashMap<String, resolve::WorkspaceEntry>,
}

fn pipeline_setup(
    conn: &Connection,
    config_json: &str,
    aliases_json: &str,
    opts_json: &str,
    workspaces_json: &str,
) -> Result<PipelineSetup, String> {
    let config: BuildConfig =
        serde_json::from_str(config_json).map_err(|e| format!("config parse error: {e}"))?;
    let aliases: BuildPathAliases =
        serde_json::from_str(aliases_json).map_err(|e| format!("aliases parse error: {e}"))?;
    let opts: BuildOpts =
        serde_json::from_str(opts_json).map_err(|e| format!("opts parse error: {e}"))?;
    let workspace_packages: Vec<crate::types::WorkspacePackage> =
        if workspaces_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(workspaces_json)
                .map_err(|e| format!("workspaces parse error: {e}"))?
        };

    let napi_aliases = aliases.to_napi_aliases();
    let incremental = opts.incremental.unwrap_or(config.build.incremental);
    let include_dataflow = opts.dataflow.unwrap_or(true);
    let include_ast = opts.ast.unwrap_or(true);
    let force_full_rebuild = check_version_mismatch(conn);
    let workspaces = resolve::workspaces_from_packages(&workspace_packages);
    // Reset once per build, mirroring `setWorkspaces()`'s
    // `_workspaceResolvedPaths.clear()`/`clearExportsCache()` in resolve.ts —
    // must happen before Stage 6/6b resolve any imports below. Clearing the
    // exports cache here too matters for a long-lived native process (MCP
    // server, watch mode) running multiple builds: a dependency's
    // `package.json` can change between builds (issue #2060). This pipeline
    // calls `resolve::resolve_imports_batch` directly, bypassing lib.rs's
    // NAPI `resolve_imports` wrapper (and its own cache-clearing) entirely —
    // so the Cargo target-override cache needs the same explicit reset here
    // for repeated native full builds in the same process (issue #2217), and
    // likewise the Python import-root caches (pyproject-configured roots and
    // layout-derived package roots) for the same reason: a repeated native
    // full build in the same process (MCP server, or any programmatic caller
    // invoking the native pipeline more than once) could otherwise resolve
    // `apply_pyproject_script_attribution`'s script targets against roots
    // that predate a `pyproject.toml` root-config edit (issue #2408 review).
    resolve::reset_workspace_resolved_paths();
    resolve::clear_exports_cache();
    resolve::clear_cargo_target_overrides_cache();
    resolve::clear_python_import_roots_cache();

    Ok(PipelineSetup {
        config,
        napi_aliases,
        opts,
        incremental,
        include_dataflow,
        include_ast,
        force_full_rebuild,
        workspaces,
    })
}

/// Build a no-op early-exit result when no source files changed and we are
/// in an incremental build with no removals. Mirrors the early-exit branch
/// in `run_pipeline` exactly so it can be lifted out without behaviour change.
fn early_exit_result(
    file_count: usize,
    timing: PipelineTiming,
    conn: &Connection,
    journal_dir: &str,
    metadata_updates: &[detect_changes::MetadataUpdate],
) -> BuildPipelineResult {
    detect_changes::heal_metadata(conn, metadata_updates);
    journal::write_journal_header(journal_dir, now_ms());
    BuildPipelineResult {
        phases: timing,
        node_count: 0,
        edge_count: 0,
        file_count,
        early_exit: true,
        changed_files: Some(vec![]),
        changed_count: 0,
        removed_count: 0,
        is_full_build: false,
        structure_handled: true,
        analysis_complete: true,
    }
}

/// `(saved_reverse_dep_edges, saved_sibling_groups, removal_reverse_deps,
/// removed_file_neighbors)` — see `save_and_purge_changed`.
type SaveAndPurgeResult = (
    Vec<detect_changes::SavedReverseDepEdge>,
    HashMap<detect_changes::SiblingGroupKey, Vec<i64>>,
    Vec<String>,
    Vec<String>,
);

/// Save reverse-dep edges (and reverse-deps of removed files) before purging
/// changed files. Mirrors the JS save-then-purge sequence in `build-edges.ts`
/// (#1012). Returns `(saved_reverse_dep_edges, saved_sibling_groups,
/// removal_reverse_deps, removed_file_neighbors)` so the pipeline can
/// reconnect edges after Stage 5, reclassify roles in Stage 8, and (#1839)
/// fold a removed file's cross-directory neighbors into Stage 8's
/// directory-metrics refresh.
fn save_and_purge_changed(
    conn: &Connection,
    parse_changes: &[&detect_changes::ChangedFile],
    change_result: &detect_changes::ChangeResult,
    opts: &BuildOpts,
    root_dir: &str,
) -> SaveAndPurgeResult {
    let mut saved_reverse_dep_edges: Vec<detect_changes::SavedReverseDepEdge> = Vec::new();
    let mut saved_sibling_groups: HashMap<detect_changes::SiblingGroupKey, Vec<i64>> =
        HashMap::new();
    let mut removal_reverse_deps: Vec<String> = Vec::new();

    if change_result.is_full_build {
        let has_embeddings = detect_changes::has_embeddings(conn);
        detect_changes::clear_all_graph_data(conn, has_embeddings);
        // A full rebuild re-parses every currently-existing file from
        // scratch, so none of them are "deleted" — clear any stale advisory
        // left over from a prior removal at these paths before this build's
        // fresh parse reinserts them. Without this, a file that was deleted
        // (capturing an advisory), reappeared with fewer/no exports, and is
        // later deleted again would resurface the OLD (pre-reappearance)
        // advisory snapshot instead of a fresh one, misattributing a stale
        // violation (#1938). Mirrors the TS `handleFullBuild` fix.
        let changed_paths: Vec<String> = parse_changes.iter().map(|c| c.rel_path.clone()).collect();
        detect_changes::clear_deleted_export_advisories(conn, &changed_paths);
        return (
            saved_reverse_dep_edges,
            saved_sibling_groups,
            removal_reverse_deps,
            Vec::new(),
        );
    }

    let changed_paths: Vec<String> = parse_changes.iter().map(|c| c.rel_path.clone()).collect();

    if !opts.no_reverse_deps.unwrap_or(false) {
        (saved_reverse_dep_edges, saved_sibling_groups) =
            detect_changes::save_reverse_dep_edges(conn, &changed_paths);

        if !change_result.removed.is_empty() {
            let removed_set: HashSet<String> = change_result.removed.iter().cloned().collect();
            removal_reverse_deps =
                detect_changes::find_reverse_dependencies(conn, &removed_set, root_dir)
                    .into_iter()
                    .collect();
        }
    }

    // Capture removed files' cross-directory neighbor set BEFORE purging —
    // both directions of their import edges are deleted below, so this is
    // the last point they can still be discovered from live evidence (#1839).
    let removed_file_neighbors =
        detect_changes::capture_removed_file_neighbors(conn, &change_result.removed);

    // No entrypoint-specific capture is needed before the purge below
    // (#2428): purging a removed file drops its `entrypoint_calls` evidence
    // with it, so `apply_entrypoint_attribution` simply finds nothing to
    // re-mark its targets from and clears them. #2411's pre-purge clear step
    // existed only because the flag was written straight onto the target,
    // leaving nothing a later stage could re-derive it from.

    // A file about to be (re)inserted can no longer be "deleted" — clear any
    // stale advisory left over from a prior removal at this same path before
    // capturing this build's actual removals, and before purging deletes the
    // live evidence `record_deleted_export_advisories` reads (#1938).
    detect_changes::clear_deleted_export_advisories(conn, &changed_paths);
    detect_changes::record_deleted_export_advisories(conn, &change_result.removed);

    let files_to_purge: Vec<String> = change_result
        .removed
        .iter()
        .chain(parse_changes.iter().map(|c| &c.rel_path))
        .cloned()
        .collect();
    detect_changes::purge_changed_files(conn, &files_to_purge, &[]);

    (
        saved_reverse_dep_edges,
        saved_sibling_groups,
        removal_reverse_deps,
        removed_file_neighbors,
    )
}

/// Parse a changed-file slice in parallel and key the results by relative path.
fn parse_and_index_files(
    parse_changes: &[&detect_changes::ChangedFile],
    root_dir: &str,
    include_dataflow: bool,
    include_ast: bool,
) -> BTreeMap<String, FileSymbols> {
    let files_to_parse: Vec<String> = parse_changes.iter().map(|c| c.abs_path.clone()).collect();
    let parsed =
        parallel::parse_files_parallel(&files_to_parse, root_dir, include_dataflow, include_ast);
    let mut file_symbols: BTreeMap<String, FileSymbols> = BTreeMap::new();
    for mut sym in parsed {
        let rel = relative_path(root_dir, &sym.file);
        sym.file = rel.clone();
        file_symbols.insert(rel, sym);
    }
    file_symbols
}

/// Build the batched import-resolution input set and run resolution, returning
/// `(batch_resolved, known_files)`. Mirrors stage 6 of `run_pipeline`.
fn resolve_pipeline_imports(
    file_symbols: &BTreeMap<String, FileSymbols>,
    collect_files: &[String],
    root_dir: &str,
    napi_aliases: &crate::types::PathAliases,
    workspaces: &HashMap<String, resolve::WorkspaceEntry>,
) -> (HashMap<String, String>, HashSet<String>) {
    let mut batch_inputs: Vec<ImportResolutionInput> = Vec::new();
    for (rel_path, symbols) in file_symbols {
        let abs_file = Path::new(root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("").replace('\\', "/");
        for imp in &symbols.imports {
            // Skip CJS require bindings — they feed imported_names for receiver-edge
            // resolution but must not produce DB import edges (#1678).
            if imp.cjs_require.unwrap_or(false) {
                continue;
            }
            batch_inputs.push(ImportResolutionInput {
                from_file: abs_str.clone(),
                import_source: imp.source.clone(),
            });
        }
    }
    let known_files: HashSet<String> = collect_files
        .iter()
        .map(|f| relative_path(root_dir, f))
        .collect();
    let resolved = resolve::resolve_imports_batch(
        &batch_inputs,
        root_dir,
        napi_aliases,
        Some(&known_files),
        Some(workspaces),
    );
    let mut batch_resolved: HashMap<String, String> = HashMap::new();
    for r in &resolved {
        let key = format!("{}|{}", r.from_file, r.import_source);
        batch_resolved.insert(key, r.resolved_path.clone());
    }
    (batch_resolved, known_files)
}

/// Reconnect any saved reverse-dep edges to the new target node IDs (#1012).
fn reconnect_saved_reverse_dep_edges(
    conn: &Connection,
    saved: &[detect_changes::SavedReverseDepEdge],
    saved_sibling_groups: &HashMap<detect_changes::SiblingGroupKey, Vec<i64>>,
    max_align_group_size: usize,
) {
    if saved.is_empty() {
        return;
    }
    let (reconnected, dropped) = detect_changes::reconnect_reverse_dep_edges(
        conn,
        saved,
        saved_sibling_groups,
        max_align_group_size,
    );
    if dropped > 0 {
        eprintln!(
            "[codegraph] reconnect_reverse_dep_edges: {reconnected} reconnected, {dropped} dropped (target nodes not found)"
        );
    }
}

/// Stage 8 (structure): decide between the fast incremental path and a full
/// structure rebuild based on the same gates as the JS pipeline. The change
/// set is read from `file_symbols.keys()` because only truly-changed files
/// are present (reverse-deps are reconnected, not re-parsed).
///
/// `removed_files` is threaded through separately from `parse_changes_len`
/// (which only counts re-parsed files) so the fast path's directory-metrics
/// refresh also covers files deleted from a directory, not just files added
/// or modified within it (#1738). `removed_file_neighbors` — the
/// cross-directory import neighbors of `removed_files`, captured before they
/// were purged — lets that refresh also reach a directory whose only link to
/// the touched set was an edge to/from one of those removed files (#1839).
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical build-pipeline phase (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn run_structure_phase(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    collect_directories: &HashSet<String>,
    root_dir: &str,
    line_count_map: &HashMap<String, i64>,
    parse_changes_len: usize,
    removed_files: &[String],
    removed_file_neighbors: &[String],
    is_full_build: bool,
) {
    let changed_files: Vec<String> = file_symbols.keys().cloned().collect();
    let existing_file_count = structure::get_existing_file_count(conn);
    let use_fast_path = !is_full_build
        && parse_changes_len <= FAST_PATH_MAX_CHANGED_FILES
        && existing_file_count > FAST_PATH_MIN_EXISTING_FILES;

    if use_fast_path {
        structure::update_changed_file_metrics(conn, &changed_files, line_count_map, file_symbols);
        structure::refresh_affected_directory_metrics(
            conn,
            &changed_files,
            removed_files,
            removed_file_neighbors,
        );
    } else {
        let changed_for_structure: Option<Vec<String>> = if is_full_build {
            None
        } else {
            Some(changed_files.clone())
        };
        structure::build_full_structure(
            conn,
            file_symbols,
            collect_directories,
            root_dir,
            line_count_map,
            changed_for_structure.as_deref(),
        );
    }
}

/// Stage 8 (roles): classify roles for the affected file set. Removal
/// reverse-deps need to be seeded explicitly because their fan-in/out can
/// no longer be discovered via neighbour expansion once the deleted file's
/// nodes are gone (#1027).
fn run_role_classification(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    removal_reverse_deps: Vec<String>,
    is_full_build: bool,
    root_dir: &str,
) {
    // Program-entrypoint flags must be current before roles are computed, and
    // the edges they are derived from are complete by this stage — the same
    // position the TS path uses (end of `buildEdges`, before `buildStructure`).
    // The returned files are folded in below alongside `removal_reverse_deps`
    // — same reason: a touched target's role can't be trusted to be
    // rediscovered by neighbour expansion.
    let mut entrypoint_touched_files =
        entrypoints::apply_entrypoint_attribution(conn, file_symbols);
    // #2408: pyproject.toml is re-read fresh every build (no evidence table),
    // so this must run unconditionally regardless of which files changed —
    // a script target's own file rebuilding, or nothing changing at all
    // and only pyproject.toml being edited, are both cases that need it.
    // `known_files: None` falls back to real filesystem checks — correct for
    // an actual build, where a resolved target genuinely exists on disk, and
    // avoids threading the collected-file set through an extra parameter for
    // what is a once-per-build (not once-per-file) resolution.
    entrypoint_touched_files.extend(entrypoints::apply_pyproject_script_attribution(
        conn, root_dir, None,
    ));

    let changed_files: Vec<String> = file_symbols.keys().cloned().collect();
    let changed_file_list: Option<Vec<String>> = if is_full_build {
        None
    } else {
        let mut files = changed_files;
        let mut seen: HashSet<String> = files.iter().cloned().collect();
        for f in removal_reverse_deps
            .into_iter()
            .chain(entrypoint_touched_files)
        {
            if seen.insert(f.clone()) {
                files.push(f);
            }
        }
        Some(files)
    };
    if let Some(ref files) = changed_file_list {
        if !files.is_empty() {
            let _ = roles::do_classify_incremental(conn, files);
        }
    } else {
        let _ = roles::do_classify_full(conn);
    }
}

/// Return type for [`run_analysis_persistence`]. Using a named struct avoids
/// the silent positional-swap bug that a `(bool, bool)` tuple allows.
struct AnalysisPersistenceResult {
    /// Whether any analysis phase was requested (`include_ast | include_dataflow | …`).
    ran: bool,
    /// Whether every requested phase succeeded.
    ok: bool,
}

/// Stage 8b: persist AST, complexity, CFG, and dataflow data for the
/// analysis scope.
fn run_analysis_persistence(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    analysis_scope: Option<&Vec<String>>,
    opts: &BuildOpts,
    include_ast: bool,
    include_dataflow: bool,
    timing: &mut PipelineTiming,
) -> AnalysisPersistenceResult {
    let include_complexity = opts.complexity.unwrap_or(true);
    let include_cfg = opts.cfg.unwrap_or(true);
    let do_analysis = include_ast || include_dataflow || include_cfg || include_complexity;
    if !do_analysis {
        return AnalysisPersistenceResult {
            ran: false,
            ok: true,
        };
    }

    let analysis_file_set: HashSet<&str> = match analysis_scope {
        Some(files) => files.iter().map(|s| s.as_str()).collect(),
        None => file_symbols.keys().map(|s| s.as_str()).collect(),
    };

    let node_id_map = build_analysis_node_map(conn, &analysis_file_set);
    let mut analysis_ok = true;

    if include_ast {
        let t0 = Instant::now();
        let ast_batches = build_ast_batches(file_symbols, &analysis_file_set);
        if ast::do_insert_ast_nodes(conn, &ast_batches).is_err() {
            analysis_ok = false;
        }
        timing.ast_ms = t0.elapsed().as_secs_f64() * 1000.0;
    }
    if include_complexity {
        let t0 = Instant::now();
        if !write_complexity(conn, file_symbols, &analysis_file_set, &node_id_map) {
            analysis_ok = false;
        }
        timing.complexity_ms = t0.elapsed().as_secs_f64() * 1000.0;
    }
    if include_cfg {
        let t0 = Instant::now();
        if !write_cfg(conn, file_symbols, &analysis_file_set, &node_id_map) {
            analysis_ok = false;
        }
        timing.cfg_ms = t0.elapsed().as_secs_f64() * 1000.0;
    }
    if include_dataflow {
        let t0 = Instant::now();
        if !write_dataflow(conn, file_symbols, &analysis_file_set) {
            analysis_ok = false;
        }
        timing.dataflow_ms = t0.elapsed().as_secs_f64() * 1000.0;
    }

    AnalysisPersistenceResult {
        ran: do_analysis,
        ok: analysis_ok,
    }
}

/// Run the full build pipeline in Rust.
///
/// Called from `NativeDatabase.build_graph()` via napi. `db_path` is the
/// database's actual on-disk path — `self.db_path()` on the caller, already
/// resolved from a caller-supplied `dbPath` override or the
/// `root_dir/.codegraph/graph.db` default. The incremental-build journal
/// must live alongside the database (`Path::new(db_path).parent()`), never
/// unconditionally under `root_dir` — otherwise a build targeting a custom
/// `dbPath` writes a stray `.codegraph/` into `root_dir` that the actual
/// database never uses (#2426).
pub fn run_pipeline(
    conn: &Connection,
    root_dir: &str,
    db_path: &str,
    config_json: &str,
    aliases_json: &str,
    opts_json: &str,
    workspaces_json: &str,
) -> Result<BuildPipelineResult, String> {
    let total_start = Instant::now();
    let mut timing = PipelineTiming::default();

    // The journal always travels with the database, not root_dir — see this
    // function's doc comment (#2426).
    let journal_dir = Path::new(db_path)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or(root_dir);

    // ── Stage 1: Deserialize config ────────────────────────────────────
    let t0 = Instant::now();
    let setup = pipeline_setup(conn, config_json, aliases_json, opts_json, workspaces_json)?;
    let PipelineSetup {
        config,
        napi_aliases,
        opts,
        incremental,
        include_dataflow,
        include_ast,
        force_full_rebuild,
        workspaces,
    } = setup;
    timing.setup_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 2: Collect files ─────────────────────────────────────────
    let t0 = Instant::now();
    // For scoped builds, track all scoped relative paths (including deleted files)
    // so detect_removed_files only flags scoped files as removed, not everything.
    let scoped_rel_paths: Option<HashSet<String>> = opts
        .scope
        .as_ref()
        .map(|scope| scope.iter().map(|f| normalize_path(f)).collect());
    let collect_result = collect_source_files(
        conn,
        root_dir,
        &config,
        &opts,
        incremental,
        force_full_rebuild,
        journal_dir,
    );
    timing.collect_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 3: Detect changes ────────────────────────────────────────
    let t0 = Instant::now();
    let change_result = detect_changes::detect_changes(
        conn,
        &collect_result.files,
        root_dir,
        incremental,
        force_full_rebuild,
        scoped_rel_paths.as_ref(),
        journal_dir,
    )?;
    timing.detect_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // Filter out metadata-only changes
    let parse_changes: Vec<&detect_changes::ChangedFile> = change_result
        .changed
        .iter()
        .filter(|c| !c.metadata_only)
        .collect();

    // Early exit: no changes
    if !change_result.is_full_build && parse_changes.is_empty() && change_result.removed.is_empty()
    {
        return Ok(early_exit_result(
            collect_result.files.len(),
            timing,
            conn,
            journal_dir,
            &change_result.metadata_updates,
        ));
    }

    // Stage 3b: save reverse-dep edges (incremental) or clear all (full),
    // then purge changed files. Returns the saved edges for Stage 7
    // reconnect and the removal reverse-dep set for Stage 8 reclassification.
    let (
        saved_reverse_dep_edges,
        saved_sibling_groups,
        removal_reverse_deps,
        removed_file_neighbors,
    ) = save_and_purge_changed(conn, &parse_changes, &change_result, &opts, root_dir);

    // ── Stage 4: Parse files ───────────────────────────────────────────
    // Only truly-changed files are parsed. Reverse-dep files are not re-parsed —
    // their edges to changed files are reconstructed via save+reconnect (#1012).
    let t0 = Instant::now();
    let mut file_symbols =
        parse_and_index_files(&parse_changes, root_dir, include_dataflow, include_ast);
    timing.parse_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 5: Insert nodes ──────────────────────────────────────────
    // file_hashes for these files is deliberately NOT written here — only
    // node/edge-adjacent (contains, parameter_of) data plus removed-file hash
    // cleanup. Committing a changed file's hash this early (before Stage 7
    // rebuilds its import/call edges) would let the hash claim "up to date"
    // even if edge-building later fails or is interrupted, permanently
    // desyncing file_hashes from the edges it's supposed to gate re-parsing
    // on (#1731). The hash is committed at the end of Stage 7 instead, once
    // edges genuinely match this revision — see `commit_file_hashes` below.
    // A failure here propagates via `?` instead of being discarded: nodes
    // are the foundation every later stage builds on, so a transaction
    // failure must abort the pipeline and surface as a thrown error rather
    // than a "successful" build with missing data (#1827).
    let t0 = Instant::now();
    let insert_batches = build_insert_batches(&file_symbols);
    let file_hashes = build_file_hash_entries(&parse_changes, &file_symbols);
    crate::domain::graph::builder::stages::insert_nodes::do_insert_nodes(
        conn,
        &insert_batches,
        &change_result.removed,
    )
    .map_err(|e| format!("insert_nodes failed: {e}"))?;
    detect_changes::heal_metadata(conn, &change_result.metadata_updates);
    timing.insert_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 6: Resolve imports ───────────────────────────────────────
    let t0 = Instant::now();
    let (mut batch_resolved, known_files) = resolve_pipeline_imports(
        &file_symbols,
        &collect_result.files,
        root_dir,
        &napi_aliases,
        &workspaces,
    );
    timing.resolve_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 6b: Re-parse barrel candidates (incremental only) ─────────
    // `barrel_candidates_added` collects only the paths merged into
    // `file_symbols` here — i.e. files loaded purely to resolve reexport
    // chains, not files that are genuinely part of this build's changed
    // set. Only those transient files are eligible for `barrel_only_files`
    // classification below (mirrors `resolve-imports.ts::reparseBarrelFiles`,
    // which marks barrel-only status inside this same re-parse loop rather
    // than recomputing it over the whole `fileSymbols` map — #1848).
    let barrel_candidates_added: Vec<String> = if !change_result.is_full_build {
        reparse_barrel_candidates(
            conn,
            root_dir,
            &napi_aliases,
            &known_files,
            &workspaces,
            &mut file_symbols,
            &mut batch_resolved,
        )
    } else {
        Vec::new()
    };

    // ── Stage 7: Build edges ───────────────────────────────────────────
    let t0 = Instant::now();

    // Build import edge context
    let mut import_ctx = ImportEdgeContext {
        batch_resolved,
        reexport_map: HashMap::new(),
        barrel_only_files: HashSet::new(),
        file_symbols: file_symbols.clone(),
        root_dir: root_dir.to_string(),
        aliases: napi_aliases.clone(),
        known_files,
        workspaces: workspaces.clone(),
    };

    // Build reexport map and detect barrel files. Classification is scoped to
    // `barrel_candidates_added` (empty on full builds) rather than every key
    // in `file_symbols` — a file that's genuinely part of this build's
    // changed set must always get its own non-reexport imports emitted,
    // regardless of whether it happens to satisfy the reexports-outnumber-
    // ownDefs heuristic (#1848, #2339).
    import_ctx.reexport_map = import_edges::build_reexport_map(&import_ctx);
    import_ctx.barrel_only_files =
        import_edges::detect_barrel_only_files(&import_ctx, &barrel_candidates_added);

    // Persist barrel rename pairs so `codegraph watch`'s JS-only single-file
    // rebuild (resolveBarrelTarget, incremental.ts) can resolve renamed
    // barrel re-exports for repos built with the native engine too (#1967).
    import_edges::persist_reexport_renames(conn, &import_ctx.reexport_map)
        .map_err(|e| format!("reexport rename persistence failed: {e}"))?;

    // #2138: persist this pass's own return-type evidence before it's read
    // back below — gives a later incremental build a durable, whole-graph
    // view of files it doesn't itself re-parse.
    import_edges::persist_return_types(conn, &file_symbols)
        .map_err(|e| format!("return type persistence failed: {e}"))?;

    // Build import edges. A write failure here (transaction-start, a
    // malformed chunk, or commit) propagates via `?` instead of being
    // discarded — the old `run_pipeline` had no way to know edges were
    // never written for some or all files, so it returned `Ok(...)` (a
    // "successful" build) over an incomplete edge set (#1827).
    let import_edge_rows = import_edges::build_import_edges(conn, &import_ctx);
    import_edges::insert_edges(conn, &import_edge_rows)
        .map_err(|e| format!("import edge insertion failed: {e}"))?;

    // Phase 8.2: cross-file return-type propagation — seed each file's
    // type_map with the return types of imported functions before call-edge
    // building, mirroring propagateReturnTypesAcrossFiles in build-edges.ts.
    propagate_return_types_across_files(conn, &mut file_symbols, &import_ctx);

    // Build call edges using existing Rust edge_builder (internal path)
    // For now, call edges are built via the existing napi-exported function's
    // internal logic. We load nodes from DB and pass to the edge builder.
    // Same error-propagation rationale as import edges above (#1827) — this
    // call used to run unchecked, with its `Result` never captured.
    build_and_insert_call_edges(
        conn,
        &file_symbols,
        &import_ctx,
        !change_result.is_full_build,
        config.analysis.points_to_max_iterations,
        config.analysis.correlated_property_evidence,
    )
    .map_err(|e| format!("call edge insertion failed: {e}"))?;

    reconnect_saved_reverse_dep_edges(
        conn,
        &saved_reverse_dep_edges,
        &saved_sibling_groups,
        config.build.reverse_dep_alignment_max_group_size,
    );

    // Now that edges reflect this revision, commit file_hashes for the
    // changed files (#1731). Deferred from Stage 5 — see the comment there.
    // Only reached once import and call edges above are confirmed written —
    // an edge-insertion failure now aborts the pipeline (via `?`) before this
    // point instead of committing a hash over an incomplete edge set (#1827).
    // A failure of this commit itself stays non-fatal (log and continue):
    // it only affects bookkeeping, not correctness — the file's hash simply
    // keeps its old value, so the next build re-detects and re-processes it
    // (the same self-healing property #1731 relies on).
    if let Err(e) =
        crate::domain::graph::builder::stages::insert_nodes::commit_file_hashes(conn, &file_hashes)
    {
        eprintln!("[codegraph] commit_file_hashes failed: {e}");
    }
    timing.edges_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 8: Structure + roles ─────────────────────────────────────
    let t0 = Instant::now();
    let line_count_map = structure::build_line_count_map(&file_symbols, root_dir);
    // file_symbols only contains truly-changed files (reverse-deps are not
    // re-parsed; their edges are reconnected via save+reconnect — #1012), so
    // analysis_scope == changed_files.
    let analysis_scope: Option<Vec<String>> = if change_result.is_full_build {
        None
    } else {
        Some(file_symbols.keys().cloned().collect())
    };
    run_structure_phase(
        conn,
        &file_symbols,
        &collect_result.directories,
        root_dir,
        &line_count_map,
        parse_changes.len(),
        &change_result.removed,
        &removed_file_neighbors,
        change_result.is_full_build,
    );
    timing.structure_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t0 = Instant::now();
    run_role_classification(
        conn,
        &file_symbols,
        removal_reverse_deps,
        change_result.is_full_build,
        root_dir,
    );
    timing.roles_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 8b: Analysis persistence (AST, complexity, CFG, dataflow) ──
    let analysis = run_analysis_persistence(
        conn,
        &file_symbols,
        analysis_scope.as_ref(),
        &opts,
        include_ast,
        include_dataflow,
        &mut timing,
    );

    // ── Stage 9: Finalize ──────────────────────────────────────────────
    let t0 = Instant::now();
    let (node_count, edge_count) = finalize_build(conn, root_dir, journal_dir);
    timing.finalize_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // Include total time in setup for overhead accounting.
    // Clamp to 0.0 to avoid negative values from floating-point rounding.
    let stage_sum = timing.collect_ms
        + timing.detect_ms
        + timing.parse_ms
        + timing.insert_ms
        + timing.resolve_ms
        + timing.edges_ms
        + timing.structure_ms
        + timing.roles_ms
        + timing.ast_ms
        + timing.complexity_ms
        + timing.cfg_ms
        + timing.dataflow_ms
        + timing.finalize_ms;
    let overhead = total_start.elapsed().as_secs_f64() * 1000.0 - stage_sum;
    timing.setup_ms += overhead.max(0.0);

    Ok(BuildPipelineResult {
        phases: timing,
        node_count,
        edge_count,
        file_count: collect_result.files.len(),
        early_exit: false,
        changed_files: analysis_scope,
        changed_count: parse_changes.len(),
        removed_count: change_result.removed.len(),
        is_full_build: change_result.is_full_build,
        structure_handled: true,
        analysis_complete: !analysis.ran || analysis.ok,
    })
}

/// Stage 2: Collect source files with strategy selection (scoped, journal-fast, or full).
fn collect_source_files(
    conn: &Connection,
    root_dir: &str,
    config: &BuildConfig,
    opts: &BuildOpts,
    incremental: bool,
    force_full_rebuild: bool,
    journal_dir: &str,
) -> collect_files::CollectResult {
    if let Some(ref scope) = opts.scope {
        // Scoped rebuild
        let files: Vec<String> = scope
            .iter()
            .map(|f| {
                let abs = Path::new(root_dir).join(normalize_path(f));
                abs.to_str().unwrap_or("").to_string()
            })
            .filter(|f| Path::new(f).exists())
            .collect();
        collect_files::CollectResult {
            directories: files
                .iter()
                .filter_map(|f| {
                    Path::new(f)
                        .parent()
                        .map(|p| p.to_str().unwrap_or("").to_string())
                })
                .collect(),
            files,
        }
    } else if incremental && !force_full_rebuild {
        // Try fast collect from DB + journal
        let journal = journal::read_journal(journal_dir);
        let has_entries =
            journal.valid && (!journal.changed.is_empty() || !journal.removed.is_empty());

        if has_entries {
            let db_files: Vec<String> = conn
                .prepare("SELECT file FROM file_hashes")
                .and_then(|mut stmt| {
                    stmt.query_map([], |row| row.get::<_, String>(0))
                        .map(|rows| rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default();

            if !db_files.is_empty() {
                collect_files::try_fast_collect(
                    root_dir,
                    &db_files,
                    &journal.changed,
                    &journal.removed,
                    &config.ignore_dirs,
                    &config.include,
                    &config.exclude,
                )
            } else {
                collect_files::collect_files(
                    root_dir,
                    &config.ignore_dirs,
                    &config.include,
                    &config.exclude,
                )
            }
        } else {
            collect_files::collect_files(
                root_dir,
                &config.ignore_dirs,
                &config.include,
                &config.exclude,
            )
        }
    } else {
        collect_files::collect_files(
            root_dir,
            &config.ignore_dirs,
            &config.include,
            &config.exclude,
        )
    }
}

/// Stage 6b: Re-parse barrel candidates for incremental builds.
///
/// Barrel files (re-export-only index files) may not be in file_symbols because
/// they weren't changed or reverse-deps. Without their symbols, barrel resolution
/// in Stage 7 can't create transitive import edges.
///
/// Discovery is iterative: a barrel that imports another barrel (e.g.
/// `parser.ts → extractors/index.ts → extractors/<lang>.ts`) needs both
/// loaded so Stage 7 can emit the barrel-through edges from the first barrel
/// to the leaf targets. Without the loop, only the first level of barrels
/// gets merged into `file_symbols`; the deeper chain has no entry in
/// `reexport_map`, so `resolve_barrel_export` returns `None` and the
/// barrel-through edges are silently dropped on every incremental rebuild
/// (#1174). Convergence is guaranteed because `file_symbols` grows
/// monotonically and is bounded by the set of barrel files in the project.
///
/// Returns the relative paths of every file merged into `file_symbols` by
/// this call (across all iterations) — files loaded solely to resolve
/// reexport chains, as distinct from the genuinely-changed files the caller
/// already had in `file_symbols` before Stage 6b ran. The caller uses this
/// list to scope `barrel_only_files` classification (#1848): a barrel-only
/// skip must never apply to a file that's actually part of this build's
/// changed set, only to these transiently side-loaded ones.
fn reparse_barrel_candidates(
    conn: &Connection,
    root_dir: &str,
    napi_aliases: &crate::types::PathAliases,
    known_files: &HashSet<String>,
    workspaces: &HashMap<String, resolve::WorkspaceEntry>,
    file_symbols: &mut BTreeMap<String, FileSymbols>,
    batch_resolved: &mut HashMap<String, String>,
) -> Vec<String> {
    let mut all_added: Vec<String> = Vec::new();
    // Find all barrel files from DB (files that have 'reexports' edges)
    let barrel_files_in_db: HashSet<String> = {
        let rows: Vec<String> = match conn.prepare(
            "SELECT DISTINCT n1.file FROM edges e \
             JOIN nodes n1 ON e.source_id = n1.id \
             WHERE e.kind = 'reexports' AND n1.kind = 'file'",
        ) {
            Ok(mut stmt) => match stmt.query_map([], |row| row.get::<_, String>(0)) {
                Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
                Err(_) => Vec::new(),
            },
            Err(_) => Vec::new(),
        };
        rows.into_iter().collect()
    };

    // Seed: barrels imported by the initial file_symbols (= changed files),
    // plus barrels that re-export FROM any changed file. The reexport-from
    // seed only fires on the initial pass — re-parsed barrels haven't
    // changed in content, so they can't trigger new reexport-from candidates.
    let initial_files: Vec<String> = file_symbols.keys().cloned().collect();
    let mut barrel_paths_to_parse: Vec<String> = collect_imported_barrel_candidates(
        root_dir,
        &initial_files,
        batch_resolved,
        &barrel_files_in_db,
        file_symbols,
    );
    barrel_paths_to_parse.extend(collect_reexport_from_barrels(
        conn,
        root_dir,
        &initial_files,
        file_symbols,
    ));

    // Iterative re-parse: each pass merges the queued barrels into file_symbols,
    // then scans their imports for additional barrel candidates the previous
    // pass couldn't see.
    while !barrel_paths_to_parse.is_empty() {
        barrel_paths_to_parse.sort();
        barrel_paths_to_parse.dedup();
        let to_parse = std::mem::take(&mut barrel_paths_to_parse);
        // Re-parse barrel candidates — these may be hybrid barrels (reexports
        // AND local definitions / call sites, see #979). Dataflow/AST analysis
        // is skipped because the barrel is not itself a "changed" file; Stage 7
        // will reconstruct all outgoing edge kinds from the fresh parse.
        let barrel_parsed = parallel::parse_files_parallel(&to_parse, root_dir, false, false);
        let mut newly_added: Vec<String> = Vec::with_capacity(barrel_parsed.len());
        for mut sym in barrel_parsed {
            let rel = relative_path(root_dir, &sym.file);
            sym.file = rel.clone();
            // Delete every outgoing edge kind that Stage 7 re-emits for re-parsed
            // barrel candidates. Previously only 'imports' and 'reexports' were
            // purged, so 'calls', 'receiver', 'extends', 'implements',
            // 'imports-type', and 'dynamic-imports' accumulated duplicates on
            // every incremental rebuild (#979).
            //
            // Use a negative filter (`NOT IN`) rather than an allowlist so any
            // future edge kind added to Stage 7 is automatically covered. Only
            // 'contains' and 'parameter_of' must be preserved: those are emitted
            // by Stage 5 (insert_nodes) which only runs on the original
            // file_symbols (changed + reverse-deps). Barrel candidates are
            // merged into file_symbols here in Stage 6b *after* Stage 5 has
            // already run, so wiping contains/parameter_of would permanently
            // drop them.
            // Clear dataflow rows that reference these outgoing edges via call_edge_id
            // before deleting the edges — avoids SQLITE_CONSTRAINT_FOREIGNKEY when
            // PRAGMA foreign_keys is ON (dataflow.call_edge_id REFERENCES edges.id).
            let _ = conn.execute(
                "DELETE FROM dataflow WHERE call_edge_id IN \
                 (SELECT id FROM edges WHERE source_id IN \
                  (SELECT id FROM nodes WHERE file = ?1) \
                  AND kind NOT IN ('contains', 'parameter_of'))",
                rusqlite::params![&rel],
            );
            let _ = conn.execute(
                "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) \
                 AND kind NOT IN ('contains', 'parameter_of')",
                rusqlite::params![&rel],
            );
            // Re-resolve imports for the barrel file
            // Normalize to forward slashes so batch_resolved keys match get_resolved lookups on Windows.
            let abs_str = Path::new(root_dir)
                .join(&rel)
                .to_str()
                .unwrap_or("")
                .replace('\\', "/");
            for imp in &sym.imports {
                let input = ImportResolutionInput {
                    from_file: abs_str.clone(),
                    import_source: imp.source.clone(),
                };
                let resolved_batch = resolve::resolve_imports_batch(
                    &[input],
                    root_dir,
                    napi_aliases,
                    Some(known_files),
                    Some(workspaces),
                );
                for r in &resolved_batch {
                    let key = format!("{}|{}", r.from_file, r.import_source);
                    batch_resolved.insert(key, r.resolved_path.clone());
                }
            }
            file_symbols.insert(rel.clone(), sym);
            newly_added.push(rel);
        }

        // Scan just-merged barrels for further barrel imports (next level of
        // the chain). batch_resolved is now up to date for these imports.
        barrel_paths_to_parse = collect_imported_barrel_candidates(
            root_dir,
            &newly_added,
            batch_resolved,
            &barrel_files_in_db,
            file_symbols,
        );
        all_added.extend(newly_added);
    }

    all_added
}

/// Walk the imports of `from_files` and return absolute paths of any barrel
/// candidates (files in `barrel_files_in_db` not yet in `file_symbols`) that
/// exist on disk.
fn collect_imported_barrel_candidates(
    root_dir: &str,
    from_files: &[String],
    batch_resolved: &HashMap<String, String>,
    barrel_files_in_db: &HashSet<String>,
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> Vec<String> {
    let mut out = Vec::new();
    for rel_path in from_files {
        let symbols = match file_symbols.get(rel_path) {
            Some(s) => s,
            None => continue,
        };
        let abs_file = Path::new(root_dir).join(rel_path);
        let fwd = abs_file.to_str().unwrap_or("").replace('\\', "/");
        for imp in &symbols.imports {
            let key = format!("{}|{}", fwd, imp.source);
            if let Some(resolved) = batch_resolved.get(&key) {
                if barrel_files_in_db.contains(resolved) && !file_symbols.contains_key(resolved) {
                    let abs = Path::new(root_dir).join(resolved);
                    if abs.exists() {
                        out.push(abs.to_str().unwrap_or("").to_string());
                    }
                }
            }
        }
    }
    out
}

/// Find barrels that re-export from any of `changed_files`. Used as a seed
/// for the iterative re-parse so a renamed/removed symbol in a changed file
/// re-emits the affected barrel's outgoing edges.
fn collect_reexport_from_barrels(
    conn: &Connection,
    root_dir: &str,
    changed_files: &[String],
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut stmt = match conn.prepare(
        "SELECT DISTINCT n1.file FROM edges e \
         JOIN nodes n1 ON e.source_id = n1.id \
         JOIN nodes n2 ON e.target_id = n2.id \
         WHERE e.kind = 'reexports' AND n1.kind = 'file' AND n2.file = ?1",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return out,
    };
    for changed in changed_files {
        if let Ok(rows) = stmt.query_map(rusqlite::params![changed], |row| row.get::<_, String>(0))
        {
            for row in rows.flatten() {
                if !file_symbols.contains_key(&row) {
                    let abs = Path::new(root_dir).join(&row);
                    if abs.exists() {
                        out.push(abs.to_str().unwrap_or("").to_string());
                    }
                }
            }
        }
    }
    out
}

/// Stage 9: Finalize build — persist metadata, write journal, return counts.
fn finalize_build(conn: &Connection, root_dir: &str, journal_dir: &str) -> (i64, i64) {
    let node_count = conn
        .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0);
    let edge_count = conn
        .query_row("SELECT COUNT(*) FROM edges", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0);

    // Persist build metadata
    let version = env!("CARGO_PKG_VERSION");
    let meta_sql = "INSERT OR REPLACE INTO build_meta (key, value) VALUES (?, ?)";
    if let Ok(mut stmt) = conn.prepare(meta_sql) {
        let _ = stmt.execute(["engine", "native"]);
        let _ = stmt.execute(["engine_version", version]);
        let _ = stmt.execute(["codegraph_version", version]);
        let _ = stmt.execute(["node_count", &node_count.to_string()]);
        let _ = stmt.execute(["edge_count", &edge_count.to_string()]);
        let _ = stmt.execute(["last_build", &now_ms().to_string()]);
        // Persist repo root so downstream commands (e.g. `codegraph embed`)
        // can resolve relative file paths regardless of invoking cwd.
        let root_canon = std::fs::canonicalize(root_dir)
            .ok()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
            .unwrap_or_else(|| root_dir.to_string());
        let _ = stmt.execute(["root_dir", &root_canon]);
    }

    // Write journal header
    journal::write_journal_header(journal_dir, now_ms());
    (node_count, edge_count)
}

/// Check if engine/schema/version changed since last build (forces full rebuild).
fn check_version_mismatch(conn: &Connection) -> bool {
    let get_meta = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM build_meta WHERE key = ?", [key], |row| {
            row.get(0)
        })
        .ok()
    };

    let current_version = env!("CARGO_PKG_VERSION");

    if let Some(prev_engine) = get_meta("engine") {
        if prev_engine != "native" {
            return true;
        }
    }
    // Compare against engine_version (the addon's own version), not
    // codegraph_version (the npm package version). The JS post-processing
    // overwrites codegraph_version with the npm version, which may differ
    // from CARGO_PKG_VERSION — causing a perpetual full-rebuild loop (#928).
    if let Some(prev_version) = get_meta("engine_version") {
        if prev_version != current_version {
            return true;
        }
    }
    false
}

/// Build InsertNodesBatch from parsed file symbols.
fn build_insert_batches(
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> Vec<crate::domain::graph::builder::stages::insert_nodes::InsertNodesBatch> {
    file_symbols
        .iter()
        .map(
            |(rel_path, symbols)| crate::domain::graph::builder::stages::insert_nodes::InsertNodesBatch {
                file: rel_path.clone(),
                definitions: symbols
                    .definitions
                    .iter()
                    .map(|d| crate::domain::graph::builder::stages::insert_nodes::InsertNodesDefinition {
                        name: d.name.clone(),
                        kind: d.kind.clone(),
                        line: d.line,
                        end_line: d.end_line,
                        visibility: None,
                        content_hash: d.content_hash.clone(),
                        accessor_kind: d.accessor_kind.clone(),
                        children: d
                            .children
                            .as_ref()
                            .map(|kids| {
                                kids.iter()
                                    .map(|c| crate::domain::graph::builder::stages::insert_nodes::InsertNodesChild {
                                        name: c.name.clone(),
                                        kind: c.kind.clone(),
                                        line: c.line,
                                        end_line: c.end_line,
                                        visibility: None,
                                        content_hash: c.content_hash.clone(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                    .collect(),
                exports: symbols
                    .exports
                    .iter()
                    .map(|e| crate::domain::graph::builder::stages::insert_nodes::InsertNodesExport {
                        name: e.name.clone(),
                        kind: e.kind.clone(),
                        line: e.line,
                    })
                    .collect(),
            },
        )
        .collect()
}

/// Build FileHashEntry from changed files.
///
/// For full builds, `detect_changes` returns `hash: None` because it skips
/// reading file content. In that case we read and hash each file here so
/// that `file_hashes` is populated for subsequent incremental builds.
///
/// A changed file with no entry in `file_symbols` means extraction failed
/// outright (worker panic recovery, unreadable, unsupported/missing
/// grammar) — as opposed to a file that parsed successfully but
/// legitimately produced zero symbols, which DOES get an entry (with empty
/// `definitions`/`exports`; `parse_files_parallel`'s `filter_map` only
/// drops files where parsing itself never produced a tree). Committing a
/// hash for the former would mark it "up to date" relative to graph data
/// that was never written, permanently hiding the loss from every later
/// incremental build (issue #2441) — skip it instead, so the next build
/// still sees it as changed and reprocesses it. Mirrors
/// `iterFileHashRecords`'s `parsedRelPaths` check in
/// `src/domain/graph/builder/stages/insert-nodes.ts`.
fn build_file_hash_entries(
    changed: &[&detect_changes::ChangedFile],
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> Vec<crate::domain::graph::builder::stages::insert_nodes::FileHashEntry> {
    changed
        .iter()
        .filter(|c| file_symbols.contains_key(&c.rel_path))
        .filter_map(|c| {
            let hash = match c.hash.as_ref() {
                Some(h) => h.clone(),
                None => {
                    // Full build path: read file and compute hash now
                    match std::fs::read_to_string(&c.abs_path) {
                        Ok(content) => {
                            use sha2::{Digest, Sha256};
                            let mut hasher = Sha256::new();
                            hasher.update(content.as_bytes());
                            format!("{:x}", hasher.finalize())
                        }
                        Err(_) => return None,
                    }
                }
            };
            let (mtime, size) = if c.mtime == 0 && c.size == 0 {
                // Full build: read metadata from filesystem
                std::fs::metadata(&c.abs_path)
                    .ok()
                    .map(|m| {
                        let mtime = m
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as f64)
                            .unwrap_or(0.0);
                        let size = m.len() as f64;
                        (mtime, size)
                    })
                    .unwrap_or((0.0, 0.0))
            } else {
                (c.mtime as f64, c.size as f64)
            };
            Some(
                crate::domain::graph::builder::stages::insert_nodes::FileHashEntry {
                    file: c.rel_path.clone(),
                    hash,
                    mtime,
                    size,
                },
            )
        })
        .collect()
}

/// Build call edges using the Rust edge_builder and insert them.
///
/// `is_incremental`: when true, the set of nodes loaded from the DB may be
/// scoped to the files being processed plus their resolved import targets.
/// Scoping is gated on:
///   - small incremental change set (`file_symbols.len() <= SMALL_FILES`)
///   - large-enough existing codebase (`file-node count > MIN_EXISTING`)
///
/// Both gates mirror the JS path in `build-edges.ts` (#976) to avoid
/// exercising the scoped path on tiny fixtures where the scoped set can
/// miss transitively-required nodes (e.g. a call site whose receiver type
/// is declared in a file that isn't a direct import target).
///
/// Constant list of builtin JS receivers excluded from method-resolution
/// (callers of `console.log` etc. shouldn't get linked to a user-defined
/// `log` somewhere else). Mirrors `BUILTIN_RECEIVERS` in `build-edges.ts`.
fn builtin_call_receivers() -> Vec<String> {
    [
        "console",
        "Math",
        "JSON",
        "Object",
        "Array",
        "String",
        "Number",
        "Boolean",
        "Date",
        "RegExp",
        "Map",
        "Set",
        "WeakMap",
        "WeakSet",
        "Promise",
        "Symbol",
        "Error",
        "TypeError",
        "RangeError",
        "Proxy",
        "Reflect",
        "Intl",
        "globalThis",
        "window",
        "document",
        "process",
        "Buffer",
        "require",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

const EDGE_NODE_KIND_FILTER: &str = "kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant','variable')";

/// For the scoped (incremental, small-batch) path of the edge builder,
/// compute the set of files that must be loaded: changed/reverse-dep files
/// plus their direct import targets plus barrel-only files plus the
/// ultimate definition files barrel chains resolve to. Mirrors the JS
/// `relevantFiles` accumulation in `loadNodes` (#976, greptile P1).
fn compute_edge_relevant_files(
    file_symbols: &BTreeMap<String, FileSymbols>,
    import_ctx: &crate::domain::graph::builder::stages::import_edges::ImportEdgeContext,
) -> HashSet<String> {
    let mut relevant_files: HashSet<String> = file_symbols.keys().cloned().collect();
    for (rel_path, symbols) in file_symbols {
        let abs_file = Path::new(&import_ctx.root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("");
        for imp in &symbols.imports {
            let resolved = import_ctx.get_resolved(abs_str, &imp.source);
            if resolved.is_empty() {
                continue;
            }
            relevant_files.insert(resolved.clone());
            if import_ctx.is_barrel_file(&resolved) {
                for name in &imp.names {
                    let clean_name = name.strip_prefix("* as ").unwrap_or(name);
                    let mut visited = HashSet::new();
                    if let Some(ultimate) =
                        import_ctx.resolve_barrel_export(&resolved, clean_name, &mut visited)
                    {
                        relevant_files.insert(ultimate.file);
                    }
                }
            }
        }
    }
    for barrel_path in &import_ctx.barrel_only_files {
        relevant_files.insert(barrel_path.clone());
    }
    relevant_files
}

/// Load all candidate edge nodes either scoped via a temp _edge_files table
/// (incremental small-batch) or globally (full build). Returns a flat
/// `Vec<NodeInfo>` suitable for the native edge builder.
fn load_edge_node_set(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    import_ctx: &crate::domain::graph::builder::stages::import_edges::ImportEdgeContext,
    is_incremental: bool,
) -> Vec<crate::domain::graph::builder::stages::build_edges::NodeInfo> {
    use crate::domain::graph::builder::stages::build_edges::NodeInfo;

    let existing_file_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM nodes WHERE kind = 'file'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let scope_eligible = is_incremental
        && file_symbols.len() <= crate::shared::constants::FAST_PATH_MAX_CHANGED_FILES
        && existing_file_count > crate::shared::constants::FAST_PATH_MIN_EXISTING_FILES;

    if !scope_eligible {
        return load_all_edge_nodes(conn);
    }

    let relevant_files = compute_edge_relevant_files(file_symbols, import_ctx);
    if relevant_files.is_empty() {
        return Vec::new();
    }

    let _ = conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS _edge_files (file TEXT NOT NULL);\n         CREATE INDEX IF NOT EXISTS _edge_files_file_idx ON _edge_files (file);",
    );
    let _ = conn.execute("DELETE FROM temp._edge_files", []);
    {
        let mut ins = match conn.prepare("INSERT INTO temp._edge_files (file) VALUES (?1)") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        for f in &relevant_files {
            let _ = ins.execute(rusqlite::params![f]);
        }
    }

    let sql = format!(
        "SELECT n.id, n.name, n.kind, n.file, n.line, n.accessor_kind FROM nodes n \
         INNER JOIN temp._edge_files ef ON n.file = ef.file \
         WHERE n.{EDGE_NODE_KIND_FILTER}",
    );
    let nodes: Vec<NodeInfo> = match conn.prepare(&sql) {
        Ok(mut stmt) => stmt
            .query_map([], read_edge_node_info)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let _ = conn.execute("DROP TABLE IF EXISTS temp._edge_files", []);
    nodes
}

/// Load every candidate edge node from the DB (full-build path).
fn load_all_edge_nodes(
    conn: &Connection,
) -> Vec<crate::domain::graph::builder::stages::build_edges::NodeInfo> {
    let sql = format!(
        "SELECT id, name, kind, file, line, accessor_kind FROM nodes WHERE {EDGE_NODE_KIND_FILTER}",
    );
    match conn.prepare(&sql) {
        Ok(mut stmt) => stmt
            .query_map([], read_edge_node_info)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Row-mapper for the `SELECT id, name, kind, file, line FROM nodes ...`
/// shape used by both scoped and full edge-node loads.
fn read_edge_node_info(
    row: &rusqlite::Row,
) -> rusqlite::Result<crate::domain::graph::builder::stages::build_edges::NodeInfo> {
    Ok(
        crate::domain::graph::builder::stages::build_edges::NodeInfo {
            id: row.get::<_, i64>(0)? as u32,
            name: row.get(1)?,
            kind: row.get(2)?,
            file: row.get(3)?,
            line: row.get::<_, i64>(4)? as u32,
            accessor_kind: row.get(5)?,
        },
    )
}

/// Load all `file`-kind node IDs into a flat map (one query instead of one
/// per file). The `name = file` guard avoids accidentally overwriting the
/// map entry when an unrelated row happens to share the file path (#1028).
fn load_file_node_id_map(conn: &Connection) -> HashMap<String, u32> {
    let mut map = HashMap::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT file, id FROM nodes WHERE kind = 'file' AND line = 0 AND name = file")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
        }) {
            for r in rows.flatten() {
                map.insert(r.0, r.1);
            }
        }
    }
    map
}

/// Resolve a file's imports to the list of `ImportedName` entries the edge
/// builder consumes. Walks barrel chains to the ultimate definition file so
/// the edge builder's name-lookup can find the right target (#976 P1).
///
/// For renamed specifiers (`import { X as Y }`), `ImportedName.imported`
/// carries the original name (X) so `resolve_call_targets` can look it up in
/// the target file instead of the local alias (Y), which only exists in the
/// importing file (#1730).
fn collect_imported_names_for_file(
    abs_str: &str,
    symbols: &FileSymbols,
    import_ctx: &crate::domain::graph::builder::stages::import_edges::ImportEdgeContext,
) -> Vec<crate::domain::graph::builder::stages::build_edges::ImportedName> {
    use crate::domain::graph::builder::stages::build_edges::ImportedName;
    use crate::domain::graph::builder::stages::import_edges::import_name_pairs;
    let mut imported_names: Vec<ImportedName> = Vec::new();
    for imp in &symbols.imports {
        let resolved_path = import_ctx.get_resolved(abs_str, &imp.source);
        for (local, original, _type_only) in import_name_pairs(imp) {
            // CJS require bindings are included in imported_names so the receiver-edge
            // resolver treats them as import artifacts (not locally-defined symbols).
            // We use an empty target_file so the import-aware call-target lookup
            // (`nodes_by_name_and_file.get(&(name, ""))`) always misses and falls
            // through to the same-file shadow node — matching WASM call-resolution
            // behaviour where CJS bindings are not in importedNamesMap (#1678).
            if imp.cjs_require.unwrap_or(false) {
                imported_names.push(ImportedName {
                    name: local,
                    file: String::new(),
                    imported: None,
                    namespace: None,
                });
                continue;
            }
            // A binding that names the module itself targets the module file
            // and has no declared symbol to trace through a barrel (#2387).
            if imp
                .namespace_bindings
                .as_ref()
                .is_some_and(|b| b.contains(&local))
            {
                imported_names.push(ImportedName {
                    name: local,
                    file: resolved_path.clone(),
                    imported: None,
                    namespace: Some(true),
                });
                continue;
            }
            // `from pkg import submod` binds a module too, but which reading
            // applies depends on whether `pkg/submod.py` exists — a question
            // only the resolver can answer (#2387).
            if let Some(submodule) = crate::domain::graph::resolve::resolve_python_submodule(
                abs_str,
                &imp.source,
                &original,
                &import_ctx.root_dir,
                Some(&import_ctx.known_files),
            ) {
                imported_names.push(ImportedName {
                    name: local,
                    file: submodule,
                    imported: None,
                    namespace: Some(true),
                });
                continue;
            }
            let mut target_file = resolved_path.clone();
            let mut target_name = original;
            if import_ctx.is_barrel_file(&resolved_path) {
                let mut visited = HashSet::new();
                if let Some(resolved) =
                    import_ctx.resolve_barrel_export(&resolved_path, &target_name, &mut visited)
                {
                    target_file = resolved.file;
                    target_name = resolved.name;
                }
            }
            imported_names.push(ImportedName {
                imported: if target_name != local {
                    Some(target_name)
                } else {
                    None
                },
                name: local,
                file: target_file,
                namespace: None,
            });
        }
    }
    imported_names
}

/// Phase 8.2: cross-file return-type propagation.
///
/// Mirrors `propagateReturnTypesAcrossFiles` in `build-edges.ts`: when a file
/// assigns the return value of an imported function to a variable
/// (`const svc = buildService()`), look up the callee's return type in the
/// defining file's `return_type_map` and seed the assigning file's `type_map`
/// so method calls and receiver edges on that variable resolve. Must run
/// before `build_and_insert_call_edges`.
fn propagate_return_types_across_files(
    conn: &Connection,
    file_symbols: &mut BTreeMap<String, FileSymbols>,
    import_ctx: &ImportEdgeContext,
) {
    use crate::domain::graph::builder::stages::build_edges::PROPAGATION_HOP_PENALTY;

    // #2138: skip entirely — including the return_types DB read added below
    // — when nothing in this build needs cross-file resolution. A no-op or
    // small incremental rebuild with no call-assignments anywhere must not
    // pay for a whole-table SELECT it has no use for (this guard is what
    // keeps that read off the no-op rebuild's hot path).
    if !file_symbols
        .values()
        .any(|s| !s.call_assignments.is_empty())
    {
        return;
    }

    let (return_type_index, global_return_types) = build_return_type_index(conn, file_symbols);
    if return_type_index.is_empty() {
        return;
    }

    for (rel_path, symbols) in file_symbols.iter_mut() {
        if symbols.call_assignments.is_empty() {
            continue;
        }
        inject_return_types_for_file(
            rel_path,
            symbols,
            import_ctx,
            &return_type_index,
            &global_return_types,
            PROPAGATION_HOP_PENALTY,
        );
    }
}

/// Build per-file and global return-type indexes from `return_type_map` entries.
///
/// Returns:
/// - `return_type_index`: `rel_path → (fn_name → (type_name, confidence))`
/// - `global_return_types`: flat map for qualified `Type.method` lookups; higher
///   confidence wins, tie-break is deterministic (paths visited in sorted order).
///
/// #2138: unions in DB-persisted return types (`return_types`, written by
/// `persist_return_types`) for files not present in `file_symbols` — i.e.
/// files this build pass didn't itself re-parse. On a scoped incremental
/// build a barrel-adjacent file can get its outgoing edges wiped and
/// re-derived from this index alone; without the DB union, dispatch to a
/// factory/getter defined in an untouched file (e.g. `getWasmWorkerPool()`)
/// silently drops out. Files with fresh in-memory data are never overridden
/// by (potentially stale) persisted rows.
fn build_return_type_index(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> (ReturnTypeIndex, GlobalReturnTypes) {
    let mut return_type_index: ReturnTypeIndex = HashMap::new();
    for (rel_path, symbols) in file_symbols.iter() {
        if symbols.return_type_map.is_empty() {
            continue;
        }
        let per_file = return_type_index.entry(rel_path.clone()).or_default();
        for e in &symbols.return_type_map {
            per_file.insert(e.name.clone(), (e.type_name.clone(), e.confidence));
        }
    }

    let fresh_files: HashSet<String> = return_type_index.keys().cloned().collect();
    if let Ok(mut stmt) =
        conn.prepare("SELECT file, fn_name, type_name, confidence FROM return_types")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, f64>(3)?,
            ))
        }) {
            for row in rows.flatten() {
                let (file, fn_name, type_name, confidence) = row;
                if fresh_files.contains(&file) {
                    continue;
                }
                return_type_index
                    .entry(file)
                    .or_default()
                    .insert(fn_name, (type_name, confidence));
            }
        }
    }

    let mut global_return_types: GlobalReturnTypes = HashMap::new();
    let mut sorted_paths: Vec<&String> = return_type_index.keys().collect();
    sorted_paths.sort();
    for rel_path in sorted_paths {
        for (name, entry) in &return_type_index[rel_path] {
            let replace = match global_return_types.get(name) {
                Some(existing) => entry.1 > existing.1,
                None => true,
            };
            if replace {
                global_return_types.insert(name.clone(), entry.clone());
            }
        }
    }

    (return_type_index, global_return_types)
}

/// If `type_name` is `Option<T>` or `Result<T, E>`, return `T` — the type a
/// refutable `Some(x)`/`Ok(x)` pattern (`if let`/`while let`/`let-else`) binds
/// `x` to. Handles nested generics in the first type argument
/// (`Result<Vec<User>, String>` → `Vec<User>`) by tracking bracket depth rather
/// than splitting on the first comma. Returns `None` for any other shape,
/// including a malformed generic string, so the caller can decline to inject a
/// guessed type rather than propagate something wrong. Mirrors
/// `unwrapOptionResultType` in `build-edges.ts` (#2214).
fn unwrap_option_result_type(type_name: &str) -> Option<&str> {
    let (base, rest) = type_name.split_once('<')?;
    if !crate::extractors::rust_lang::is_option_or_result_base(base.trim()) {
        return None;
    }
    let inner = rest.strip_suffix('>')?;
    let mut depth = 0i32;
    for (i, c) in inner.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => depth -= 1,
            ',' if depth == 0 => {
                let first = inner[..i].trim();
                return normalize_unwrapped_generic_arg(first);
            }
            _ => {}
        }
    }
    normalize_unwrapped_generic_arg(inner.trim())
}

/// Apply the same nominal-vs-full-generic rule `extract_rust_type_name` applies
/// at extraction time to an unwrapped `Some(x)`/`Ok(x)` binding's inner type —
/// bare for an ordinary generic (`Option<Vec<User>>`'s inner `Vec<User>` becomes
/// `x`'s type `Vec`, matching how a direct `let x: Vec<User> = ...` annotation
/// would type it), full text for a nested Option/Result (`Option<Option<User>>`'s
/// inner `Option<User>` stays `Option<User>` — if-let only strips one layer, so
/// `x`'s real type still needs its own type argument for a later unwrap).
/// Without this, a nested generic payload would inject a parameterized name where
/// every other path in this pipeline injects a bare one (Greptile review, PR #2371).
fn normalize_unwrapped_generic_arg(arg: &str) -> Option<&str> {
    let arg = strip_reference_sigil(arg.trim());
    if arg.is_empty() {
        return None;
    }
    let Some((inner_base, _rest)) = arg.split_once('<') else {
        return Some(arg);
    };
    let inner_base = inner_base.trim();
    if crate::extractors::rust_lang::is_option_or_result_base(inner_base) {
        Some(arg)
    } else {
        Some(inner_base)
    }
}

/// Strip a leading `&`/`&mut `/`&'a `/`&'a mut ` reference sigil, the same way
/// `extract_rust_type_name`'s `reference_type` branch does for a direct
/// annotation — `Option<&User>`/`Option<&'a mut User>`'s bound value's real
/// receiver type is `User`, not the reference syntax around it (Greptile
/// review, PR #2371).
fn strip_reference_sigil(s: &str) -> &str {
    let Some(rest) = s.strip_prefix('&') else {
        return s;
    };
    let mut rest = rest.trim_start();
    if rest.starts_with('\'') {
        if let Some(idx) = rest.find(char::is_whitespace) {
            rest = rest[idx..].trim_start();
        }
    }
    rest.strip_prefix("mut ")
        .map(str::trim_start)
        .unwrap_or(rest)
}

/// Inject cross-file return types into a single file's `type_map`.
///
/// For each call-assignment in the file (`const x = callee()`), looks up the
/// callee's return type in `return_type_index` (imported callee) or
/// `global_return_types` (qualified `Receiver.method` callee) and pushes a
/// `TypeMapEntry` so downstream call-edge resolution can follow `x.method()`.
/// Already-resolved locals (`type_map` already has `var_name`) are skipped.
fn inject_return_types_for_file(
    rel_path: &str,
    symbols: &mut FileSymbols,
    import_ctx: &ImportEdgeContext,
    return_type_index: &ReturnTypeIndex,
    global_return_types: &GlobalReturnTypes,
    hop_penalty: f64,
) {
    let abs_file = Path::new(&import_ctx.root_dir).join(rel_path);
    let abs_str = abs_file.to_str().unwrap_or("");
    let imported_names = collect_imported_names_for_file(abs_str, symbols, import_ctx);
    // Later entries overwrite earlier ones on duplicate names — same as the
    // HashMap collect in build_call_edges.
    let mut imported_map: HashMap<String, String> = HashMap::new();
    let mut imported_original_map: HashMap<String, String> = HashMap::new();
    for e in imported_names {
        if let Some(original) = e.imported {
            imported_original_map.insert(e.name.clone(), original);
        }
        imported_map.insert(e.name, e.file);
    }

    let mut injections: Vec<TypeMapEntry> = Vec::new();
    let mut injected: HashSet<String> = HashSet::new();
    for ca in &symbols.call_assignments {
        // Already resolved locally (JS: `typeMap.has(varName)`); first
        // successful injection wins for repeated assignments to one name.
        if injected.contains(&ca.var_name) || symbols.type_map.iter().any(|t| t.name == ca.var_name)
        {
            continue;
        }

        // A method call whose receiver's type wasn't known at extraction time
        // (`ca.receiver_var_name`) may have just been resolved by an earlier
        // call-assignment in this same file — e.g. `service` in `let service =
        // build_service(); ... service.get_user(1)` only becomes typed once
        // `service`'s own cross-file return type is injected. Retry against the
        // receiver's now-resolved type (its original same-file type_map entry,
        // or an injection already added earlier in this loop) before falling
        // back to a bare global-function lookup (#2214).
        let receiver_resolved_type = ca.receiver_var_name.as_ref().and_then(|receiver_var| {
            symbols
                .type_map
                .iter()
                .find(|t| &t.name == receiver_var)
                .map(|t| t.type_name.as_str())
                .or_else(|| {
                    injections
                        .iter()
                        .find(|t| &t.name == receiver_var)
                        .map(|t| t.type_name.as_str())
                })
        });

        let found = match (&ca.receiver_type_name, receiver_resolved_type) {
            (Some(receiver), _) => {
                global_return_types.get(&format!("{receiver}.{}", ca.callee_name))
            }
            (None, Some(receiver_type)) => {
                global_return_types.get(&format!("{receiver_type}.{}", ca.callee_name))
            }
            (None, None) => imported_map.get(&ca.callee_name).and_then(|from| {
                // The return-type index for the imported file is keyed by the
                // function's own declared name — use the original (pre-rename)
                // name when the callee is a renamed import binding (#1730).
                let callee_original_name = imported_original_map
                    .get(&ca.callee_name)
                    .unwrap_or(&ca.callee_name);
                return_type_index
                    .get(from)
                    .and_then(|m| m.get(callee_original_name))
            }),
        };

        if let Some((type_name, confidence)) = found {
            // `ca.unwrap_depth` means the binding came from unwrapping that many
            // layers of a refutable `Some(x)`/`Ok(x)` pattern — `Some(Some(x))`
            // is 2, not 1. The callee's declared return type is itself wrapped
            // that many layers deep (`Option<Option<T>>` for depth 2), and `x`'s
            // real type is what's left after unwrapping all of them, not the
            // wrapper. If a layer turns out not to actually be a generic
            // Option/Result (a mismatch between the pattern and the callee's
            // real signature), decline to inject rather than propagate a
            // half-unwrapped type as if it were `x`'s type (#2214).
            let mut current = type_name.as_str();
            let mut unwrap_failed = false;
            for _ in 0..ca.unwrap_depth {
                match unwrap_option_result_type(current) {
                    Some(inner) => current = inner,
                    None => {
                        unwrap_failed = true;
                        break;
                    }
                }
            }
            if unwrap_failed {
                continue;
            }
            let resolved_type_name = current.to_string();

            let propagated = confidence - hop_penalty;
            if propagated > 0.0 {
                injections.push(TypeMapEntry {
                    name: ca.var_name.clone(),
                    type_name: resolved_type_name,
                    confidence: propagated,
                });
                injected.insert(ca.var_name.clone());
            }
        }
    }
    symbols.type_map.extend(injections);
}

/// Insert the edges produced by the native edge builder into the edges
/// table. Propagates `do_insert_edges`'s `Result` instead of discarding it
/// (#1827) — `do_insert_edges` already fails fast (transaction-start,
/// bind/execute, or commit) via `?`, but the previous `let _ = …` here threw
/// that signal away, so `run_pipeline` had no way to detect a transaction
/// that never started, or failed to commit, for this file's call edges.
fn insert_call_edge_rows(
    conn: &Connection,
    edges: &[crate::domain::graph::builder::stages::build_edges::ComputedEdge],
) -> Result<(), String> {
    if edges.is_empty() {
        return Ok(());
    }
    let edge_rows: Vec<crate::db::repository::edges::EdgeRow> = edges
        .iter()
        .map(|e| crate::db::repository::edges::EdgeRow {
            source_id: e.source_id,
            target_id: e.target_id,
            kind: e.kind.clone(),
            confidence: e.confidence,
            dynamic: e.dynamic,
            dynamic_kind: e.dynamic_kind.clone(),
            technique: e.technique.clone(),
        })
        .collect();
    crate::db::repository::edges::do_insert_edges(conn, &edge_rows)
        .map_err(|e| format!("call edge insertion failed: {e}"))
}

/// Full builds always load every node — there is no smaller set anyway.
///
/// `max_iterations` caps the Phase 8.3 points-to solver's fixed-point loop —
/// forwarded from `config.analysis.points_to_max_iterations` (issue #1753).
fn build_and_insert_call_edges(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    import_ctx: &ImportEdgeContext,
    is_incremental: bool,
    max_iterations: u32,
    correlation_enabled: bool,
) -> Result<(), String> {
    use crate::domain::graph::builder::stages::build_edges::*;

    let all_nodes = load_edge_node_set(conn, file_symbols, import_ctx, is_incremental);
    if all_nodes.is_empty() {
        return Ok(());
    }

    let builtin_receivers = builtin_call_receivers();
    let file_node_ids = load_file_node_id_map(conn);

    // Build FileEdgeInput entries for the native edge builder
    let mut file_entries: Vec<FileEdgeInput> = Vec::new();
    for (rel_path, symbols) in file_symbols {
        if import_ctx.barrel_only_files.contains(rel_path) {
            continue;
        }
        let file_node_id: u32 = match file_node_ids.get(rel_path) {
            Some(&id) => id,
            None => continue,
        };

        let abs_file = Path::new(&import_ctx.root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("");
        let imported_names = collect_imported_names_for_file(abs_str, symbols, import_ctx);

        let type_map: Vec<TypeMapInput> = symbols
            .type_map
            .iter()
            .map(|t| TypeMapInput {
                name: t.name.clone(),
                type_name: t.type_name.clone(),
                confidence: t.confidence,
            })
            .collect();

        fn non_empty<T: Clone>(v: &[T]) -> Option<Vec<T>> {
            if v.is_empty() {
                None
            } else {
                Some(v.to_vec())
            }
        }

        file_entries.push(FileEdgeInput {
            file: rel_path.clone(),
            file_node_id,
            definitions: symbols
                .definitions
                .iter()
                .map(|d| DefInfo {
                    name: d.name.clone(),
                    kind: d.kind.clone(),
                    line: d.line,
                    end_line: d.end_line,
                    // Phase 8.3c: ordered parameter names for parameter-flow pts —
                    // mirrors buildDefinitionParamsMap reading def.children.
                    params: d.children.as_ref().map(|children| {
                        children
                            .iter()
                            .filter(|c| c.kind == "parameter")
                            .map(|c| c.name.clone())
                            .collect()
                    }),
                })
                .collect(),
            calls: symbols
                .calls
                .iter()
                .map(|c| CallInfo {
                    name: c.name.clone(),
                    line: c.line,
                    dynamic: c.dynamic,
                    receiver: c.receiver.clone(),
                    dynamic_kind: c.dynamic_kind.clone(),
                    key_expr: c.key_expr.clone(),
                    accessor_read: c.accessor_read.clone(),
                    object_literal_site: c.object_literal_site.clone(),
                })
                .collect(),
            imported_names,
            classes: symbols
                .classes
                .iter()
                .map(|c| ClassInfo {
                    name: c.name.clone(),
                    extends: c.extends.clone(),
                    implements: c.implements.clone(),
                })
                .collect(),
            type_map,
            fn_ref_bindings: non_empty(&symbols.fn_ref_bindings),
            param_bindings: non_empty(&symbols.param_bindings),
            this_call_bindings: non_empty(&symbols.this_call_bindings),
            array_elem_bindings: non_empty(&symbols.array_elem_bindings),
            spread_arg_bindings: non_empty(&symbols.spread_arg_bindings),
            for_of_bindings: non_empty(&symbols.for_of_bindings),
            array_callback_bindings: non_empty(&symbols.array_callback_bindings),
            object_rest_param_bindings: non_empty(&symbols.object_rest_param_bindings),
            object_prop_bindings: non_empty(&symbols.object_prop_bindings),
            computed_dispatch_table_evidence: non_empty(&symbols.computed_dispatch_table_evidence),
            new_expressions: non_empty(&symbols.new_expressions),
            object_literal_sites: non_empty(&symbols.object_literal_sites),
            call_assignments: non_empty(&symbols.call_assignments),
        });
    }

    // #2087: persist per-file invoked-property-name evidence before
    // `file_entries` is moved into `build_call_edges` below — gives
    // `codegraph watch`'s JS-only incremental rebuild a durable, whole-graph
    // view for repos built with the native engine too.
    import_edges::persist_invoked_property_names(conn, &file_entries)
        .map_err(|e| format!("invoked property name persistence failed: {e}"))?;
    import_edges::persist_object_literal_sites(conn, &file_entries)
        .map_err(|e| format!("object literal site persistence failed: {e}"))?;
    // #2088: one Andersen pass for this file set, reused for persist AND
    // call-edge emission — mirrors JS `prepareInvokedPropertySiteResolution`.
    // Persist before the extra-SELECT so a later incremental rebuild's
    // extra-SELECT is not vacuously empty.
    let prep = prepare_invoked_property_site_resolution(&file_entries, &all_nodes, max_iterations);
    import_edges::persist_invoked_property_sites(conn, &file_entries, &prep.sites_by_file)
        .map_err(|e| format!("invoked property site persistence failed: {e}"))?;

    // Read back the now-current whole-graph view (includes the fresh rows
    // just written above) so this pass's own call-edge resolution sees
    // evidence from files outside `file_entries` too — `file_entries` alone
    // is exact on a full build but narrower on an incremental one (#2087).
    let extra_invoked_property_names: Vec<String> = conn
        .prepare("SELECT DISTINCT name FROM invoked_property_names")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let extra_invoked_property_sites: Vec<String> = conn
        .prepare("SELECT site_key || '|' || name FROM invoked_property_sites")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let computed_edges = build_call_edges_prepared(
        file_entries,
        all_nodes,
        builtin_receivers,
        Some(extra_invoked_property_names),
        Some(extra_invoked_property_sites),
        Some(correlation_enabled),
        prep,
    );
    insert_call_edge_rows(conn, &computed_edges)
}

// ── Analysis persistence helpers ─────────────────────────────────────────

/// Build a lookup map from (file, name, line) to node_id for analysis writes.
fn build_analysis_node_map(
    conn: &Connection,
    files: &HashSet<&str>,
) -> HashMap<(String, String, u32), i64> {
    let mut map = HashMap::new();
    if files.is_empty() {
        return map;
    }

    // Use a temp table to batch all file lookups into a single join query,
    // avoiding N per-file round-trips through prepared-statement execution.
    let _ =
        conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS _analysis_files (file TEXT NOT NULL)");
    let _ = conn.execute("DELETE FROM temp._analysis_files", []);

    if let Ok(mut ins) = conn.prepare("INSERT INTO temp._analysis_files (file) VALUES (?1)") {
        for file in files {
            let _ = ins.execute(rusqlite::params![file]);
        }
    }

    let mut stmt = match conn.prepare(
        "SELECT n.id, n.file, n.name, n.line FROM nodes n \
         INNER JOIN temp._analysis_files af ON n.file = af.file \
         WHERE n.kind != 'file'",
    ) {
        Ok(s) => s,
        Err(_) => return map,
    };

    if let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, u32>(3)?,
        ))
    }) {
        for row in rows.flatten() {
            let (id, file, name, line) = row;
            map.insert((file, name, line), id);
        }
    }

    let _ = conn.execute("DROP TABLE IF EXISTS temp._analysis_files", []);
    map
}

/// Convert FileSymbols AST nodes to FileAstBatch format for `ast::do_insert_ast_nodes`.
fn build_ast_batches(
    file_symbols: &BTreeMap<String, FileSymbols>,
    analysis_files: &HashSet<&str>,
) -> Vec<FileAstBatch> {
    let mut batches = Vec::new();
    for (file, symbols) in file_symbols {
        if !analysis_files.contains(file.as_str()) || symbols.ast_nodes.is_empty() {
            continue;
        }
        batches.push(FileAstBatch {
            file: file.clone(),
            nodes: symbols
                .ast_nodes
                .iter()
                .map(|n| AstInsertNode {
                    line: n.line,
                    kind: n.kind.clone(),
                    name: n.name.clone(),
                    text: n.text.clone(),
                    receiver: n.receiver.clone(),
                })
                .collect(),
        });
    }
    batches
}

/// Write complexity metrics from parsed definitions to the `function_complexity` table.
fn write_complexity(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    analysis_files: &HashSet<&str>,
    node_id_map: &HashMap<(String, String, u32), i64>,
) -> bool {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return false,
    };

    let mut stmt = match tx.prepare(
        "INSERT OR REPLACE INTO function_complexity \
         (node_id, cognitive, cyclomatic, max_nesting, \
          loc, sloc, comment_lines, \
          halstead_n1, halstead_n2, halstead_big_n1, halstead_big_n2, \
          halstead_vocabulary, halstead_length, halstead_volume, \
          halstead_difficulty, halstead_effort, halstead_bugs, \
          maintainability_index) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };

    fn insert_def_complexity(
        stmt: &mut rusqlite::Statement,
        file: &str,
        def: &crate::types::Definition,
        node_id_map: &HashMap<(String, String, u32), i64>,
    ) {
        if let Some(ref cm) = def.complexity {
            let key = (file.to_string(), def.name.clone(), def.line);
            if let Some(&node_id) = node_id_map.get(&key) {
                let h = cm.halstead.as_ref();
                let loc = cm.loc.as_ref();
                let _ = stmt.execute(rusqlite::params![
                    node_id,
                    cm.cognitive,
                    cm.cyclomatic,
                    cm.max_nesting,
                    loc.map(|l| l.loc).unwrap_or(0),
                    loc.map(|l| l.sloc).unwrap_or(0),
                    loc.map(|l| l.comment_lines).unwrap_or(0),
                    h.map(|h| h.n1).unwrap_or(0),
                    h.map(|h| h.n2).unwrap_or(0),
                    h.map(|h| h.big_n1).unwrap_or(0),
                    h.map(|h| h.big_n2).unwrap_or(0),
                    h.map(|h| h.vocabulary).unwrap_or(0),
                    h.map(|h| h.length).unwrap_or(0),
                    h.map(|h| h.volume).unwrap_or(0.0),
                    h.map(|h| h.difficulty).unwrap_or(0.0),
                    h.map(|h| h.effort).unwrap_or(0.0),
                    h.map(|h| h.bugs).unwrap_or(0.0),
                    cm.maintainability_index.unwrap_or(0.0),
                ]);
            }
        }
    }

    for (file, symbols) in file_symbols {
        if !analysis_files.contains(file.as_str()) {
            continue;
        }
        for def in &symbols.definitions {
            insert_def_complexity(&mut stmt, file, def, node_id_map);
            if let Some(ref children) = def.children {
                for child in children {
                    insert_def_complexity(&mut stmt, file, child, node_id_map);
                }
            }
        }
    }

    drop(stmt); // release borrow on tx before commit
    tx.commit().is_ok()
}

/// Write CFG blocks and edges from parsed definitions to DB tables.
fn write_cfg(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    analysis_files: &HashSet<&str>,
    node_id_map: &HashMap<(String, String, u32), i64>,
) -> bool {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return false,
    };

    let mut block_stmt = match tx.prepare(
        "INSERT INTO cfg_blocks \
         (function_node_id, block_index, block_type, start_line, end_line, label) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let mut edge_stmt = match tx.prepare(
        "INSERT INTO cfg_edges \
         (function_node_id, source_block_id, target_block_id, kind) \
         VALUES (?1, ?2, ?3, ?4)",
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };

    for (file, symbols) in file_symbols {
        if !analysis_files.contains(file.as_str()) {
            continue;
        }
        for def in &symbols.definitions {
            write_def_cfg(&tx, &mut block_stmt, &mut edge_stmt, file, def, node_id_map);
            if let Some(ref children) = def.children {
                for child in children {
                    write_def_cfg(
                        &tx,
                        &mut block_stmt,
                        &mut edge_stmt,
                        file,
                        child,
                        node_id_map,
                    );
                }
            }
        }
    }

    drop(block_stmt);
    drop(edge_stmt);
    tx.commit().is_ok()
}

/// Write CFG data for a single definition.
fn write_def_cfg(
    tx: &rusqlite::Transaction,
    block_stmt: &mut rusqlite::Statement,
    edge_stmt: &mut rusqlite::Statement,
    file: &str,
    def: &crate::types::Definition,
    node_id_map: &HashMap<(String, String, u32), i64>,
) {
    let cfg = match &def.cfg {
        Some(c) if !c.blocks.is_empty() => c,
        _ => return,
    };
    let key = (file.to_string(), def.name.clone(), def.line);
    let node_id = match node_id_map.get(&key) {
        Some(&id) => id,
        None => return,
    };

    // Insert blocks and track DB IDs for edge resolution
    let mut block_db_ids: HashMap<u32, i64> = HashMap::new();
    for block in &cfg.blocks {
        if block_stmt
            .execute(rusqlite::params![
                node_id,
                block.index,
                &block.block_type,
                block.start_line,
                block.end_line,
                &block.label,
            ])
            .is_ok()
        {
            block_db_ids.insert(block.index, tx.last_insert_rowid());
        }
    }

    // Insert edges using resolved block DB IDs
    for edge in &cfg.edges {
        if let (Some(&src), Some(&tgt)) = (
            block_db_ids.get(&edge.source_index),
            block_db_ids.get(&edge.target_index),
        ) {
            let _ = edge_stmt.execute(rusqlite::params![node_id, src, tgt, &edge.kind]);
        }
    }
}

/// Write dataflow edges from parsed FileSymbols to the `dataflow` table.
/// Resolves function names to node IDs using the DB, mirroring the JS
/// `makeNodeResolver` logic (prefer same-file match, fall back to global).
fn write_dataflow(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    analysis_files: &HashSet<&str>,
) -> bool {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return false,
    };

    let mut insert_stmt = match tx.prepare(
        "INSERT INTO dataflow \
         (source_id, target_id, kind, param_index, expression, line, confidence) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let mut local_stmt = match tx.prepare(
        "SELECT id FROM nodes WHERE name = ?1 AND file = ?2 \
         AND kind IN ('function','method') LIMIT 1",
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let mut global_stmt = match tx.prepare(
        "SELECT id FROM nodes WHERE name = ?1 \
         AND kind IN ('function','method') \
         ORDER BY file, line LIMIT 1",
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };

    for (file, symbols) in file_symbols {
        if !analysis_files.contains(file.as_str()) {
            continue;
        }
        let data = match &symbols.dataflow {
            Some(d) => d,
            None => continue,
        };
        write_dataflow_arg_flows(
            &mut insert_stmt,
            &mut local_stmt,
            &mut global_stmt,
            data,
            file,
        );
        write_dataflow_assignments(
            &mut insert_stmt,
            &mut local_stmt,
            &mut global_stmt,
            data,
            file,
        );
        write_dataflow_mutations(
            &mut insert_stmt,
            &mut local_stmt,
            &mut global_stmt,
            data,
            file,
        );
    }

    drop(insert_stmt);
    drop(local_stmt);
    drop(global_stmt);
    tx.commit().is_ok()
}

/// Emit `flows_to` edges for each argFlow entry: caller → callee via argument passing.
fn write_dataflow_arg_flows(
    insert_stmt: &mut rusqlite::Statement,
    local_stmt: &mut rusqlite::Statement,
    global_stmt: &mut rusqlite::Statement,
    data: &crate::types::DataflowResult,
    file: &str,
) {
    for flow in &data.arg_flows {
        let caller = match &flow.caller_func {
            Some(name) => name.as_str(),
            None => continue,
        };
        let src = resolve_dataflow_node(local_stmt, global_stmt, caller, file);
        let tgt = resolve_dataflow_node(local_stmt, global_stmt, &flow.callee_name, file);
        if let (Some(src), Some(tgt)) = (src, tgt) {
            let _ = insert_stmt.execute(rusqlite::params![
                src,
                tgt,
                "flows_to",
                flow.arg_index,
                &flow.expression,
                flow.line,
                flow.confidence,
            ]);
        }
    }
}

/// Emit `returns` edges for each assignment entry: producer → consumer via
/// return-value assignment (`const x = callee()`).
fn write_dataflow_assignments(
    insert_stmt: &mut rusqlite::Statement,
    local_stmt: &mut rusqlite::Statement,
    global_stmt: &mut rusqlite::Statement,
    data: &crate::types::DataflowResult,
    file: &str,
) {
    for assignment in &data.assignments {
        let consumer = match &assignment.caller_func {
            Some(name) => name.as_str(),
            None => continue,
        };
        let producer =
            resolve_dataflow_node(local_stmt, global_stmt, &assignment.source_call_name, file);
        let consumer_id = resolve_dataflow_node(local_stmt, global_stmt, consumer, file);
        if let (Some(producer), Some(consumer_id)) = (producer, consumer_id) {
            let _ = insert_stmt.execute(rusqlite::params![
                producer,
                consumer_id,
                "returns",
                Option::<u32>::None,
                &assignment.expression,
                assignment.line,
                1.0_f64,
            ]);
        }
    }
}

/// Emit `mutates` edges for param-binding mutation entries. Only fires for
/// mutations where `binding_type == "param"` — other mutation kinds are
/// informational and not persisted as dataflow edges.
fn write_dataflow_mutations(
    insert_stmt: &mut rusqlite::Statement,
    local_stmt: &mut rusqlite::Statement,
    global_stmt: &mut rusqlite::Statement,
    data: &crate::types::DataflowResult,
    file: &str,
) {
    for mutation in &data.mutations {
        if mutation.binding_type.as_deref() != Some("param") {
            continue;
        }
        let func = match &mutation.func_name {
            Some(name) => name.as_str(),
            None => continue,
        };
        if let Some(node_id) = resolve_dataflow_node(local_stmt, global_stmt, func, file) {
            let _ = insert_stmt.execute(rusqlite::params![
                node_id,
                node_id,
                "mutates",
                Option::<u32>::None,
                &mutation.mutating_expr,
                mutation.line,
                1.0_f64,
            ]);
        }
    }
}

/// Resolve a function name to a node ID, trying same-file first then global.
/// Mirrors the JS `makeNodeResolver` logic from `features/dataflow.ts`.
fn resolve_dataflow_node(
    local_stmt: &mut rusqlite::Statement,
    global_stmt: &mut rusqlite::Statement,
    name: &str,
    file: &str,
) -> Option<i64> {
    if let Ok(id) = local_stmt.query_row(rusqlite::params![name, file], |r| r.get::<_, i64>(0)) {
        return Some(id);
    }
    global_stmt
        .query_row(rusqlite::params![name], |r| r.get::<_, i64>(0))
        .ok()
}

/// Current time in milliseconds since epoch.
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Import, PathAliases};

    fn make_import_ctx(file_symbols: &BTreeMap<String, FileSymbols>) -> ImportEdgeContext {
        let mut batch_resolved = HashMap::new();
        batch_resolved.insert(
            "/repo/driver.js|./service.js".to_string(),
            "service.js".to_string(),
        );
        ImportEdgeContext {
            batch_resolved,
            reexport_map: HashMap::new(),
            barrel_only_files: HashSet::new(),
            file_symbols: file_symbols.clone(),
            root_dir: "/repo".to_string(),
            aliases: PathAliases {
                base_url: None,
                paths: vec![],
            },
            known_files: HashSet::new(),
            workspaces: HashMap::new(),
        }
    }

    fn entry(name: &str, type_name: &str, confidence: f64) -> TypeMapEntry {
        TypeMapEntry {
            name: name.to_string(),
            type_name: type_name.to_string(),
            confidence,
        }
    }

    #[test]
    fn propagates_imported_factory_return_type_into_type_map() {
        let mut service = FileSymbols::new("service.js".to_string());
        service
            .return_type_map
            .push(entry("buildService", "UserService", 0.85));

        let mut driver = FileSymbols::new("driver.js".to_string());
        driver.imports.push(Import::new(
            "./service.js".to_string(),
            vec!["buildService".to_string()],
            1,
        ));
        driver
            .call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "svc".to_string(),
                callee_name: "buildService".to_string(),
                receiver_type_name: None,
                receiver_var_name: None,
                unwrap_depth: 0,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("service.js".to_string(), service);
        file_symbols.insert("driver.js".to_string(), driver);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let driver = &file_symbols["driver.js"];
        let seeded = driver
            .type_map
            .iter()
            .find(|t| t.name == "svc")
            .expect("svc should be seeded from buildService's return type");
        assert_eq!(seeded.type_name, "UserService");
        // 0.85 (inferred `return new X()`) minus one propagation hop.
        assert!((seeded.confidence - 0.75).abs() < 1e-9);
    }

    #[test]
    fn qualified_receiver_lookup_uses_global_return_type_map() {
        let mut factory = FileSymbols::new("factory.js".to_string());
        factory
            .return_type_map
            .push(entry("Factory.create", "Widget", 1.0));

        let mut driver = FileSymbols::new("driver.js".to_string());
        driver.type_map.push(entry("factory", "Factory", 0.9));
        driver
            .call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "w".to_string(),
                callee_name: "create".to_string(),
                receiver_type_name: Some("Factory".to_string()),
                receiver_var_name: None,
                unwrap_depth: 0,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("factory.js".to_string(), factory);
        file_symbols.insert("driver.js".to_string(), driver);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let driver = &file_symbols["driver.js"];
        let seeded = driver
            .type_map
            .iter()
            .find(|t| t.name == "w")
            .expect("w seeded");
        assert_eq!(seeded.type_name, "Widget");
        assert!((seeded.confidence - 0.9).abs() < 1e-9);
    }

    // ── if-let/while-let Option/Result unwrap + two-hop receiver resolution (#2214) ─

    #[test]
    fn unwraps_option_return_type_for_if_let_bound_call_assignment() {
        let mut service = FileSymbols::new("service.rs".to_string());
        service
            .return_type_map
            .push(entry("UserService.get_user", "Option<User>", 1.0));

        let mut main = FileSymbols::new("main.rs".to_string());
        // `service`'s own type is already resolved locally — simulating that its
        // cross-file call-assignment was injected earlier in this same pass.
        main.type_map.push(entry("service", "UserService", 0.9));
        main.call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "user".to_string(),
                callee_name: "get_user".to_string(),
                receiver_type_name: None,
                receiver_var_name: Some("service".to_string()),
                unwrap_depth: 1,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("service.rs".to_string(), service);
        file_symbols.insert("main.rs".to_string(), main);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let main = &file_symbols["main.rs"];
        let seeded = main
            .type_map
            .iter()
            .find(|t| t.name == "user")
            .expect("user should be seeded, unwrapped from Option<User>");
        assert_eq!(seeded.type_name, "User");
    }

    #[test]
    fn declines_to_inject_when_unwrap_generic_but_declared_type_is_not_generic() {
        let mut service = FileSymbols::new("service.rs".to_string());
        // Declared type doesn't actually match the if-let's Some/Ok assumption —
        // a mismatch between the pattern and the callee's real signature.
        service
            .return_type_map
            .push(entry("UserService.get_user", "User", 1.0));

        let mut main = FileSymbols::new("main.rs".to_string());
        main.type_map.push(entry("service", "UserService", 0.9));
        main.call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "user".to_string(),
                callee_name: "get_user".to_string(),
                receiver_type_name: None,
                receiver_var_name: Some("service".to_string()),
                unwrap_depth: 1,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("service.rs".to_string(), service);
        file_symbols.insert("main.rs".to_string(), main);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let main = &file_symbols["main.rs"];
        assert!(main.type_map.iter().all(|t| t.name != "user"));
    }

    #[test]
    fn resolves_receiver_var_name_via_type_map_when_receiver_type_name_absent() {
        let mut repo = FileSymbols::new("repo.rs".to_string());
        repo.return_type_map
            .push(entry("UserRepository.find_by_id", "User", 1.0));

        let mut main = FileSymbols::new("main.rs".to_string());
        main.type_map.push(entry("repo", "UserRepository", 1.0));
        main.call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "user".to_string(),
                callee_name: "find_by_id".to_string(),
                receiver_type_name: None,
                receiver_var_name: Some("repo".to_string()),
                unwrap_depth: 0,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("repo.rs".to_string(), repo);
        file_symbols.insert("main.rs".to_string(), main);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let main = &file_symbols["main.rs"];
        let seeded =
            main.type_map.iter().find(|t| t.name == "user").expect(
                "user should resolve via receiver_var_name -> type_map -> global_return_types",
            );
        assert_eq!(seeded.type_name, "User");
    }

    #[test]
    fn locally_typed_variables_are_not_overwritten() {
        let mut service = FileSymbols::new("service.js".to_string());
        service
            .return_type_map
            .push(entry("buildService", "UserService", 0.85));

        let mut driver = FileSymbols::new("driver.js".to_string());
        driver.imports.push(Import::new(
            "./service.js".to_string(),
            vec!["buildService".to_string()],
            1,
        ));
        driver.type_map.push(entry("svc", "LocalOverride", 1.0));
        driver
            .call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "svc".to_string(),
                callee_name: "buildService".to_string(),
                receiver_type_name: None,
                receiver_var_name: None,
                unwrap_depth: 0,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("service.js".to_string(), service);
        file_symbols.insert("driver.js".to_string(), driver);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let driver = &file_symbols["driver.js"];
        let svc_entries: Vec<_> = driver.type_map.iter().filter(|t| t.name == "svc").collect();
        assert_eq!(
            svc_entries.len(),
            1,
            "no duplicate entry should be injected"
        );
        assert_eq!(svc_entries[0].type_name, "LocalOverride");
    }

    #[test]
    fn unwrap_option_result_type_unwraps_option() {
        assert_eq!(unwrap_option_result_type("Option<User>"), Some("User"));
    }

    #[test]
    fn unwrap_option_result_type_unwraps_result_taking_the_first_type_argument() {
        assert_eq!(
            unwrap_option_result_type("Result<User, String>"),
            Some("User")
        );
    }

    #[test]
    fn unwrap_option_result_type_normalizes_an_ordinary_generic_inner_type_to_its_bare_name() {
        // Result<Vec<User>, String>'s inner type argument is itself a generic —
        // the unwrapped type must be bare "Vec", matching how a direct
        // `let x: Vec<User> = ...` annotation would type it, not the
        // parameterized "Vec<User>" (Greptile review, PR #2371).
        assert_eq!(
            unwrap_option_result_type("Result<Vec<User>, String>"),
            Some("Vec")
        );
    }

    #[test]
    fn unwrap_option_result_type_keeps_a_nested_option_result_inner_type_parameterized() {
        // if-let only strips one layer — Option<Option<User>>'s inner type
        // argument is itself Option/Result, so it keeps its own type argument
        // (needed for a later unwrap), unlike an ordinary generic.
        assert_eq!(
            unwrap_option_result_type("Option<Option<User>>"),
            Some("Option<User>")
        );
    }

    #[test]
    fn unwrap_option_result_type_strips_a_reference_sigil() {
        // Option<&User>'s bound value's real receiver type is User, not the
        // reference syntax around it (Greptile review, PR #2371).
        assert_eq!(unwrap_option_result_type("Option<&User>"), Some("User"));
    }

    #[test]
    fn end_to_end_injects_bare_nominal_type_for_a_reference_wrapped_option() {
        let mut service = FileSymbols::new("service.rs".to_string());
        service
            .return_type_map
            .push(entry("UserService.get_user_ref", "Option<&User>", 1.0));

        let mut main = FileSymbols::new("main.rs".to_string());
        main.type_map.push(entry("service", "UserService", 0.9));
        main.call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "user".to_string(),
                callee_name: "get_user_ref".to_string(),
                receiver_type_name: None,
                receiver_var_name: Some("service".to_string()),
                unwrap_depth: 1,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("service.rs".to_string(), service);
        file_symbols.insert("main.rs".to_string(), main);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let main = &file_symbols["main.rs"];
        let seeded = main
            .type_map
            .iter()
            .find(|t| t.name == "user")
            .expect("user should be seeded, unwrapped from Option<&User> to bare User");
        assert_eq!(seeded.type_name, "User");
    }

    #[test]
    fn end_to_end_injects_correctly_for_a_doubly_nested_option_at_depth_two() {
        // `if let Some(Some(user)) = get_nested_option()` — the callee's
        // Option<Option<User>> return must be unwrapped twice, not once
        // (Greptile review, PR #2371).
        let mut service = FileSymbols::new("service.js".to_string());
        service
            .return_type_map
            .push(entry("get_nested_option", "Option<Option<User>>", 1.0));

        let mut driver = FileSymbols::new("driver.js".to_string());
        driver.imports.push(Import::new(
            "./service.js".to_string(),
            vec!["get_nested_option".to_string()],
            1,
        ));
        driver
            .call_assignments
            .push(crate::types::NativeCallAssignment {
                var_name: "user".to_string(),
                callee_name: "get_nested_option".to_string(),
                receiver_type_name: None,
                receiver_var_name: None,
                unwrap_depth: 2,
            });

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("service.js".to_string(), service);
        file_symbols.insert("driver.js".to_string(), driver);
        let import_ctx = make_import_ctx(&file_symbols);

        let conn = Connection::open_in_memory().unwrap();
        propagate_return_types_across_files(&conn, &mut file_symbols, &import_ctx);

        let driver = &file_symbols["driver.js"];
        let seeded = driver
            .type_map
            .iter()
            .find(|t| t.name == "user")
            .expect("user should be seeded, unwrapped twice from Option<Option<User>> to User");
        assert_eq!(seeded.type_name, "User");
    }

    #[test]
    fn unwrap_option_result_type_strips_a_mut_reference_with_a_lifetime() {
        assert_eq!(
            unwrap_option_result_type("Result<&'a mut User, String>"),
            Some("User")
        );
    }

    #[test]
    fn unwrap_option_result_type_returns_none_for_a_non_generic_type() {
        assert_eq!(unwrap_option_result_type("User"), None);
    }

    #[test]
    fn unwrap_option_result_type_returns_none_for_an_unrelated_generic() {
        assert_eq!(unwrap_option_result_type("Vec<User>"), None);
    }

    #[test]
    fn unwrap_option_result_type_unwraps_a_fully_qualified_option() {
        // `fn f() -> std::option::Option<User>` is valid Rust and just as common
        // as the bare `Option<User>` spelling in no-std or disambiguating code
        // (Greptile review, PR #2371).
        assert_eq!(
            unwrap_option_result_type("std::option::Option<User>"),
            Some("User")
        );
    }

    fn changed_file(rel_path: &str, hash: &str) -> detect_changes::ChangedFile {
        detect_changes::ChangedFile {
            abs_path: format!("/repo/{rel_path}"),
            rel_path: rel_path.to_string(),
            content: None,
            hash: Some(hash.to_string()),
            mtime: 1000,
            size: 10,
            metadata_only: false,
            reverse_dep_only: false,
        }
    }

    // Issue #2441: a changed file whose extraction failed outright (worker
    // panic recovery, unreadable, unsupported/missing grammar) has no entry
    // in file_symbols at all — must not get a committed hash, or the next
    // incremental build wrongly believes its (missing) graph data is up to
    // date with the file's new content, permanently hiding the loss.
    #[test]
    fn skips_a_changed_file_with_no_file_symbols_entry() {
        let ok = changed_file("a.js", "hash-a");
        let failed = changed_file("b.js", "hash-b");
        let changed: Vec<&detect_changes::ChangedFile> = vec![&ok, &failed];

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert("a.js".to_string(), FileSymbols::new("a.js".to_string()));
        // "b.js" intentionally has no entry — simulates a parse failure.

        let entries = build_file_hash_entries(&changed, &file_symbols);
        let files: Vec<&str> = entries.iter().map(|e| e.file.as_str()).collect();
        assert_eq!(files, vec!["a.js"]);
    }

    // A file that parsed successfully but legitimately produced zero symbols
    // (empty file, parser no-op) DOES get a file_symbols entry (with empty
    // definitions/exports) — it must still get a committed hash, or the
    // no-op fast-skip pre-flight on the next rebuild would reject it as
    // "missing from file_hashes" and force a full rebuild.
    #[test]
    fn still_includes_a_changed_file_that_parsed_with_zero_symbols() {
        let empty = changed_file("empty.js", "hash-empty");
        let changed: Vec<&detect_changes::ChangedFile> = vec![&empty];

        let mut file_symbols = BTreeMap::new();
        file_symbols.insert(
            "empty.js".to_string(),
            FileSymbols::new("empty.js".to_string()),
        );

        let entries = build_file_hash_entries(&changed, &file_symbols);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file, "empty.js");
    }
}
