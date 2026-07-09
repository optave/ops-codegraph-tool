//! Structure metrics for the build pipeline.
//!
//! Computes per-file metrics (line count, symbol count, import count,
//! export count, fan-in, fan-out) and upserts them to `node_metrics`.
//!
//! For small incremental builds (≤5 files), uses targeted per-file queries.
//! For full/larger builds, computes full structure: directory nodes,
//! contains edges, file metrics, and directory metrics with cohesion.

use crate::types::FileSymbols;
use rusqlite::Connection;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Per-file metrics to upsert into node_metrics.
#[derive(Debug, Clone)]
pub struct FileMetrics {
    pub node_id: i64,
    pub line_count: i64,
    pub symbol_count: i64,
    pub import_count: i64,
    pub export_count: i64,
    pub fan_in: i64,
    pub fan_out: i64,
}

/// Build line count map from parsed file symbols.
pub fn build_line_count_map(
    file_symbols: &BTreeMap<String, FileSymbols>,
    root_dir: &str,
) -> HashMap<String, i64> {
    let mut map = HashMap::new();
    for (rel_path, symbols) in file_symbols {
        // Try to get line count from parser-cached value
        let line_count = symbols.line_count.unwrap_or_else(|| {
            let abs_path = std::path::Path::new(root_dir).join(rel_path);
            match std::fs::read_to_string(abs_path) {
                Ok(content) => content.lines().count() as u32,
                Err(_) => 0,
            }
        });
        map.insert(rel_path.clone(), line_count as i64);
    }
    map
}

