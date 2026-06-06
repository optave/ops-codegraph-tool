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
//! 5. Insert nodes (existing `insert_nodes::do_insert_nodes`)
//! 6. Resolve imports (existing `import_resolution::resolve_imports_batch`)
//! 6b. Re-parse barrel candidates (incremental only)
//! 7. Build import edges + call edges + barrel resolution
//! 8. Structure metrics + role classification
//! 9. Finalize (metadata, journal)

use crate::change_detection;
use crate::config::{BuildConfig, BuildOpts, BuildPathAliases};
use crate::constants::{FAST_PATH_MAX_CHANGED_FILES, FAST_PATH_MIN_EXISTING_FILES};
use crate::file_collector;
use crate::import_edges::{self, ImportEdgeContext};
use crate::import_resolution;
use crate::journal;
use crate::parallel;
use crate::ast_db::{self, AstInsertNode, FileAstBatch};
use crate::roles_db;
use crate::structure;
use crate::types::{FileSymbols, ImportResolutionInput};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

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
}

fn pipeline_setup(
    conn: &Connection,
    config_json: &str,
    aliases_json: &str,
    opts_json: &str,
) -> Result<PipelineSetup, String> {
    let config: BuildConfig =
        serde_json::from_str(config_json).map_err(|e| format!("config parse error: {e}"))?;
    let aliases: BuildPathAliases =
        serde_json::from_str(aliases_json).map_err(|e| format!("aliases parse error: {e}"))?;
    let opts: BuildOpts =
        serde_json::from_str(opts_json).map_err(|e| format!("opts parse error: {e}"))?;

    let napi_aliases = aliases.to_napi_aliases();
    let incremental = opts.incremental.unwrap_or(config.build.incremental);
    let include_dataflow = opts.dataflow.unwrap_or(true);
    let include_ast = opts.ast.unwrap_or(true);
    let force_full_rebuild = check_version_mismatch(conn);

    Ok(PipelineSetup {
        config,
        napi_aliases,
        opts,
        incremental,
        include_dataflow,
        include_ast,
        force_full_rebuild,
    })
}

