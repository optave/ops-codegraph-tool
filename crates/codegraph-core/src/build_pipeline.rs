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
//! 7. Build import edges + barrel resolution
//! 8. Build call edges (existing `edge_builder::build_call_edges`)
//! 9. Structure metrics + role classification
//! 10. Finalize (metadata, journal)

use crate::change_detection;
use crate::config::{BuildConfig, BuildOpts, BuildPathAliases};
use crate::constants::{FAST_PATH_MAX_CHANGED_FILES, FAST_PATH_MIN_EXISTING_FILES};
use crate::file_collector;
use crate::import_edges::{self, ImportEdgeContext};
use crate::import_resolution;
use crate::journal;
use crate::parallel;
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
    /// Full set of changed files including reverse-dep files. Used by the JS
    /// structure fallback path so it can update metrics for files whose edges
    /// changed even though their content didn't. `None` for full builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structure_scope: Option<Vec<String>>,
    /// Whether the Rust pipeline handled the structure phase (directory nodes,
    /// contains edges, file metrics). True when the small-incremental fast path
    /// ran (≤5 changed files, >20 existing files). When false, the JS caller
    /// must run its own structure phase as a post-processing step.
    pub structure_handled: bool,
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

    // Check engine/schema/version mismatch for forced full rebuild
    let force_full_rebuild = check_version_mismatch(conn);
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
    let collect_result = if let Some(ref scope) = opts.scope {
        // Scoped rebuild — only collect files that exist on disk
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
                )
            } else {
                file_collector::collect_files(root_dir, &config.ignore_dirs)
            }
        } else {
            file_collector::collect_files(root_dir, &config.ignore_dirs)
        }
    } else {
        file_collector::collect_files(root_dir, &config.ignore_dirs)
    };
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
        // Heal metadata if needed
        change_detection::heal_metadata(conn, &change_result.metadata_updates);
        journal::write_journal_header(root_dir, now_ms());
        return Ok(BuildPipelineResult {
            phases: timing,
            node_count: 0,
            edge_count: 0,
            file_count: collect_result.files.len(),
            early_exit: true,
            changed_files: Some(vec![]),
            changed_count: 0,
            removed_count: 0,
            is_full_build: false,
            structure_scope: Some(vec![]),
            structure_handled: true,
        });
    }

    // Track reverse-dep files that need re-parsing for edge reconstruction.
    // Also track their relative paths so we can exclude them from analysis_scope —
    // reverse-dep files are re-parsed for edge rebuilding but their content didn't
    // change, so running AST/complexity/CFG/dataflow on them is wasted work (#761).
    let mut reverse_dep_abs_paths: Vec<String> = Vec::new();
    let mut reverse_dep_rel_paths: HashSet<String> = HashSet::new();

    // Handle full build: clear all graph data
    if change_result.is_full_build {
        let has_embeddings = change_detection::has_embeddings(conn);
        change_detection::clear_all_graph_data(conn, has_embeddings);
    } else {
        // Incremental: find reverse deps and purge changed files
        let changed_rel_paths: HashSet<String> = parse_changes
            .iter()
            .map(|c| c.rel_path.clone())
            .chain(change_result.removed.iter().cloned())
            .collect();

        let reverse_deps = if opts.no_reverse_deps.unwrap_or(false) {
            HashSet::new()
        } else {
            change_detection::find_reverse_dependencies(conn, &changed_rel_paths, root_dir)
        };

        let files_to_purge: Vec<String> = change_result
            .removed
            .iter()
            .chain(parse_changes.iter().map(|c| &c.rel_path))
            .cloned()
            .collect();
        let reverse_dep_list: Vec<String> = reverse_deps.iter().cloned().collect();
        change_detection::purge_changed_files(conn, &files_to_purge, &reverse_dep_list);

        // Track reverse-dep absolute paths so we can re-parse them for edge
        // rebuilding. Their nodes are still in the DB (only edges were purged),
        // but we need fresh FileSymbols so Stage 7 can reconstruct their
        // import and call edges.
        for rdep in &reverse_dep_list {
            let abs = Path::new(root_dir).join(rdep);
            if abs.exists() {
                reverse_dep_abs_paths.push(abs.to_str().unwrap_or("").to_string());
                reverse_dep_rel_paths.insert(rdep.clone());
            }
        }
    }

    // ── Stage 4: Parse files ───────────────────────────────────────────
    let t0 = Instant::now();
    let mut files_to_parse: Vec<String> =
        parse_changes.iter().map(|c| c.abs_path.clone()).collect();
    // Include reverse-dep files so their edges are rebuilt after purging
    files_to_parse.extend(reverse_dep_abs_paths);
    let parsed =
        parallel::parse_files_parallel(&files_to_parse, root_dir, include_dataflow, include_ast);

    // Build file symbols map (relative path → FileSymbols)
    let mut file_symbols: HashMap<String, FileSymbols> = HashMap::new();
    for mut sym in parsed {
        let rel = relative_path(root_dir, &sym.file);
        sym.file = rel.clone();
        file_symbols.insert(rel, sym);
    }
    timing.parse_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 5: Insert nodes ──────────────────────────────────────────
    let t0 = Instant::now();
    let insert_batches = build_insert_batches(&file_symbols);
    let file_hashes = build_file_hash_entries(&parse_changes, root_dir);
    let _ = crate::insert_nodes::do_insert_nodes(
        conn,
        &insert_batches,
        &file_hashes,
        &change_result.removed,
    );
    // Also heal metadata-only updates
    change_detection::heal_metadata(conn, &change_result.metadata_updates);
    timing.insert_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 6: Resolve imports ───────────────────────────────────────
    let t0 = Instant::now();
    let mut batch_inputs: Vec<ImportResolutionInput> = Vec::new();
    for (rel_path, symbols) in &file_symbols {
        let abs_file = Path::new(root_dir).join(rel_path);
        // Normalize to forward slashes so batch_resolved keys match Stage 6b lookups on Windows.
        let abs_str = abs_file.to_str().unwrap_or("").replace('\\', "/");
        for imp in &symbols.imports {
            batch_inputs.push(ImportResolutionInput {
                from_file: abs_str.clone(),
                import_source: imp.source.clone(),
            });
        }
    }

    let known_files: HashSet<String> = collect_result
        .files
        .iter()
        .map(|f| relative_path(root_dir, f))
        .collect();

    let resolved = import_resolution::resolve_imports_batch(
        &batch_inputs,
        root_dir,
        &napi_aliases,
        Some(&known_files),
    );

    // Build batch_resolved map: "absFile|importSource" -> resolved path
    let mut batch_resolved: HashMap<String, String> = HashMap::new();
    for r in &resolved {
        let key = format!("{}|{}", r.from_file, r.import_source);
        batch_resolved.insert(key, r.resolved_path.clone());
    }
    timing.resolve_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 6b: Re-parse barrel candidates (incremental only) ─────────
    // Mirrors JS pipeline's findBarrelCandidates + reparseBarrelFiles.
    // For incremental builds, barrel files (re-export-only index files) may
    // not be in file_symbols because they weren't changed or reverse-deps.
    // Without their symbols, barrel resolution in Stage 7 can't create the
    // transitive import edges (e.g. app.js -> math.js through index.js).
    if !change_result.is_full_build {
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

        // Check which barrels are imported by parsed files but not in file_symbols
        let mut barrel_paths_to_parse: Vec<String> = Vec::new();
        for (_rel_path, symbols) in &file_symbols {
            for imp in &symbols.imports {
                // Look up resolved path from batch_resolved
                let abs_file = Path::new(root_dir).join(_rel_path);
                let fwd = abs_file.to_str().unwrap_or("").replace('\\', "/");
                let key = format!("{}|{}", fwd, imp.source);
                if let Some(resolved) = batch_resolved.get(&key) {
                    if barrel_files_in_db.contains(resolved) && !file_symbols.contains_key(resolved)
                    {
                        let abs = Path::new(root_dir).join(resolved);
                        if abs.exists() {
                            barrel_paths_to_parse
                                .push(abs.to_str().unwrap_or("").to_string());
                        }
                    }
                }
            }
        }

        // Also find barrels that re-export FROM changed files
        {
            let changed_rel: Vec<&str> = file_symbols.keys().map(|s| s.as_str()).collect();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT DISTINCT n1.file FROM edges e \
                 JOIN nodes n1 ON e.source_id = n1.id \
                 JOIN nodes n2 ON e.target_id = n2.id \
                 WHERE e.kind = 'reexports' AND n1.kind = 'file' AND n2.file = ?1",
            ) {
                for changed in &changed_rel {
                    if let Ok(rows) = stmt.query_map(rusqlite::params![changed], |row| {
                        row.get::<_, String>(0)
                    }) {
                        for row in rows.flatten() {
                            if !file_symbols.contains_key(&row) {
                                let abs = Path::new(root_dir).join(&row);
                                if abs.exists() {
                                    barrel_paths_to_parse
                                        .push(abs.to_str().unwrap_or("").to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Re-parse barrel files and merge into file_symbols
        if !barrel_paths_to_parse.is_empty() {
            barrel_paths_to_parse.sort();
            barrel_paths_to_parse.dedup();
            // Barrel files are re-export-only — no function bodies or dataflow,
            // so skip dataflow/AST analysis to avoid unnecessary overhead.
            let barrel_parsed = parallel::parse_files_parallel(
                &barrel_paths_to_parse,
                root_dir,
                false,
                false,
            );
            for mut sym in barrel_parsed {
                let rel = relative_path(root_dir, &sym.file);
                sym.file = rel.clone();
                // Delete outgoing import/reexport edges for barrel files being re-parsed
                // (scoped to import-related kinds to avoid dropping calls edges)
                let _ = conn.execute(
                    "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) \
                     AND kind IN ('imports', 'reexports')",
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
                        &napi_aliases,
                        Some(&known_files),
                    );
                    for r in &resolved_batch {
                        let key = format!("{}|{}", r.from_file, r.import_source);
                        batch_resolved.insert(key, r.resolved_path.clone());
                    }
                }
                file_symbols.insert(rel, sym);
            }
        }
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
    build_and_insert_call_edges(conn, &file_symbols, &import_ctx);

    timing.edges_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 8: Structure + roles ─────────────────────────────────────
    let t0 = Instant::now();
    let line_count_map = structure::build_line_count_map(&file_symbols, root_dir);
    let changed_files: Vec<String> = file_symbols.keys().cloned().collect();
    // Build analysis_scope excluding reverse-dep files — they were re-parsed for
    // edge reconstruction but their content didn't change, so AST/complexity/CFG/
    // dataflow analysis would be redundant (#761). This matches the JS pipeline's
    // _reverseDepOnly filtering in run-analyses.ts.
    let analysis_scope: Option<Vec<String>> = if change_result.is_full_build {
        None
    } else {
        Some(
            changed_files
                .iter()
                .filter(|f| !reverse_dep_rel_paths.contains(f.as_str()))
                .cloned()
                .collect(),
        )
    };

    let existing_file_count = structure::get_existing_file_count(conn);
    // Use parse_changes.len() for the threshold — changed_files includes
    // reverse-dep files added for edge rebuilding, which inflates the count
    // and would skip the fast path even for single-file incremental builds.
    let use_fast_path =
        !change_result.is_full_build && parse_changes.len() <= FAST_PATH_MAX_CHANGED_FILES && existing_file_count > FAST_PATH_MIN_EXISTING_FILES;

    if use_fast_path {
        structure::update_changed_file_metrics(
            conn,
            &changed_files,
            &line_count_map,
            &file_symbols,
        );
    }
    // For full/larger builds, the JS fallback handles full structure via
    // `features/structure.ts`. The Rust orchestrator handles the fast path
    // for small incremental builds. Full structure computation will be
    // ported in a follow-up.
    timing.structure_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t0 = Instant::now();
    // Role classification intentionally uses the full `changed_files` list
    // (including reverse-dep files), not `analysis_scope`. Reverse-dep files
    // had their edges rebuilt, which can change fan-in/fan-out and therefore
    // role assignments — so they must be re-classified even though their
    // content didn't change and they are excluded from AST analysis.
    let changed_file_list: Option<Vec<String>> = if change_result.is_full_build {
        None
    } else {
        Some(changed_files)
    };
    if let Some(ref files) = changed_file_list {
        if !files.is_empty() {
            let _ = roles_db::do_classify_incremental(conn, files);
        }
    } else {
        let _ = roles_db::do_classify_full(conn);
    }
    timing.roles_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // ── Stage 9: Finalize ──────────────────────────────────────────────
    let t0 = Instant::now();
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
    }

    // Write journal header
    journal::write_journal_header(root_dir, now_ms());
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
        structure_scope: changed_file_list.clone(),
        structure_handled: use_fast_path,
    })
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
    if let Some(prev_version) = get_meta("codegraph_version") {
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
    _root_dir: &str,
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
fn build_and_insert_call_edges(
    conn: &Connection,
    file_symbols: &HashMap<String, FileSymbols>,
    import_ctx: &ImportEdgeContext,
) {
    use crate::edge_builder::*;

    // Load all callable nodes from DB
    let node_kind_filter = "kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant')";
    let sql = format!("SELECT id, name, kind, file, line FROM nodes WHERE {node_kind_filter}");
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return,
    };
    let all_nodes: Vec<NodeInfo> = stmt
        .query_map([], |row| {
            Ok(NodeInfo {
                id: row.get::<_, i64>(0)? as u32,
                name: row.get(1)?,
                kind: row.get(2)?,
                file: row.get(3)?,
                line: row.get::<_, i64>(4)? as u32,
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    if all_nodes.is_empty() {
        return;
    }

    let builtin_receivers: Vec<String> = vec![
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
    .collect();

    // Build FileEdgeInput entries for the native edge builder
    let mut file_entries: Vec<FileEdgeInput> = Vec::new();
    for (rel_path, symbols) in file_symbols {
        if import_ctx.barrel_only_files.contains(rel_path) {
            continue;
        }

        // Look up file node ID
        let file_node_id: u32 = match conn.query_row(
            "SELECT id FROM nodes WHERE name = ? AND kind = 'file' AND file = ? AND line = 0",
            [rel_path, rel_path],
            |row| row.get::<_, i64>(0),
        ) {
            Ok(id) => id as u32,
            Err(_) => continue,
        };

        // Build imported names from resolved imports
        let mut imported_names: Vec<ImportedName> = Vec::new();
        let abs_file = Path::new(&import_ctx.root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("");
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

        let type_map: Vec<TypeMapInput> = symbols
            .type_map
            .iter()
            .map(|t| TypeMapInput {
                name: t.name.clone(),
                type_name: t.type_name.clone(),
            })
            .collect();

        file_entries.push(FileEdgeInput {
            file: rel_path.clone(),
            file_node_id: file_node_id,
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
        });
    }

    // Call the native edge builder
    let computed_edges = build_call_edges(file_entries, all_nodes, builtin_receivers);

    // Insert edges
    if !computed_edges.is_empty() {
        let edge_rows: Vec<crate::edges_db::EdgeRow> = computed_edges
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
}

/// Current time in milliseconds since epoch.
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