/// Fast path: update only changed files' metrics via targeted SQL queries.
///
/// Skips full structure rebuild for small incremental builds (≤5 files).
pub fn update_changed_file_metrics(
    conn: &Connection,
    changed_files: &[String],
    line_count_map: &HashMap<String, i64>,
    file_symbols: &BTreeMap<String, FileSymbols>,
) {
    if changed_files.is_empty() {
        return;
    }

    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };

    for rel_path in changed_files {
        // Get file node ID
        let file_node_id: i64 = match tx.query_row(
            "SELECT id FROM nodes WHERE name = ? AND kind = 'file' AND file = ? AND line = 0",
            [rel_path, rel_path],
            |row| row.get(0),
        ) {
            Ok(id) => id,
            Err(_) => continue,
        };

        let line_count = line_count_map.get(rel_path).copied().unwrap_or(0);

        let symbol_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE file = ? AND kind != 'file' AND kind != 'directory'",
                [rel_path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let import_count: i64 = tx
            .query_row(
                "SELECT COUNT(DISTINCT n2.file) FROM edges e \
                 JOIN nodes n1 ON e.source_id = n1.id \
                 JOIN nodes n2 ON e.target_id = n2.id \
                 WHERE e.kind = 'imports' AND n1.file = ?",
                [rel_path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let export_count = file_symbols
            .get(rel_path)
            .map(|s| s.exports.len() as i64)
            .unwrap_or(0);

        let fan_in: i64 = tx
            .query_row(
                "SELECT COUNT(DISTINCT n_src.file) FROM edges e \
                 JOIN nodes n_src ON e.source_id = n_src.id \
                 JOIN nodes n_tgt ON e.target_id = n_tgt.id \
                 WHERE e.kind = 'imports' AND n_tgt.file = ? AND n_src.file != n_tgt.file",
                [rel_path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let fan_out: i64 = tx
            .query_row(
                "SELECT COUNT(DISTINCT n_tgt.file) FROM edges e \
                 JOIN nodes n_src ON e.source_id = n_src.id \
                 JOIN nodes n_tgt ON e.target_id = n_tgt.id \
                 WHERE e.kind = 'imports' AND n_src.file = ? AND n_src.file != n_tgt.file",
                [rel_path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let _ = tx.execute(
            "INSERT OR REPLACE INTO node_metrics \
             (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out, cohesion, file_count) \
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
            rusqlite::params![file_node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out],
        );
    }

    let _ = tx.commit();
}

/// Get the count of existing file nodes in the database.
pub fn get_existing_file_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM nodes WHERE kind = 'file'",
        [],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// Files connected to `file` via a live import/imports-type edge in either
/// direction — the cross-directory neighbours whose own fan-in/out may have
/// shifted even though `file` is the only one that actually changed. Used by
/// `refresh_affected_directory_metrics` to expand its affected-directory set
/// by exactly one hop, for both changed files and (via `removed_file_neighbors`,
/// #1839) removed ones.
///
/// Scoped to the exact touched `file`, not its containing directory. An
/// earlier version scoped this to the whole leaf directory (`dir >= x/ AND
/// dir < x0`), which also pulled in edges belonging to unrelated sibling
/// files that happen to live alongside `file` — harmless when the directory
/// is small, but when the touched file sits in a widely-imported "hub"
/// directory (e.g. `src/domain`, imported from dozens of unrelated
/// directories via sibling files), that range scan discovers hundreds of
/// neighbour files that have nothing to do with `file`'s own edges, which
/// then balloon the affected-directory set to include broad, expensive-to-
/// recompute ancestors like the repo-root `src` (measured: 251 neighbour
/// files / 29 affected dirs for a single-file change to this repo's own
/// `src/domain/queries.ts`, a ~55ms hit on the "1-file rebuild" benchmark —
/// #1855). Scoping to the exact file preserves the cross-directory
/// detection this function exists for (#1738) while only considering edges
/// that could plausibly have changed as a result of editing `file` itself
/// (251 -> 46 neighbour files / 29 -> 13 affected dirs for the same probe).
fn find_neighbor_files(conn: &Connection, file: &str) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT n2.file AS other FROM edges e \
           JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id \
           WHERE e.kind IN ('imports', 'imports-type') AND n1.file = ?1 AND n2.file != ?1 \
         UNION \
         SELECT n1.file AS other FROM edges e \
           JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id \
           WHERE e.kind IN ('imports', 'imports-type') AND n2.file = ?1 AND n1.file != ?1",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let result = match stmt.query_map(rusqlite::params![file], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    };
    result
}

/// Targeted directory-metrics refresh for the small-incremental fast path.
///
/// `update_changed_file_metrics` only ever touches per-file `node_metrics`
/// rows — it never looks at directories. Any file added to, removed from, or
/// edited within a directory left that directory's
/// fileCount/symbolCount/fanIn/fanOut/cohesion stale until the next full
/// rebuild (#1738), and a file added under a brand-new directory never even
/// got a directory node or a `contains` edge from its parent.
///
/// This recomputes metrics for the ancestor directories of the files that
/// changed in this build (added, removed, or modified), PLUS any directory
/// reachable from the touched files' *immediate* (most specific) directory
/// via a live cross-directory import edge — a changed file that gains (or
/// loses) an import into a sibling package shifts that package's
/// fan-in/fan-out/cohesion even though none of its own files were touched.
///
/// The neighbor-discovery step is seeded from each touched file itself, not
/// from every ancestor up to root, and not from the touched file's whole
/// containing directory either — `find_neighbor_files` is now bounded by the
/// import edges attached to that ONE file. Seeding from every ancestor
/// turned a single touched file into 50+ affected directories on this
/// repo's own `src/` tree — a measured 70-90ms hit on the "1-file rebuild"
/// benchmark (#1738 follow-up). Seeding from the touched file's *directory*
/// (an intermediate fix) was still broad enough to pull in unrelated
/// sibling files' edges whenever that directory was itself a widely-
/// imported hub (e.g. `src/domain`) — measured 251 neighbour files / 29
/// affected dirs (~55ms) for a single-file change there, cut to 46 / 13 by
/// scoping to the exact file (#1855). Ancestor rollup (ancestors' own
/// aggregates still get recomputed) is unaffected; only the expensive
/// cross-directory neighbor lookup is scoped down.
///
/// Removed files need no edge/node cleanup of their own — the purge step
/// already deleted their nodes and every edge referencing them (including
/// their old `contains` edge) earlier in the pipeline; only their ancestor
/// directories' aggregates need recomputing here. A removed file's own
/// cross-directory neighbors (files it imported, or that imported it) can no
/// longer be discovered from LIVE edges by the time this runs — those edges
/// are already purged — so the pipeline captures them up front, before the
/// purge, via `detect_changes::capture_removed_file_neighbors` and passes
/// them in as `removed_file_neighbors` (#1839).
pub fn refresh_affected_directory_metrics(
    conn: &Connection,
    changed_files: &[String],
    removed_files: &[String],
    removed_file_neighbors: &[String],
) {
    let mut touched: Vec<String> = Vec::with_capacity(
        changed_files.len() + removed_files.len() + removed_file_neighbors.len(),
    );
    touched.extend_from_slice(changed_files);
    touched.extend_from_slice(removed_files);
    touched.extend_from_slice(removed_file_neighbors);
    let mut affected_dirs = get_ancestor_dirs(&touched);
    if affected_dirs.is_empty() {
        return;
    }

    // Seed neighbor-discovery from each touched file individually — NOT its
    // containing directory, and NOT every entry in `affected_dirs` (which
    // includes the full ancestor chain up to root). See the function doc
    // comment: expanding from a broad ancestor like `src`, or from every
    // sibling in the touched file's own directory, is effectively repo-wide
    // whenever that directory is a widely-imported hub.
    for file in &touched {
        let neighbor_files = find_neighbor_files(conn, file);
        for ancestor in get_ancestor_dirs(&neighbor_files) {
            affected_dirs.insert(ancestor);
        }
    }

    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };

    // 1. Ensure directory nodes exist for the whole affected ancestor chain —
    //    handles a file added under a brand-new (possibly multi-level) directory.
    {
        let mut insert_dir = match tx.prepare(
            "INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, 'directory', ?, 0, NULL)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        for dir in &affected_dirs {
            let _ = insert_dir.execute(rusqlite::params![dir, dir]);
        }
    }

    {
        let mut insert_edge = match tx.prepare(
            "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) \
             SELECT ?, ?, 'contains', 1.0, 0 \
             WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'contains')",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        // 2. Wire dir -> parent-dir contains edges for the chain.
        for dir in &affected_dirs {
            if let Some(parent) = parent_dir(dir) {
                if let (Some(parent_id), Some(dir_id)) = (
                    get_node_id(&tx, &parent, "directory", &parent, 0),
                    get_node_id(&tx, dir, "directory", dir, 0),
                ) {
                    let _ =
                        insert_edge.execute(rusqlite::params![parent_id, dir_id, parent_id, dir_id]);
                }
            }
        }

        // 3. Wire dir -> file contains edges for changed (added/modified) files.
        //    Removed files' nodes and edges are already purged upstream.
        for rel_path in changed_files {
            if let Some(dir) = parent_dir(rel_path) {
                if let (Some(dir_id), Some(file_id)) = (
                    get_node_id(&tx, &dir, "directory", &dir, 0),
                    get_node_id(&tx, rel_path, "file", rel_path, 0),
                ) {
                    let _ =
                        insert_edge.execute(rusqlite::params![dir_id, file_id, dir_id, file_id]);
                }
            }
        }
    }

    // 4. Recompute each affected directory's metrics from the live DB state.
    {
        // fileCount/symbolCount: transitive counts under `dir`, matching
        // compute_directory_metrics below. `file >= dir/ AND file < dir0` is
        // an index-friendly prefix-range scan equivalent to `file LIKE
        // 'dir/%'` — '0' (0x30) is the character immediately after '/'
        // (0x2F), so this bound matches exactly the paths nested under `dir`.
        let mut count_files = match tx.prepare(
            "SELECT COUNT(*) FROM nodes WHERE kind = 'file' AND file >= ?1 AND file < ?2",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut count_symbols = match tx.prepare(
            "SELECT COUNT(*) FROM nodes WHERE kind != 'file' AND kind != 'directory' AND file >= ?1 AND file < ?2",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        // Edges sourced from a file inside dir: intra (target also inside dir) vs fan-out.
        let mut outbound = match tx.prepare(
            "SELECT \
               COALESCE(SUM(CASE WHEN n2.file >= ?1 AND n2.file < ?2 THEN 1 ELSE 0 END), 0), \
               COUNT(*) \
             FROM edges e \
             JOIN nodes n1 ON e.source_id = n1.id \
             JOIN nodes n2 ON e.target_id = n2.id \
             WHERE e.kind IN ('imports', 'imports-type') \
               AND n1.file != n2.file \
               AND n2.kind = 'file' \
               AND n1.file >= ?1 AND n1.file < ?2",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        // Edges targeting a file inside dir, sourced from a file outside dir (fan-in only).
        let mut inbound = match tx.prepare(
            "SELECT COUNT(*) \
             FROM edges e \
             JOIN nodes n1 ON e.source_id = n1.id \
             JOIN nodes n2 ON e.target_id = n2.id \
             WHERE e.kind IN ('imports', 'imports-type') \
               AND n1.file != n2.file \
               AND n2.kind = 'file' \
               AND n2.file >= ?1 AND n2.file < ?2 \
               AND NOT (n1.file >= ?1 AND n1.file < ?2)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut upsert = match tx.prepare(
            "INSERT OR REPLACE INTO node_metrics \
             (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out, cohesion, file_count) \
             VALUES (?, NULL, ?, NULL, NULL, ?, ?, ?, ?)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        for dir in &affected_dirs {
            let dir_id = match get_node_id(&tx, dir, "directory", dir, 0) {
                Some(id) => id,
                None => continue,
            };
            let lo = format!("{dir}/");
            let hi = format!("{dir}0");

            let file_count: i64 = count_files
                .query_row(rusqlite::params![lo, hi], |r| r.get(0))
                .unwrap_or(0);
            let symbol_count: i64 = count_symbols
                .query_row(rusqlite::params![lo, hi], |r| r.get(0))
                .unwrap_or(0);
            let (intra, total): (i64, i64) = outbound
                .query_row(rusqlite::params![lo, hi], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap_or((0, 0));
            let fan_out = total - intra;
            let fan_in: i64 = inbound
                .query_row(rusqlite::params![lo, hi], |r| r.get(0))
                .unwrap_or(0);
            let total_edges = intra + fan_in + fan_out;
            let cohesion: Option<f64> = if total_edges > 0 {
                Some(intra as f64 / total_edges as f64)
            } else {
                None
            };

            let _ = upsert.execute(rusqlite::params![
                dir_id,
                symbol_count,
                fan_in,
                fan_out,
                cohesion,
                file_count
            ]);
        }
    }

    let _ = tx.commit();
}

// ── Full structure computation ──────────────────────────────────────────

/// Normalize a path to use forward slashes only.
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// Get the parent directory of a path (forward-slash normalized).
/// Returns None for root-level files (dirname is "." or empty).
fn parent_dir(path: &str) -> Option<String> {
    let normalized = normalize_path(path);
    if let Some(pos) = normalized.rfind('/') {
        let parent = &normalized[..pos];
        if parent.is_empty() || parent == "." {
            None
        } else {
            Some(parent.to_string())
        }
    } else {
        None
    }
}

/// Collect all ancestor directories for a set of file paths.
fn collect_all_directories(
    discovered_dirs: &HashSet<String>,
    file_paths: &[String],
) -> HashSet<String> {
    let mut all_dirs = HashSet::new();

    // Add discovered directories and their ancestors
    for dir in discovered_dirs {
        let mut d = normalize_path(dir);
        while !d.is_empty() && d != "." {
            if !all_dirs.insert(d.clone()) {
                break; // already seen this ancestor chain
            }
            d = match parent_dir(&d) {
                Some(p) => p,
                None => break,
            };
        }
    }

    // Add directories from file paths and their ancestors
    for path in file_paths {
        let mut d = match parent_dir(path) {
            Some(p) => p,
            None => continue,
        };
        while !d.is_empty() && d != "." {
            if !all_dirs.insert(d.clone()) {
                break;
            }
            d = match parent_dir(&d) {
                Some(p) => p,
                None => break,
            };
        }
    }

    all_dirs
}

/// Get ancestor directories for a specific set of files (for incremental cleanup).
fn get_ancestor_dirs(files: &[String]) -> HashSet<String> {
    let mut dirs = HashSet::new();
    for f in files {
        let mut d = match parent_dir(f) {
            Some(p) => p,
            None => continue,
        };
        while !d.is_empty() && d != "." {
            if !dirs.insert(d.clone()) {
                break;
            }
            d = match parent_dir(&d) {
                Some(p) => p,
                None => break,
            };
        }
    }
    dirs
}

/// Helper to look up a node ID by (name, kind, file, line).
fn get_node_id(conn: &Connection, name: &str, kind: &str, file: &str, line: i64) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?",
        rusqlite::params![name, kind, file, line],
        |row| row.get(0),
    )
    .ok()
}

/// Import edge between two files (source imports target).
struct ImportEdge {
    source_file: String,
    target_file: String,
}

/// Full structure computation: directory nodes, contains edges, file and
/// directory metrics. Replaces the JS `buildStructure` in `features/structure.ts`.
///
/// For full builds, `changed_files` should be `None` (rebuild everything).
/// For incremental builds, pass the list of changed files to scope cleanup
/// and contains-edge insertion to affected directories only.
pub fn build_full_structure(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    discovered_dirs: &HashSet<String>,
    root_dir: &str,
    line_count_map: &HashMap<String, i64>,
    changed_files: Option<&[String]>,
) {
    let is_incremental = changed_files.is_some();
    let file_paths: Vec<String> = file_symbols.keys().cloned().collect();

    // Relativize discovered_dirs (they come as absolute paths from file_collector)
    let rel_dirs: HashSet<String> = discovered_dirs
        .iter()
        .filter_map(|abs_dir| {
            let root = std::path::Path::new(root_dir);
            let abs = std::path::Path::new(abs_dir);
            abs.strip_prefix(root)
                .ok()
                .and_then(|p| p.to_str())
                .map(|s| normalize_path(s))
        })
        .filter(|d| !d.is_empty() && d != ".")
        .collect();

    let all_dirs = collect_all_directories(&rel_dirs, &file_paths);

    // Step 1: Cleanup previous data
    cleanup_previous_data(conn, is_incremental, changed_files, &all_dirs);

    // Step 2: Insert directory nodes
    insert_directory_nodes(conn, &all_dirs);

    // Step 3: Insert contains edges
    insert_contains_edges(conn, file_symbols, &all_dirs, changed_files);

    // Step 4: Compute import edge maps (fan-in/fan-out)
    let (fan_in_map, fan_out_map, import_edges) = compute_import_edge_maps(conn);

    // Step 5: Compute file metrics
    compute_file_metrics(conn, file_symbols, line_count_map, &fan_in_map, &fan_out_map);

    // Step 6: Compute directory metrics
    compute_directory_metrics(conn, file_symbols, &all_dirs, &import_edges);
}

fn cleanup_previous_data(
    conn: &Connection,
    is_incremental: bool,
    changed_files: Option<&[String]>,
    _all_dirs: &HashSet<String>,
) {
    if is_incremental {
        let affected_dirs = get_ancestor_dirs(changed_files.unwrap_or(&[]));
        let tx = match conn.unchecked_transaction() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        // Delete contains edges from affected directories
        for dir in &affected_dirs {
            let _ = tx.execute(
                "DELETE FROM edges WHERE kind = 'contains' AND source_id IN \
                 (SELECT id FROM nodes WHERE name = ? AND kind = 'directory')",
                [dir],
            );
        }
        // Delete metrics for changed files
        for f in changed_files.unwrap_or(&[]) {
            if let Some(file_id) = get_node_id(&tx, f, "file", f, 0) {
                let _ = tx.execute("DELETE FROM node_metrics WHERE node_id = ?", [file_id]);
            }
        }
        // Delete metrics for affected directories
        for dir in &affected_dirs {
            if let Some(dir_id) = get_node_id(&tx, dir, "directory", dir, 0) {
                let _ = tx.execute("DELETE FROM node_metrics WHERE node_id = ?", [dir_id]);
            }
        }
        let _ = tx.commit();
    } else {
        // Full build: clear all structure data
        let _ = conn.execute_batch(
            "DELETE FROM edges WHERE kind = 'contains' \
               AND source_id IN (SELECT id FROM nodes WHERE kind = 'directory'); \
             DELETE FROM node_metrics; \
             DELETE FROM nodes WHERE kind = 'directory';",
        );
    }
}

fn insert_directory_nodes(conn: &Connection, all_dirs: &HashSet<String>) {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };
    {
        let mut stmt = match tx.prepare(
            "INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        for dir in all_dirs {
            let _ = stmt.execute(rusqlite::params![dir, "directory", dir, 0, rusqlite::types::Null]);
        }
    }
    let _ = tx.commit();
}

/// Load all child directory paths from the DB whose parent is in the given set.
/// Used during incremental builds to ensure unchanged sibling subdirectories
/// retain their parent→child containment edges after cleanup.
fn load_child_dirs_in_affected(conn: &Connection, affected_dirs: &HashSet<String>) -> Vec<String> {
    let mut result = Vec::new();
    let mut stmt = match conn.prepare("SELECT name FROM nodes WHERE kind = 'directory'") {
        Ok(s) => s,
        Err(_) => return result,
    };
    if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
        for row in rows.flatten() {
            if let Some(parent) = parent_dir(&row) {
                if affected_dirs.contains(&parent) {
                    result.push(row);
                }
            }
        }
    }
    result
}

/// Load all file paths from the DB that reside in the given directories.
/// Used during incremental builds to ensure unchanged files in affected
/// directories retain their dir→file containment edges after cleanup.
fn load_file_paths_in_dirs(conn: &Connection, dirs: &HashSet<String>) -> Vec<String> {
    let mut result = Vec::new();
    let mut stmt = match conn.prepare(
        "SELECT name FROM nodes WHERE kind = 'file'",
    ) {
        Ok(s) => s,
        Err(_) => return result,
    };
    if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
        for row in rows.flatten() {
            if let Some(dir) = parent_dir(&row) {
                if dirs.contains(&dir) {
                    result.push(row);
                }
            }
        }
    }
    result
}

/// Emit `directory → file` contains edges for every (deduplicated) file in
/// the union of `file_symbols` and any DB-loaded paths under affected
/// directories. The transaction-scoped `stmt` must INSERT into edges with
/// kind='contains'.
fn insert_dir_to_file_contains_edges(
    tx: &rusqlite::Transaction,
    stmt: &mut rusqlite::Statement,
    file_symbols: &BTreeMap<String, FileSymbols>,
    all_file_paths: &[String],
    affected_dirs: Option<&HashSet<String>>,
) {
    let mut seen_files: HashSet<String> = HashSet::new();
    let file_paths_iter = file_symbols
        .keys()
        .map(|s| s.as_str())
        .chain(all_file_paths.iter().map(|s| s.as_str()));

    for rel_path in file_paths_iter {
        if !seen_files.insert(rel_path.to_string()) {
            continue;
        }
        let dir = match parent_dir(rel_path) {
            Some(d) => d,
            None => continue,
        };
        if let Some(ad) = affected_dirs {
            if !ad.contains(&dir) {
                continue;
            }
        }
        let dir_id = match get_node_id(tx, &dir, "directory", &dir, 0) {
            Some(id) => id,
            None => continue,
        };
        let file_id = match get_node_id(tx, rel_path, "file", rel_path, 0) {
            Some(id) => id,
            None => continue,
        };
        let _ = stmt.execute(rusqlite::params![dir_id, file_id]);
    }
}

/// Emit `parent_dir → child_dir` contains edges for every entry in
/// `all_dirs` whose parent is in scope.
fn insert_dir_to_dir_contains_edges(
    tx: &rusqlite::Transaction,
    stmt: &mut rusqlite::Statement,
    all_dirs: &HashSet<String>,
    affected_dirs: Option<&HashSet<String>>,
) {
    for dir in all_dirs {
        let parent = match parent_dir(dir) {
            Some(p) => p,
            None => continue,
        };
        if parent == *dir {
            continue;
        }
        if let Some(ad) = affected_dirs {
            if !ad.contains(&parent) {
                continue;
            }
        }
        let parent_id = match get_node_id(tx, &parent, "directory", &parent, 0) {
            Some(id) => id,
            None => continue,
        };
        let child_id = match get_node_id(tx, dir, "directory", dir, 0) {
            Some(id) => id,
            None => continue,
        };
        let _ = stmt.execute(rusqlite::params![parent_id, child_id]);
    }
}

/// Restore `parent → child` directory contains edges that were dropped by
/// cleanup for sibling subdirectories that aren't in `all_dirs` (no changed
/// file under them) but still exist in the DB.
fn restore_unchanged_dir_edges(
    tx: &rusqlite::Transaction,
    stmt: &mut rusqlite::Statement,
    all_dirs: &HashSet<String>,
    affected_dirs: &HashSet<String>,
) {
    let db_child_dirs = load_child_dirs_in_affected(tx, affected_dirs);
    for child_dir in &db_child_dirs {
        if all_dirs.contains(child_dir.as_str()) {
            continue;
        }
        let parent = match parent_dir(child_dir) {
            Some(p) => p,
            None => continue,
        };
        if !affected_dirs.contains(&parent) {
            continue;
        }
        if let (Some(p_id), Some(c_id)) = (
            get_node_id(tx, &parent, "directory", &parent, 0),
            get_node_id(tx, child_dir, "directory", child_dir, 0),
        ) {
            let _ = stmt.execute(rusqlite::params![p_id, c_id]);
        }
    }
}

fn insert_contains_edges(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    all_dirs: &HashSet<String>,
    changed_files: Option<&[String]>,
) {
    let affected_dirs = changed_files.map(|cf| get_ancestor_dirs(cf));

    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };
    {
        let mut stmt = match tx.prepare(
            "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) \
             VALUES (?, ?, 'contains', 1.0, 0)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        let all_file_paths: Vec<String> = if let Some(ref ad) = affected_dirs {
            load_file_paths_in_dirs(&tx, ad)
        } else {
            Vec::new()
        };

        insert_dir_to_file_contains_edges(
            &tx,
            &mut stmt,
            file_symbols,
            &all_file_paths,
            affected_dirs.as_ref(),
        );
        insert_dir_to_dir_contains_edges(&tx, &mut stmt, all_dirs, affected_dirs.as_ref());

        if let Some(ref ad) = affected_dirs {
            restore_unchanged_dir_edges(&tx, &mut stmt, all_dirs, ad);
        }
    }
    let _ = tx.commit();
}

fn compute_import_edge_maps(
    conn: &Connection,
) -> (HashMap<String, i64>, HashMap<String, i64>, Vec<ImportEdge>) {
    let mut fan_in_map: HashMap<String, i64> = HashMap::new();
    let mut fan_out_map: HashMap<String, i64> = HashMap::new();
    let mut import_edges: Vec<ImportEdge> = Vec::new();

    let mut stmt = match conn.prepare(
        "SELECT n1.file AS source_file, n2.file AS target_file \
         FROM edges e \
         JOIN nodes n1 ON e.source_id = n1.id \
         JOIN nodes n2 ON e.target_id = n2.id \
         WHERE e.kind IN ('imports', 'imports-type') \
           AND n1.file != n2.file \
           AND n2.kind = 'file'",
    ) {
        Ok(s) => s,
        Err(_) => return (fan_in_map, fan_out_map, import_edges),
    };

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .ok();

    if let Some(rows) = rows {
        for row in rows.flatten() {
            let (source_file, target_file) = row;
            *fan_out_map.entry(source_file.clone()).or_insert(0) += 1;
            *fan_in_map.entry(target_file.clone()).or_insert(0) += 1;
            import_edges.push(ImportEdge {
                source_file,
                target_file,
            });
        }
    }

    (fan_in_map, fan_out_map, import_edges)
}

fn compute_file_metrics(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    line_count_map: &HashMap<String, i64>,
    fan_in_map: &HashMap<String, i64>,
    fan_out_map: &HashMap<String, i64>,
) {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };

    // Batch-load symbol counts per file from DB (avoids N queries)
    let mut symbol_counts: HashMap<String, i64> = HashMap::new();
    if let Ok(mut stmt) = tx.prepare(
        "SELECT file, COUNT(*) FROM nodes \
         WHERE kind != 'file' AND kind != 'directory' \
         GROUP BY file",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }) {
            for row in rows.flatten() {
                symbol_counts.insert(row.0, row.1);
            }
        }
    }

    // Batch-load import counts per file from DB (distinct imported files,
    // matching the fast-path semantics in update_changed_file_metrics)
    let mut import_counts: HashMap<String, i64> = HashMap::new();
    if let Ok(mut stmt) = tx.prepare(
        "SELECT n1.file, COUNT(DISTINCT n2.file) FROM edges e \
         JOIN nodes n1 ON e.source_id = n1.id \
         JOIN nodes n2 ON e.target_id = n2.id \
         WHERE e.kind = 'imports' \
         GROUP BY n1.file",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }) {
            for row in rows.flatten() {
                import_counts.insert(row.0, row.1);
            }
        }
    }

    {
        let mut upsert = match tx.prepare(
            "INSERT OR REPLACE INTO node_metrics \
             (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out, cohesion, file_count) \
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        for (rel_path, symbols) in file_symbols {
            let file_id = match get_node_id(&tx, rel_path, "file", rel_path, 0) {
                Some(id) => id,
                None => continue,
            };

            let line_count = line_count_map.get(rel_path).copied().unwrap_or(0);
            let symbol_count = symbol_counts.get(rel_path).copied().unwrap_or(0);
            let import_count = import_counts.get(rel_path).copied().unwrap_or(0);
            let export_count = symbols.exports.len() as i64;
            let fan_in = fan_in_map.get(rel_path).copied().unwrap_or(0);
            let fan_out = fan_out_map.get(rel_path).copied().unwrap_or(0);

            let _ = upsert.execute(rusqlite::params![
                file_id,
                line_count,
                symbol_count,
                import_count,
                export_count,
                fan_in,
                fan_out,
            ]);
        }
    }

    let _ = tx.commit();
}