/// Build a no-op early-exit result when no source files changed and we are
/// in an incremental build with no removals. Mirrors the early-exit branch
/// in `run_pipeline` exactly so it can be lifted out without behaviour change.
fn early_exit_result(
    file_count: usize,
    timing: PipelineTiming,
    conn: &Connection,
    root_dir: &str,
    metadata_updates: &[change_detection::MetadataUpdate],
) -> BuildPipelineResult {
    change_detection::heal_metadata(conn, metadata_updates);
    journal::write_journal_header(root_dir, now_ms());
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

/// Save reverse-dep edges (and reverse-deps of removed files) before purging
/// changed files. Mirrors the JS save-then-purge sequence in `build-edges.ts`
/// (#1012). Returns `(saved_reverse_dep_edges, removal_reverse_deps)` so the
/// pipeline can reconnect them after Stage 5 and reclassify roles in Stage 8.
fn save_and_purge_changed(
    conn: &Connection,
    parse_changes: &[&change_detection::ChangedFile],
    change_result: &change_detection::ChangeResult,
    opts: &BuildOpts,
    root_dir: &str,
) -> (Vec<change_detection::SavedReverseDepEdge>, Vec<String>) {
    let mut saved_reverse_dep_edges: Vec<change_detection::SavedReverseDepEdge> = Vec::new();
    let mut removal_reverse_deps: Vec<String> = Vec::new();

    if change_result.is_full_build {
        let has_embeddings = change_detection::has_embeddings(conn);
        change_detection::clear_all_graph_data(conn, has_embeddings);
        return (saved_reverse_dep_edges, removal_reverse_deps);
    }

    let changed_paths: Vec<String> = parse_changes.iter().map(|c| c.rel_path.clone()).collect();

    if !opts.no_reverse_deps.unwrap_or(false) {
        saved_reverse_dep_edges = change_detection::save_reverse_dep_edges(conn, &changed_paths);

        if !change_result.removed.is_empty() {
            let removed_set: HashSet<String> = change_result.removed.iter().cloned().collect();
            removal_reverse_deps =
                change_detection::find_reverse_dependencies(conn, &removed_set, root_dir)
                    .into_iter()
                    .collect();
        }
    }

    let files_to_purge: Vec<String> = change_result
        .removed
        .iter()
        .chain(parse_changes.iter().map(|c| &c.rel_path))
        .cloned()
        .collect();
    change_detection::purge_changed_files(conn, &files_to_purge, &[]);

    (saved_reverse_dep_edges, removal_reverse_deps)
}

/// Parse a changed-file slice in parallel and key the results by relative path.
fn parse_and_index_files(
    parse_changes: &[&change_detection::ChangedFile],
    root_dir: &str,
    include_dataflow: bool,
    include_ast: bool,
) -> HashMap<String, FileSymbols> {
    let files_to_parse: Vec<String> =
        parse_changes.iter().map(|c| c.abs_path.clone()).collect();
    let parsed =
        parallel::parse_files_parallel(&files_to_parse, root_dir, include_dataflow, include_ast);
    let mut file_symbols: HashMap<String, FileSymbols> = HashMap::new();
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
    file_symbols: &HashMap<String, FileSymbols>,
    collect_files: &[String],
    root_dir: &str,
    napi_aliases: &crate::types::PathAliases,
) -> (HashMap<String, String>, HashSet<String>) {
    let mut batch_inputs: Vec<ImportResolutionInput> = Vec::new();
    for (rel_path, symbols) in file_symbols {
        let abs_file = Path::new(root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("").replace('\\', "/");
        for imp in &symbols.imports {
            batch_inputs.push(ImportResolutionInput {
                from_file: abs_str.clone(),
                import_source: imp.source.clone(),
            });
        }
    }
    let known_files: HashSet<String> =
        collect_files.iter().map(|f| relative_path(root_dir, f)).collect();
    let resolved =
        import_resolution::resolve_imports_batch(&batch_inputs, root_dir, napi_aliases, Some(&known_files));
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
    saved: &[change_detection::SavedReverseDepEdge],
) {
    if saved.is_empty() {
        return;
    }
    let (reconnected, dropped) = change_detection::reconnect_reverse_dep_edges(conn, saved);
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
fn run_structure_phase(
    conn: &Connection,
    file_symbols: &HashMap<String, FileSymbols>,
    collect_directories: &HashSet<String>,
    root_dir: &str,
    line_count_map: &HashMap<String, i64>,
    parse_changes_len: usize,
    is_full_build: bool,
) {
    let changed_files: Vec<String> = file_symbols.keys().cloned().collect();
    let existing_file_count = structure::get_existing_file_count(conn);
    let use_fast_path = !is_full_build
        && parse_changes_len <= FAST_PATH_MAX_CHANGED_FILES
        && existing_file_count > FAST_PATH_MIN_EXISTING_FILES;

    if use_fast_path {
        structure::update_changed_file_metrics(conn, &changed_files, line_count_map, file_symbols);
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
    file_symbols: &HashMap<String, FileSymbols>,
    removal_reverse_deps: Vec<String>,
    is_full_build: bool,
) {
    let changed_files: Vec<String> = file_symbols.keys().cloned().collect();
    let changed_file_list: Option<Vec<String>> = if is_full_build {
        None
    } else {
        let mut files = changed_files;
        if !removal_reverse_deps.is_empty() {
            let existing: HashSet<String> = files.iter().cloned().collect();
            for f in removal_reverse_deps {
                if !existing.contains(&f) {
                    files.push(f);
                }
            }
        }
        Some(files)
    };
    if let Some(ref files) = changed_file_list {
        if !files.is_empty() {
            let _ = roles_db::do_classify_incremental(conn, files);
        }
    } else {
        let _ = roles_db::do_classify_full(conn);
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
    file_symbols: &HashMap<String, FileSymbols>,
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
        return AnalysisPersistenceResult { ran: false, ok: true };
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
        if ast_db::do_insert_ast_nodes(conn, &ast_batches).is_err() {
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

    AnalysisPersistenceResult { ran: do_analysis, ok: analysis_ok }
}

/// Run the full build pipeline in Rust.
///
/// Called from `NativeDatabase.build_graph()` via napi.
pub fn run_pipeline(
    conn: &Connection,
    root_dir: &str,
    config_json: &str,
    aliases_json: &str,
    opts_json: &str,
) -> Result<BuildPipelineResult, String> {
    let total_start = Instant::now();
    let mut timing = PipelineTiming::default();

    // ── Stage 1: Deserialize config ────────────────────────────────────
    let t0 = Instant::now();
    let setup = pipeline_setup(conn, config_json, aliases_json, opts_json)?;
    let PipelineSetup {
        config,
        napi_aliases,
        opts,
        incremental,
        include_dataflow,
        include_ast,
        force_full_rebuild,
    } = setup;
    timing.setup_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 2: Collect files ─────────────────────────────────────────
    let t0 = Instant::now();
    // For scoped builds, track all scoped relative paths (including deleted files)
    // so detect_removed_files only flags scoped files as removed, not everything.
    let scoped_rel_paths: Option<HashSet<String>> = opts.scope.as_ref().map(|scope| {
        scope
            .iter()
            .map(|f| normalize_path(f))
            .collect()
    });
    let collect_result = collect_source_files(conn, root_dir, &config, &opts, incremental, force_full_rebuild);
    timing.collect_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 3: Detect changes ────────────────────────────────────────
    let t0 = Instant::now();
    let change_result = change_detection::detect_changes(
        conn,
        &collect_result.files,
        root_dir,
        incremental,
        force_full_rebuild,
        scoped_rel_paths.as_ref(),
    );
    timing.detect_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // Filter out metadata-only changes
    let parse_changes: Vec<&change_detection::ChangedFile> = change_result
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
            root_dir,
            &change_result.metadata_updates,
        ));
    }

    // Stage 3b: save reverse-dep edges (incremental) or clear all (full),
    // then purge changed files. Returns the saved edges for Stage 7
    // reconnect and the removal reverse-dep set for Stage 8 reclassification.
    let (saved_reverse_dep_edges, removal_reverse_deps) =
        save_and_purge_changed(conn, &parse_changes, &change_result, &opts, root_dir);

    // ── Stage 4: Parse files ───────────────────────────────────────────
    // Only truly-changed files are parsed. Reverse-dep files are not re-parsed —
    // their edges to changed files are reconstructed via save+reconnect (#1012).
    let t0 = Instant::now();
    let mut file_symbols =
        parse_and_index_files(&parse_changes, root_dir, include_dataflow, include_ast);
    timing.parse_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 5: Insert nodes ──────────────────────────────────────────
    let t0 = Instant::now();
    let insert_batches = build_insert_batches(&file_symbols);
    let file_hashes = build_file_hash_entries(&parse_changes);
    let _ = crate::insert_nodes::do_insert_nodes(
        conn,
        &insert_batches,
        &file_hashes,
        &change_result.removed,
    );
    change_detection::heal_metadata(conn, &change_result.metadata_updates);
    timing.insert_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 6: Resolve imports ───────────────────────────────────────
    let t0 = Instant::now();
    let (mut batch_resolved, known_files) =
        resolve_pipeline_imports(&file_symbols, &collect_result.files, root_dir, &napi_aliases);
    timing.resolve_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 6b: Re-parse barrel candidates (incremental only) ─────────
    if !change_result.is_full_build {
        reparse_barrel_candidates(
            conn, root_dir, &napi_aliases, &known_files,
            &mut file_symbols, &mut batch_resolved,
        );
    }

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
    };

    // Build reexport map and detect barrel files
    import_ctx.reexport_map = import_edges::build_reexport_map(&import_ctx);
    import_ctx.barrel_only_files = import_edges::detect_barrel_only_files(&import_ctx);

    // Build import edges
    let import_edge_rows = import_edges::build_import_edges(conn, &import_ctx);
    import_edges::insert_edges(conn, &import_edge_rows);

    // Build call edges using existing Rust edge_builder (internal path)
    // For now, call edges are built via the existing napi-exported function's
    // internal logic. We load nodes from DB and pass to the edge builder.
    build_and_insert_call_edges(conn, &file_symbols, &import_ctx, !change_result.is_full_build);

    reconnect_saved_reverse_dep_edges(conn, &saved_reverse_dep_edges);
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
        change_result.is_full_build,
    );
    timing.structure_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t0 = Instant::now();
    run_role_classification(
        conn,
        &file_symbols,
        removal_reverse_deps,
        change_result.is_full_build,
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
    let (node_count, edge_count) = finalize_build(conn, root_dir);
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
) -> file_collector::CollectResult {
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
        file_collector::CollectResult {
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
        let journal = journal::read_journal(root_dir);
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
                file_collector::try_fast_collect(
                    root_dir,
                    &db_files,
                    &journal.changed,
                    &journal.removed,
                    &config.include,
                    &config.exclude,
                )
            } else {
                file_collector::collect_files(
                    root_dir,
                    &config.ignore_dirs,
                    &config.include,
                    &config.exclude,
                )
            }
        } else {
            file_collector::collect_files(
                root_dir,
                &config.ignore_dirs,
                &config.include,
                &config.exclude,
            )
        }
    } else {
        file_collector::collect_files(
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
fn reparse_barrel_candidates(
    conn: &Connection,
    root_dir: &str,
    napi_aliases: &crate::types::PathAliases,
    known_files: &HashSet<String>,
    file_symbols: &mut HashMap<String, FileSymbols>,
    batch_resolved: &mut HashMap<String, String>,
) {
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
            let _ = conn.execute(
                "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) \
                 AND kind NOT IN ('contains', 'parameter_of')",
                rusqlite::params![&rel],
            );
            // Re-resolve imports for the barrel file
            // Normalize to forward slashes so batch_resolved keys match get_resolved lookups on Windows.
            let abs_str =
                Path::new(root_dir).join(&rel).to_str().unwrap_or("").replace('\\', "/");
            for imp in &sym.imports {
                let input = ImportResolutionInput {
                    from_file: abs_str.clone(),
                    import_source: imp.source.clone(),
                };
                let resolved_batch = import_resolution::resolve_imports_batch(
                    &[input],
                    root_dir,
                    napi_aliases,
                    Some(known_files),
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
    }
}

/// Walk the imports of `from_files` and return absolute paths of any barrel
/// candidates (files in `barrel_files_in_db` not yet in `file_symbols`) that
/// exist on disk.
fn collect_imported_barrel_candidates(
    root_dir: &str,
    from_files: &[String],
    batch_resolved: &HashMap<String, String>,
    barrel_files_in_db: &HashSet<String>,
    file_symbols: &HashMap<String, FileSymbols>,
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
                if barrel_files_in_db.contains(resolved)
                    && !file_symbols.contains_key(resolved)
                {
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
    file_symbols: &HashMap<String, FileSymbols>,
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
        if let Ok(rows) =
            stmt.query_map(rusqlite::params![changed], |row| row.get::<_, String>(0))
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
fn finalize_build(conn: &Connection, root_dir: &str) -> (i64, i64) {
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
    journal::write_journal_header(root_dir, now_ms());
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
    file_symbols: &HashMap<String, FileSymbols>,
) -> Vec<crate::insert_nodes::InsertNodesBatch> {
    file_symbols
        .iter()
        .map(
            |(rel_path, symbols)| crate::insert_nodes::InsertNodesBatch {
                file: rel_path.clone(),
                definitions: symbols
                    .definitions
                    .iter()
                    .map(|d| crate::insert_nodes::InsertNodesDefinition {
                        name: d.name.clone(),
                        kind: d.kind.clone(),
                        line: d.line,
                        end_line: d.end_line,
                        visibility: None,
                        children: d
                            .children
                            .as_ref()
                            .map(|kids| {
                                kids.iter()
                                    .map(|c| crate::insert_nodes::InsertNodesChild {
                                        name: c.name.clone(),
                                        kind: c.kind.clone(),
                                        line: c.line,
                                        end_line: c.end_line,
                                        visibility: None,
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                    .collect(),
                exports: symbols
                    .exports
                    .iter()
                    .map(|e| crate::insert_nodes::InsertNodesExport {
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
fn build_file_hash_entries(
    changed: &[&change_detection::ChangedFile],
) -> Vec<crate::insert_nodes::FileHashEntry> {
    changed
        .iter()
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
            Some(crate::insert_nodes::FileHashEntry {
                file: c.rel_path.clone(),
                hash,
                mtime,
                size,
            })
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
        "console", "Math", "JSON", "Object", "Array", "String", "Number",
        "Boolean", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
        "Promise", "Symbol", "Error", "TypeError", "RangeError", "Proxy",
        "Reflect", "Intl", "globalThis", "window", "document", "process",
        "Buffer", "require",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

const EDGE_NODE_KIND_FILTER: &str = "kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant')";

/// For the scoped (incremental, small-batch) path of the edge builder,
/// compute the set of files that must be loaded: changed/reverse-dep files
/// plus their direct import targets plus barrel-only files plus the
/// ultimate definition files barrel chains resolve to. Mirrors the JS
/// `relevantFiles` accumulation in `loadNodes` (#976, greptile P1).
fn compute_edge_relevant_files(
    file_symbols: &HashMap<String, FileSymbols>,
    import_ctx: &crate::import_edges::ImportEdgeContext,
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
                        relevant_files.insert(ultimate);
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
    file_symbols: &HashMap<String, FileSymbols>,
    import_ctx: &crate::import_edges::ImportEdgeContext,
    is_incremental: bool,
) -> Vec<crate::edge_builder::NodeInfo> {
    use crate::edge_builder::NodeInfo;

    let existing_file_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM nodes WHERE kind = 'file'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let scope_eligible = is_incremental
        && file_symbols.len() <= crate::constants::FAST_PATH_MAX_CHANGED_FILES
        && existing_file_count > crate::constants::FAST_PATH_MIN_EXISTING_FILES;

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
        "SELECT n.id, n.name, n.kind, n.file, n.line FROM nodes n \
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
fn load_all_edge_nodes(conn: &Connection) -> Vec<crate::edge_builder::NodeInfo> {
    let sql = format!(
        "SELECT id, name, kind, file, line FROM nodes WHERE {EDGE_NODE_KIND_FILTER}",
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
fn read_edge_node_info(row: &rusqlite::Row) -> rusqlite::Result<crate::edge_builder::NodeInfo> {
    Ok(crate::edge_builder::NodeInfo {
        id: row.get::<_, i64>(0)? as u32,
        name: row.get(1)?,
        kind: row.get(2)?,
        file: row.get(3)?,
        line: row.get::<_, i64>(4)? as u32,
    })
}

/// Load all `file`-kind node IDs into a flat map (one query instead of one
/// per file). The `name = file` guard avoids accidentally overwriting the
/// map entry when an unrelated row happens to share the file path (#1028).
fn load_file_node_id_map(conn: &Connection) -> HashMap<String, u32> {
    let mut map = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT file, id FROM nodes WHERE kind = 'file' AND line = 0 AND name = file",
    ) {
        if let Ok(rows) =
            stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32)))
        {
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
fn collect_imported_names_for_file(
    abs_str: &str,
    symbols: &FileSymbols,
    import_ctx: &crate::import_edges::ImportEdgeContext,
) -> Vec<crate::edge_builder::ImportedName> {
    use crate::edge_builder::ImportedName;
    let mut imported_names: Vec<ImportedName> = Vec::new();
    for imp in &symbols.imports {
        let resolved_path = import_ctx.get_resolved(abs_str, &imp.source);
        for name in &imp.names {
            let clean_name = name.strip_prefix("* as ").unwrap_or(name).to_string();
            let mut target_file = resolved_path.clone();
            if import_ctx.is_barrel_file(&resolved_path) {
                let mut visited = HashSet::new();
                if let Some(actual) =
                    import_ctx.resolve_barrel_export(&resolved_path, &clean_name, &mut visited)
                {
                    target_file = actual;
                }
            }
            imported_names.push(ImportedName {
                name: clean_name,
                file: target_file,
            });
        }
    }
    imported_names
}

/// Insert the edges produced by the native edge builder into the edges table.
fn insert_call_edge_rows(conn: &Connection, edges: &[crate::edge_builder::ComputedEdge]) {
    if edges.is_empty() {
        return;
    }
    let edge_rows: Vec<crate::edges_db::EdgeRow> = edges
        .iter()
        .map(|e| crate::edges_db::EdgeRow {
            source_id: e.source_id,
            target_id: e.target_id,
            kind: e.kind.clone(),
            confidence: e.confidence,
            dynamic: e.dynamic,
        })
        .collect();
    let _ = crate::edges_db::do_insert_edges(conn, &edge_rows);
}

/// Full builds always load every node — there is no smaller set anyway.
fn build_and_insert_call_edges(
    conn: &Connection,
    file_symbols: &HashMap<String, FileSymbols>,
    import_ctx: &ImportEdgeContext,
    is_incremental: bool,
) {
    use crate::edge_builder::*;

    let all_nodes = load_edge_node_set(conn, file_symbols, import_ctx, is_incremental);
    if all_nodes.is_empty() {
        return;
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
            fn_ref_bindings: if symbols.fn_ref_bindings.is_empty() {
                None
            } else {
                Some(symbols.fn_ref_bindings.clone())
            },
        });
    }

    let computed_edges = build_call_edges(file_entries, all_nodes, builtin_receivers);
    insert_call_edge_rows(conn, &computed_edges);
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
    let _ = conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS _analysis_files (file TEXT NOT NULL)",
    );
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

/// Convert FileSymbols AST nodes to FileAstBatch format for `ast_db::do_insert_ast_nodes`.
fn build_ast_batches(
    file_symbols: &HashMap<String, FileSymbols>,
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
    file_symbols: &HashMap<String, FileSymbols>,
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
    file_symbols: &HashMap<String, FileSymbols>,
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
            write_def_cfg(
                &tx, &mut block_stmt, &mut edge_stmt,
                file, def, node_id_map,
            );
            if let Some(ref children) = def.children {
                for child in children {
                    write_def_cfg(
                        &tx, &mut block_stmt, &mut edge_stmt,
                        file, child, node_id_map,
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
    file_symbols: &HashMap<String, FileSymbols>,
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

        // argFlows → flows_to edges
        for flow in &data.arg_flows {
            let caller = match &flow.caller_func {
                Some(name) => name.as_str(),
                None => continue,
            };
            let src = resolve_dataflow_node(&mut local_stmt, &mut global_stmt, caller, file);
            let tgt = resolve_dataflow_node(&mut local_stmt, &mut global_stmt, &flow.callee_name, file);
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

        // assignments → returns edges
        for assignment in &data.assignments {
            let consumer = match &assignment.caller_func {
                Some(name) => name.as_str(),
                None => continue,
            };
            let producer = resolve_dataflow_node(&mut local_stmt, &mut global_stmt, &assignment.source_call_name, file);
            let consumer_id = resolve_dataflow_node(&mut local_stmt, &mut global_stmt, consumer, file);
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

        // mutations → mutates edges (only for param bindings)
        for mutation in &data.mutations {
            if mutation.binding_type.as_deref() != Some("param") {
                continue;
            }
            let func = match &mutation.func_name {
                Some(name) => name.as_str(),
                None => continue,
            };
            if let Some(node_id) = resolve_dataflow_node(&mut local_stmt, &mut global_stmt, func, file) {
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

    drop(insert_stmt);
    drop(local_stmt);
    drop(global_stmt);
    tx.commit().is_ok()
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
