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
use std::collections::{HashMap, HashSet};

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
    file_symbols: &HashMap<String, FileSymbols>,
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
    file_symbols: &HashMap<String, FileSymbols>,
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
    file_symbols: &HashMap<String, FileSymbols>,
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

fn insert_contains_edges(
    conn: &Connection,
    file_symbols: &HashMap<String, FileSymbols>,
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

        // In incremental mode, we need ALL file paths in affected directories,
        // not just the changed files in file_symbols. Load existing file nodes
        // from the DB so unchanged files keep their dir→file containment edges.
        let all_file_paths: Vec<String> = if affected_dirs.is_some() {
            load_file_paths_in_dirs(&tx, affected_dirs.as_ref().unwrap())
        } else {
            Vec::new()
        };

        // Directory → file edges: iterate over file_symbols keys (covers
        // changed/parsed files) plus DB-loaded paths (covers unchanged files
        // in affected directories during incremental builds).
        let mut seen_files: HashSet<String> = HashSet::new();
        let file_paths_iter = file_symbols
            .keys()
            .map(|s| s.as_str())
            .chain(all_file_paths.iter().map(|s| s.as_str()));

        for rel_path in file_paths_iter {
            if !seen_files.insert(rel_path.to_string()) {
                continue; // deduplicate
            }
            let dir = match parent_dir(rel_path) {
                Some(d) => d,
                None => continue,
            };
            // Skip unaffected directories in incremental mode
            if let Some(ref ad) = affected_dirs {
                if !ad.contains(&dir) {
                    continue;
                }
            }
            let dir_id = match get_node_id(&tx, &dir, "directory", &dir, 0) {
                Some(id) => id,
                None => continue,
            };
            let file_id = match get_node_id(&tx, rel_path, "file", rel_path, 0) {
                Some(id) => id,
                None => continue,
            };
            let _ = stmt.execute(rusqlite::params![dir_id, file_id]);
        }

        // Parent directory → child directory edges
        for dir in all_dirs {
            let parent = match parent_dir(dir) {
                Some(p) => p,
                None => continue,
            };
            if parent == *dir {
                continue;
            }
            if let Some(ref ad) = affected_dirs {
                if !ad.contains(&parent) {
                    continue;
                }
            }
            let parent_id = match get_node_id(&tx, &parent, "directory", &parent, 0) {
                Some(id) => id,
                None => continue,
            };
            let child_id = match get_node_id(&tx, dir, "directory", dir, 0) {
                Some(id) => id,
                None => continue,
            };
            let _ = stmt.execute(rusqlite::params![parent_id, child_id]);
        }

        // Restore dir→dir edges for unchanged sibling subdirectories that
        // were cleaned up but aren't in all_dirs (no changed file under them).
        if let Some(ref ad) = affected_dirs {
            let db_child_dirs = load_child_dirs_in_affected(&tx, ad);
            for child_dir in &db_child_dirs {
                if all_dirs.contains(child_dir.as_str()) {
                    continue; // already handled above
                }
                let parent = match parent_dir(child_dir) {
                    Some(p) => p,
                    None => continue,
                };
                if !ad.contains(&parent) {
                    continue;
                }
                if let (Some(p_id), Some(c_id)) = (
                    get_node_id(&tx, &parent, "directory", &parent, 0),
                    get_node_id(&tx, child_dir, "directory", child_dir, 0),
                ) {
                    let _ = stmt.execute(rusqlite::params![p_id, c_id]);
                }
            }
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
    file_symbols: &HashMap<String, FileSymbols>,
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
            let import_count = symbols.imports.len() as i64;
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

fn compute_directory_metrics(
    conn: &Connection,
    file_symbols: &HashMap<String, FileSymbols>,
    all_dirs: &HashSet<String>,
    import_edges: &[ImportEdge],
) {
    // Load ALL file paths from DB so directory metrics account for unchanged
    // files during incremental builds (file_symbols only has changed files).
    let all_db_files: Vec<String> = {
        let mut v = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT name FROM nodes WHERE kind = 'file'") {
            if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                for row in rows.flatten() {
                    v.push(row);
                }
            }
        }
        v
    };

    // Build dir→files map (transitive: each dir contains all files in all subdirs).
    // Uses DB files as the complete set, supplemented by file_symbols for any
    // files not yet in the DB (full build where nodes were just inserted).
    let mut dir_files: HashMap<&str, Vec<&str>> = HashMap::new();
    for dir in all_dirs {
        dir_files.insert(dir.as_str(), Vec::new());
    }
    let mut seen_files: HashSet<&str> = HashSet::new();
    // First: DB files (complete set for incremental builds)
    for rel_path in &all_db_files {
        if !seen_files.insert(rel_path.as_str()) {
            continue;
        }
        let mut d = match parent_dir(rel_path) {
            Some(p) => p,
            None => continue,
        };
        while !d.is_empty() && d != "." {
            if let Some(files) = dir_files.get_mut(d.as_str()) {
                files.push(rel_path.as_str());
            }
            d = match parent_dir(&d) {
                Some(p) => p,
                None => break,
            };
        }
    }
    // Second: file_symbols keys (covers newly-inserted files in full builds)
    for rel_path in file_symbols.keys() {
        if !seen_files.insert(rel_path.as_str()) {
            continue;
        }
        let mut d = match parent_dir(rel_path) {
            Some(p) => p,
            None => continue,
        };
        while !d.is_empty() && d != "." {
            if let Some(files) = dir_files.get_mut(d.as_str()) {
                files.push(rel_path.as_str());
            }
            d = match parent_dir(&d) {
                Some(p) => p,
                None => break,
            };
        }
    }

    // Build reverse map: file → set of ancestor directories
    let mut file_to_ancestor_dirs: HashMap<&str, HashSet<&str>> = HashMap::new();
    for (dir, files) in &dir_files {
        for f in files {
            file_to_ancestor_dirs
                .entry(f)
                .or_default()
                .insert(dir);
        }
    }

    // Count intra-directory, fan-in, and fan-out edges per directory
    let mut dir_edge_counts: HashMap<&str, (i64, i64, i64)> = HashMap::new(); // (intra, fan_in, fan_out)
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

    // Count symbols per directory.
    // Use DB counts (covers all files including unchanged ones in incremental
    // builds) and fall back to file_symbols for newly-inserted files.
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
    let mut dir_symbol_counts: HashMap<&str, i64> = HashMap::new();
    for (dir, files) in &dir_files {
        let mut count: i64 = 0;
        for f in files {
            if let Some(&c) = db_symbol_counts.get(*f) {
                count += c;
            } else if let Some(sym) = file_symbols.get(*f) {
                let mut seen = HashSet::new();
                for d in &sym.definitions {
                    let key = format!("{}|{}|{}", d.name, d.kind, d.line);
                    if seen.insert(key) {
                        count += 1;
                    }
                }
            }
        }
        dir_symbol_counts.insert(dir, count);
    }

    // Write directory metrics
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

        for (dir, files) in &dir_files {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_count_map_from_symbols() {
        let mut file_symbols = HashMap::new();
        let mut sym = FileSymbols {
            file: "src/a.ts".to_string(),
            definitions: vec![],
            imports: vec![],
            calls: vec![],
            classes: vec![],
            exports: vec![],
            type_map: vec![],
            ast_nodes: vec![],
            dataflow: None,
            line_count: Some(42),
        };
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