/// Load every file path stored as a `kind='file'` node in the DB.
fn load_all_file_paths_from_db(conn: &Connection) -> Vec<String> {
    let mut v = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT name FROM nodes WHERE kind = 'file'") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                v.push(row);
            }
        }
    }
    v
}

/// Walk a relative file path up through its ancestor directories, pushing
/// the file's path slice into each ancestor's bucket in `dir_files`.
fn record_file_in_ancestor_dirs<'a>(
    rel_path: &'a str,
    dir_files: &mut HashMap<&'a str, Vec<&'a str>>,
) {
    let mut d = match parent_dir(rel_path) {
        Some(p) => p,
        None => return,
    };
    while !d.is_empty() && d != "." {
        if let Some(files) = dir_files.get_mut(d.as_str()) {
            files.push(rel_path);
        }
        d = match parent_dir(&d) {
            Some(p) => p,
            None => break,
        };
    }
}

/// Build the `dir → ancestor files` map. DB files are the authoritative set
/// for incremental builds; `file_symbols` adds anything newly-inserted that
/// hasn't yet shown up via the DB query (full-build first run).
fn build_dir_files_map<'a>(
    all_dirs: &'a HashSet<String>,
    all_db_files: &'a [String],
    file_symbols: &'a BTreeMap<String, FileSymbols>,
) -> HashMap<&'a str, Vec<&'a str>> {
    let mut dir_files: HashMap<&str, Vec<&str>> = HashMap::new();
    for dir in all_dirs {
        dir_files.insert(dir.as_str(), Vec::new());
    }
    let mut seen_files: HashSet<&str> = HashSet::new();
    for rel_path in all_db_files {
        if seen_files.insert(rel_path.as_str()) {
            record_file_in_ancestor_dirs(rel_path.as_str(), &mut dir_files);
        }
    }
    for rel_path in file_symbols.keys() {
        if seen_files.insert(rel_path.as_str()) {
            record_file_in_ancestor_dirs(rel_path.as_str(), &mut dir_files);
        }
    }
    dir_files
}

/// Invert `dir_files` to a `file → ancestor dirs` map.
fn build_file_to_ancestor_dirs<'a>(
    dir_files: &'a HashMap<&'a str, Vec<&'a str>>,
) -> HashMap<&'a str, HashSet<&'a str>> {
    let mut file_to_ancestor_dirs: HashMap<&str, HashSet<&str>> = HashMap::new();
    for (dir, files) in dir_files {
        for f in files {
            file_to_ancestor_dirs.entry(*f).or_default().insert(*dir);
        }
    }
    file_to_ancestor_dirs
}

/// Tally intra-directory, fan-in, and fan-out edge counts per directory by
/// classifying each import edge against the ancestor sets of its endpoints.
fn count_directory_edges<'a>(
    all_dirs: &'a HashSet<String>,
    file_to_ancestor_dirs: &HashMap<&'a str, HashSet<&'a str>>,
    import_edges: &[ImportEdge],
) -> HashMap<&'a str, (i64, i64, i64)> {
    let mut dir_edge_counts: HashMap<&str, (i64, i64, i64)> = HashMap::new();
    for dir in all_dirs {
        dir_edge_counts.insert(dir.as_str(), (0, 0, 0));
    }
    for edge in import_edges {
        let src_dirs = file_to_ancestor_dirs.get(edge.source_file.as_str());
        let tgt_dirs = file_to_ancestor_dirs.get(edge.target_file.as_str());
        if src_dirs.is_none() && tgt_dirs.is_none() {
            continue;
        }
        if let Some(src_dirs) = src_dirs {
            for dir in src_dirs {
                if let Some(counts) = dir_edge_counts.get_mut(dir) {
                    if tgt_dirs.map_or(false, |td| td.contains(dir)) {
                        counts.0 += 1; // intra
                    } else {
                        counts.2 += 1; // fan_out
                    }
                }
            }
        }
        if let Some(tgt_dirs) = tgt_dirs {
            for dir in tgt_dirs {
                if src_dirs.map_or(true, |sd| !sd.contains(dir)) {
                    if let Some(counts) = dir_edge_counts.get_mut(dir) {
                        counts.1 += 1; // fan_in
                    }
                }
            }
        }
    }
    dir_edge_counts
}

/// Load per-file symbol counts from the DB (one query per build).
fn load_db_symbol_counts(conn: &Connection) -> HashMap<String, i64> {
    let mut db_symbol_counts: HashMap<String, i64> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT file, COUNT(*) FROM nodes \
         WHERE kind != 'file' AND kind != 'directory' \
         GROUP BY file",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }) {
            for row in rows.flatten() {
                db_symbol_counts.insert(row.0, row.1);
            }
        }
    }
    db_symbol_counts
}

/// Count distinct definitions in `file_symbols` for a single newly-inserted
/// file (used as a fallback when DB counts haven't been written yet).
fn count_distinct_definitions(sym: &FileSymbols) -> i64 {
    let mut seen = HashSet::new();
    let mut count: i64 = 0;
    for d in &sym.definitions {
        let key = format!("{}|{}|{}", d.name, d.kind, d.line);
        if seen.insert(key) {
            count += 1;
        }
    }
    count
}

/// Compute per-directory symbol counts by summing DB counts for every file
/// under the directory, falling back to in-memory `file_symbols` for any
/// files not yet persisted.
fn compute_dir_symbol_counts<'a>(
    dir_files: &HashMap<&'a str, Vec<&'a str>>,
    db_symbol_counts: &HashMap<String, i64>,
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> HashMap<&'a str, i64> {
    let mut dir_symbol_counts: HashMap<&str, i64> = HashMap::new();
    for (dir, files) in dir_files {
        let mut count: i64 = 0;
        for f in files {
            if let Some(&c) = db_symbol_counts.get(*f) {
                count += c;
            } else if let Some(sym) = file_symbols.get(*f) {
                count += count_distinct_definitions(sym);
            }
        }
        dir_symbol_counts.insert(*dir, count);
    }
    dir_symbol_counts
}

/// Write the directory metrics rows produced by the previous helpers.
fn write_directory_metric_rows(
    conn: &Connection,
    dir_files: &HashMap<&str, Vec<&str>>,
    dir_symbol_counts: &HashMap<&str, i64>,
    dir_edge_counts: &HashMap<&str, (i64, i64, i64)>,
) {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };
    {
        let mut upsert = match tx.prepare(
            "INSERT OR REPLACE INTO node_metrics \
             (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out, cohesion, file_count) \
             VALUES (?, NULL, ?, NULL, NULL, ?, ?, ?, ?)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        for (dir, files) in dir_files {
            let dir_id = match get_node_id(&tx, dir, "directory", dir, 0) {
                Some(id) => id,
                None => continue,
            };
            let file_count = files.len() as i64;
            let symbol_count = dir_symbol_counts.get(dir).copied().unwrap_or(0);
            let (intra, fan_in, fan_out) = dir_edge_counts.get(dir).copied().unwrap_or((0, 0, 0));
            let total_edges = intra + fan_in + fan_out;
            let cohesion: Option<f64> = if total_edges > 0 {
                Some(intra as f64 / total_edges as f64)
            } else {
                None
            };
            let _ = upsert.execute(rusqlite::params![
                dir_id,
                symbol_count,
                fan_in,
                fan_out,
                cohesion,
                file_count,
            ]);
        }
    }
    let _ = tx.commit();
}

fn compute_directory_metrics(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
    all_dirs: &HashSet<String>,
    import_edges: &[ImportEdge],
) {
    // Load ALL file paths from DB so directory metrics account for unchanged
    // files during incremental builds (file_symbols only has changed files).
    let all_db_files = load_all_file_paths_from_db(conn);
    let dir_files = build_dir_files_map(all_dirs, &all_db_files, file_symbols);
    let file_to_ancestor_dirs = build_file_to_ancestor_dirs(&dir_files);
    let dir_edge_counts =
        count_directory_edges(all_dirs, &file_to_ancestor_dirs, import_edges);
    let db_symbol_counts = load_db_symbol_counts(conn);
    let dir_symbol_counts =
        compute_dir_symbol_counts(&dir_files, &db_symbol_counts, file_symbols);
    write_directory_metric_rows(conn, &dir_files, &dir_symbol_counts, &dir_edge_counts);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_count_map_from_symbols() {
        let mut file_symbols = BTreeMap::new();
        let mut sym = FileSymbols::new("src/a.ts".to_string());
        sym.line_count = Some(42);
        file_symbols.insert("src/a.ts".to_string(), sym.clone());

        sym.file = "src/b.ts".to_string();
        sym.line_count = None;
        file_symbols.insert("src/b.ts".to_string(), sym);

        let map = build_line_count_map(&file_symbols, "/nonexistent");
        assert_eq!(*map.get("src/a.ts").unwrap(), 42);
        // b.ts: file doesn't exist, falls back to 0
        assert_eq!(*map.get("src/b.ts").unwrap(), 0);
    }
}
