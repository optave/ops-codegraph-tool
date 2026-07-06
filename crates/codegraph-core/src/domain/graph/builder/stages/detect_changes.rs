//! Tiered change detection for incremental builds.
//!
//! Strategy (mirrors `detect-changes.ts`):
//! - Tier 0 (Journal): read journal, hash-check entries against `file_hashes`
//! - Tier 1 (Mtime+Size): skip files where mtime+size match stored values
//! - Tier 2 (Content Hash): SHA-256 hash files that failed Tier 1, compare to DB
//!
//! Note: Uses SHA-256 (not MD5). The JS pipeline uses MD5 via `createHash('md5')`,
//! but engine-mismatch detection in the pipeline orchestrator forces a full rebuild
//! when switching between JS and native engines, so hash format compatibility is
//! not required.

use crate::domain::graph::builder::stages::collect_files::is_supported_extension;
use crate::domain::graph::journal;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

/// A file hash row from the `file_hashes` table.
#[derive(Debug, Clone)]
pub struct FileHashRow {
    pub file: String,
    pub hash: String,
    pub mtime: i64,
    pub size: i64,
}

/// A file that needs to be re-parsed.
#[derive(Debug, Clone)]
pub struct ChangedFile {
    pub abs_path: String,
    pub rel_path: String,
    pub content: Option<String>,
    pub hash: Option<String>,
    pub mtime: i64,
    pub size: i64,
    pub metadata_only: bool,
    pub reverse_dep_only: bool,
}

/// Result of the change detection stage.
#[derive(Debug, Default)]
pub struct ChangeResult {
    pub changed: Vec<ChangedFile>,
    pub removed: Vec<String>,
    pub is_full_build: bool,
    /// Files with only mtime/size changes (hash unchanged) — need metadata heal.
    pub metadata_updates: Vec<MetadataUpdate>,
}

#[derive(Debug, Clone)]
pub struct MetadataUpdate {
    pub rel_path: String,
    pub hash: String,
    pub mtime: i64,
    pub size: i64,
}

/// Compute SHA-256 hash of file content for change detection.
///
/// Uses SHA-256 rather than MD5 (which the JS pipeline uses). This is safe
/// because engine-mismatch detection forces a full rebuild when switching
/// between native and JS engines, so the hash formats never need to match.
fn file_hash_sha256(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Normalize path to forward slashes (cross-platform consistency).
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// Make a path relative to root_dir, normalized with forward slashes.
fn relative_path(root_dir: &str, abs_path: &str) -> String {
    let root = Path::new(root_dir);
    let abs = Path::new(abs_path);
    match abs.strip_prefix(root) {
        Ok(rel) => normalize_path(rel.to_str().unwrap_or("")),
        Err(_) => normalize_path(abs_path),
    }
}

/// Load all file_hashes rows from the database.
fn load_file_hashes(conn: &Connection) -> Option<HashMap<String, FileHashRow>> {
    // Check table exists
    let has_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='file_hashes'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !has_table {
        return None;
    }

    let mut stmt = match conn.prepare("SELECT file, hash, mtime, size FROM file_hashes") {
        Ok(s) => s,
        Err(_) => return None,
    };

    let rows: Vec<FileHashRow> = stmt
        .query_map([], |row| {
            Ok(FileHashRow {
                file: row.get(0)?,
                hash: row.get(1)?,
                mtime: row.get(2)?,
                size: row.get(3)?,
            })
        })
        .ok()?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return None;
    }

    Some(rows.into_iter().map(|r| (r.file.clone(), r)).collect())
}

/// Detect removed files: files in DB but not in current file list.
///
/// When `scoped_rel_paths` is provided (scoped rebuild), only files within that
/// scope are considered candidates for removal. Without it, all DB files not
/// found on disk are treated as removed.
///
/// Files whose extension is outside the Rust file_collector's supported set
/// (e.g. `.v` — WASM-only languages) are skipped:
/// the orchestrator's narrower collector never sees them, so absence from
/// `current` is a capability boundary, not a deletion. Their `nodes` and
/// `file_hashes` rows are owned by the JS-side WASM backfill (#967, #1068)
/// and must be left alone, otherwise every incremental rebuild purges and
/// re-creates them — the ~2s floor reported in #1066.
fn detect_removed_files(
    existing: &HashMap<String, FileHashRow>,
    all_files: &[String],
    root_dir: &str,
    scoped_rel_paths: Option<&HashSet<String>>,
) -> Vec<String> {
    let current: HashSet<String> = all_files
        .iter()
        .map(|f| relative_path(root_dir, f))
        .collect();

    existing
        .keys()
        .filter(|f| {
            if !is_supported_extension(f) {
                return false;
            }
            // When scope is set, only consider files within scope as candidates.
            if let Some(scope) = scoped_rel_paths {
                scope.contains(*f) && !current.contains(*f)
            } else {
                !current.contains(*f)
            }
        })
        .cloned()
        .collect()
}

/// Tier 0: Journal-based change detection.
fn try_journal_tier(
    conn: &Connection,
    existing: &HashMap<String, FileHashRow>,
    root_dir: &str,
    removed: &[String],
) -> Option<ChangeResult> {
    let journal = journal::read_journal(root_dir);
    if !journal.valid {
        return None;
    }

    // Check journal freshness against DB
    let latest_mtime: i64 = conn
        .query_row("SELECT MAX(mtime) FROM file_hashes", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .unwrap_or(Some(0))
        .unwrap_or(0);

    let has_entries = !journal.changed.is_empty() || !journal.removed.is_empty();
    if !has_entries || (journal.timestamp as i64) < latest_mtime {
        return None;
    }

    let mut changed = Vec::new();
    for rel_path in &journal.changed {
        let abs_path = Path::new(root_dir).join(rel_path);
        let abs_str = abs_path.to_str().unwrap_or("").to_string();

        let metadata = match fs::metadata(&abs_path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let content = match fs::read_to_string(&abs_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let hash = file_hash_sha256(&content);
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let size = metadata.len() as i64;

        let record = existing.get(rel_path);
        if record.is_none() || record.unwrap().hash != hash {
            changed.push(ChangedFile {
                abs_path: abs_str,
                rel_path: rel_path.clone(),
                content: Some(content),
                hash: Some(hash),
                mtime,
                size,
                metadata_only: false,
                reverse_dep_only: false,
            });
        }
    }

    let mut removed_set: HashSet<String> = removed.iter().cloned().collect();
    for rel_path in &journal.removed {
        if existing.contains_key(rel_path) {
            removed_set.insert(rel_path.clone());
        }
    }

    Some(ChangeResult {
        changed,
        removed: removed_set.into_iter().collect(),
        is_full_build: false,
        metadata_updates: Vec::new(),
    })
}

/// Tier 1+2: Mtime/size skip then content hash comparison.
fn mtime_and_hash_tiers(
    existing: &HashMap<String, FileHashRow>,
    all_files: &[String],
    root_dir: &str,
    removed: Vec<String>,
) -> ChangeResult {
    struct NeedsHash {
        file: String,
        rel_path: String,
        mtime: i64,
        size: i64,
    }

    let mut needs_hash = Vec::new();

    for file in all_files {
        let rel_path = relative_path(root_dir, file);
        let record = existing.get(&rel_path);

        if record.is_none() {
            // New file — needs hash
            let (mtime, size) = file_mtime_size(file);
            needs_hash.push(NeedsHash {
                file: file.clone(),
                rel_path,
                mtime,
                size,
            });
            continue;
        }

        let record = record.unwrap();
        let (mtime, size) = file_mtime_size(file);
        if mtime == 0 && size == 0 {
            continue; // stat failed
        }

        // Tier 1: mtime+size match → skip
        let stored_mtime = record.mtime;
        let stored_size = record.size;
        if stored_size > 0 && mtime == stored_mtime && size == stored_size {
            continue;
        }

        needs_hash.push(NeedsHash {
            file: file.clone(),
            rel_path,
            mtime,
            size,
        });
    }

    let mut changed = Vec::new();
    let mut metadata_updates = Vec::new();

    for item in &needs_hash {
        let content = match fs::read_to_string(&item.file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let hash = file_hash_sha256(&content);
        let record = existing.get(&item.rel_path);

        if record.is_none() || record.unwrap().hash != hash {
            // Actually changed
            changed.push(ChangedFile {
                abs_path: item.file.clone(),
                rel_path: item.rel_path.clone(),
                content: Some(content),
                hash: Some(hash),
                mtime: item.mtime,
                size: item.size,
                metadata_only: false,
                reverse_dep_only: false,
            });
        } else {
            // Hash matches but mtime/size differ — metadata-only update
            metadata_updates.push(MetadataUpdate {
                rel_path: item.rel_path.clone(),
                hash,
                mtime: item.mtime,
                size: item.size,
            });
        }
    }

    ChangeResult {
        changed,
        removed,
        is_full_build: false,
        metadata_updates,
    }
}

/// Get file mtime (ms since epoch, floored) and size.
fn file_mtime_size(path: &str) -> (i64, i64) {
    match fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let size = m.len() as i64;
            (mtime, size)
        }
        Err(_) => (0, 0),
    }
}

/// A reverse-dep edge captured before purge so it can be reconnected to the
/// new target node ID after the changed file's nodes are re-inserted.
#[derive(Debug, Clone)]
pub struct SavedReverseDepEdge {
    pub source_id: i64,
    pub tgt_name: String,
    pub tgt_kind: String,
    pub tgt_file: String,
    pub tgt_line: i64,
    pub edge_kind: String,
    pub confidence: f64,
    pub dynamic: i64,
    /// 1-based rank of the target (by ascending line) among nodes sharing its
    /// (name, kind) within `tgt_file`, computed at save time — see #1752.
    pub tgt_ordinal: i64,
    /// Size of that (name, kind) sibling group at save time.
    pub tgt_sibling_count: i64,
}

/// Computes each node's 1-based ordinal rank (by ascending line) among nodes
/// sharing its (name, kind) within `file`, plus the sibling-group size,
/// keyed by `(name, kind, line)`.
///
/// A file can contain multiple distinct symbols with the identical name and
/// kind — e.g. several object-literal `close() {}` methods returned from
/// different functions in the same file. `(name, kind, file)` alone is not a
/// unique identity for such symbols, so `reconnect_reverse_dep_edges` cannot
/// safely tell them apart by nearest-line matching once unrelated code
/// shifts the candidates unevenly (#1752). The ordinal recorded here — the
/// target's rank among same-named siblings at save time — lets reconnection
/// map an old target to its new node correctly as long as the sibling count
/// is unchanged, regardless of how far the whole group has shifted.
fn compute_ordinals(conn: &Connection, file: &str) -> HashMap<(String, String, i64), (i64, i64)> {
    let mut by_group: HashMap<(String, String), Vec<i64>> = HashMap::new();
    let mut result = HashMap::new();
    let mut stmt = match conn.prepare("SELECT name, kind, line FROM nodes WHERE file = ?1") {
        Ok(s) => s,
        Err(_) => return result,
    };
    let rows = match stmt.query_map([file], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return result,
    };
    for row in rows.flatten() {
        by_group.entry((row.0, row.1)).or_default().push(row.2);
    }
    for ((name, kind), mut lines) in by_group {
        lines.sort_unstable();
        let sibling_count = lines.len() as i64;
        for (idx, line) in lines.iter().enumerate() {
            result.insert((name.clone(), kind.clone(), *line), (idx as i64 + 1, sibling_count));
        }
    }
    result
}

/// Save edges from reverse-dep files → changed files BEFORE purge so they
/// can be reconnected to new target node IDs after node insertion (#1012).
///
/// Mirrors the JS `purgeAndAddReverseDeps` path in `detect-changes.ts`. By
/// saving the edge topology and reconnecting after insert, we avoid the need
/// to re-parse every reverse-dep file just to rebuild its edges. That re-parse
/// is what made the native pipeline scale parse/insert/structure/roles with
/// the full reverse-dep cone (47 files for a 1-file change) instead of just
/// the truly-changed files (1 file).
pub fn save_reverse_dep_edges(
    conn: &Connection,
    changed_paths: &[String],
) -> Vec<SavedReverseDepEdge> {
    let mut saved = Vec::new();
    if changed_paths.is_empty() {
        return saved;
    }
    let changed_set: HashSet<&str> = changed_paths.iter().map(|s| s.as_str()).collect();

    let mut stmt = match conn.prepare(
        "SELECT e.source_id, n_tgt.name, n_tgt.kind, n_tgt.file, n_tgt.line, \
                e.kind, e.confidence, e.dynamic, n_src.file \
         FROM edges e \
         JOIN nodes n_src ON e.source_id = n_src.id \
         JOIN nodes n_tgt ON e.target_id = n_tgt.id \
         WHERE n_tgt.file = ?1 AND n_src.file != n_tgt.file",
    ) {
        Ok(s) => s,
        Err(_) => return saved,
    };

    for changed in changed_paths {
        // Must be computed BEFORE this file's nodes are purged — captures the
        // pre-purge sibling layout so reconnection can map old→new correctly
        // even when several same-named/same-kind symbols exist in the file.
        let ordinals = compute_ordinals(conn, changed);
        let rows = match stmt.query_map([changed], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
            ))
        }) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for row in rows.flatten() {
            // Skip edges whose source is itself being purged — buildEdges will
            // re-emit them with correct new IDs.
            if changed_set.contains(row.8.as_str()) {
                continue;
            }
            let (tgt_ordinal, tgt_sibling_count) = ordinals
                .get(&(row.1.clone(), row.2.clone(), row.4))
                .copied()
                .unwrap_or((1, 1));
            saved.push(SavedReverseDepEdge {
                source_id: row.0,
                tgt_name: row.1,
                tgt_kind: row.2,
                tgt_file: row.3,
                tgt_line: row.4,
                edge_kind: row.5,
                confidence: row.6,
                dynamic: row.7,
                tgt_ordinal,
                tgt_sibling_count,
            });
        }
    }
    saved
}

/// Picks the correct reconnect target among same-(name,kind,file) candidates
/// (sorted by ascending line).
///
/// When only one candidate exists, it's an unambiguous match. When several
/// exist (e.g. multiple object-literal `close() {}` methods in one file) and
/// the sibling-group size is unchanged since save, the saved ordinal — the
/// target's rank by line among its siblings at save time — reliably
/// identifies the original target even though the whole group may have
/// shifted by an arbitrary number of lines. Falls back to nearest-line only
/// when the sibling count itself changed (a same-named sibling was added or
/// removed), since the ordinal mapping can no longer be trusted — see #1752.
fn pick_reconnect_target(
    candidates: &[(i64, i64)],
    tgt_ordinal: i64,
    tgt_sibling_count: i64,
    tgt_line: i64,
) -> Option<i64> {
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return Some(candidates[0].0);
    }
    if candidates.len() as i64 == tgt_sibling_count
        && tgt_ordinal >= 1
        && (tgt_ordinal as usize) <= candidates.len()
    {
        return Some(candidates[(tgt_ordinal - 1) as usize].0);
    }
    candidates
        .iter()
        .min_by_key(|(_, line)| (line - tgt_line).abs())
        .map(|(id, _)| *id)
}

/// Reconnect saved reverse-dep edges to the new target node IDs.
///
/// The source node ID is still valid (reverse-dep nodes were never purged).
/// The target was deleted and re-inserted with a new ID — look up all
/// (name, kind, file) candidates and pick the one matching the saved ordinal
/// (see `pick_reconnect_target`), then recreate the edge. Mirrors
/// `reconnectReverseDepEdges` in `build-edges.ts`.
///
/// Returns (reconnected, dropped) counts.
pub fn reconnect_reverse_dep_edges(
    conn: &Connection,
    saved: &[SavedReverseDepEdge],
) -> (usize, usize) {
    if saved.is_empty() {
        return (0, 0);
    }
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return (0, 0),
    };

    let mut reconnected = 0usize;
    let mut dropped = 0usize;
    {
        let mut candidates_stmt = match tx.prepare(
            "SELECT id, line FROM nodes WHERE name = ?1 AND kind = ?2 AND file = ?3 ORDER BY line",
        ) {
            Ok(s) => s,
            Err(_) => return (0, 0),
        };
        let mut insert_stmt = match tx.prepare(
            "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        ) {
            Ok(s) => s,
            Err(_) => return (0, 0),
        };

        // Cache candidate lists per (name, kind, file) group — many saved
        // edges often share the same target (e.g. several callers of the
        // same function), so this avoids re-querying per edge.
        let mut candidates_cache: HashMap<(String, String, String), Vec<(i64, i64)>> =
            HashMap::new();

        for s in saved {
            let key = (s.tgt_name.clone(), s.tgt_kind.clone(), s.tgt_file.clone());
            let candidates = match candidates_cache.entry(key) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(e) => {
                    let mut rows: Vec<(i64, i64)> = Vec::new();
                    if let Ok(mut rows_iter) = candidates_stmt
                        .query(rusqlite::params![&s.tgt_name, &s.tgt_kind, &s.tgt_file])
                    {
                        while let Ok(Some(row)) = rows_iter.next() {
                            if let (Ok(id), Ok(line)) =
                                (row.get::<_, i64>(0), row.get::<_, i64>(1))
                            {
                                rows.push((id, line));
                            }
                        }
                    }
                    e.insert(rows)
                }
            };

            match pick_reconnect_target(
                candidates,
                s.tgt_ordinal,
                s.tgt_sibling_count,
                s.tgt_line,
            ) {
                Some(new_id) => {
                    // INSERT OR IGNORE silently swallows duplicate-row constraint
                    // errors and returns Ok(0). Only count rows that actually
                    // inserted so the diagnostic counter isn't inflated by no-ops.
                    match insert_stmt.execute(rusqlite::params![
                        s.source_id,
                        new_id,
                        &s.edge_kind,
                        s.confidence,
                        s.dynamic,
                    ]) {
                        Ok(n) if n > 0 => reconnected += 1,
                        Ok(_) => {} // duplicate skipped by INSERT OR IGNORE
                        Err(_) => dropped += 1,
                    }
                }
                None => {
                    dropped += 1;
                }
            }
        }
    }
    let _ = tx.commit();
    (reconnected, dropped)
}

/// Find files that import from changed files (reverse dependencies).
pub fn find_reverse_dependencies(
    conn: &Connection,
    changed_rel_paths: &HashSet<String>,
    root_dir: &str,
) -> HashSet<String> {
    let mut reverse_deps = HashSet::new();
    if changed_rel_paths.is_empty() {
        return reverse_deps;
    }

    let mut stmt = match conn.prepare(
        "SELECT DISTINCT n_src.file FROM edges e \
         JOIN nodes n_src ON e.source_id = n_src.id \
         JOIN nodes n_tgt ON e.target_id = n_tgt.id \
         WHERE n_tgt.file = ? AND n_src.file != n_tgt.file AND n_src.kind != 'directory'",
    ) {
        Ok(s) => s,
        Err(_) => return reverse_deps,
    };

    for rel_path in changed_rel_paths {
        if let Ok(rows) = stmt.query_map([rel_path], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                if !changed_rel_paths.contains(&row) && !reverse_deps.contains(&row) {
                    let abs_path = Path::new(root_dir).join(&row);
                    if abs_path.exists() {
                        reverse_deps.insert(row);
                    }
                }
            }
        }
    }

    reverse_deps
}

/// Purge graph data for changed/removed files and delete outgoing edges for reverse deps.
///
/// Deletion order: analysis dependents → edges → nodes (matches `connection::purge_files_data`).
/// Analysis tables use join-based queries (node_id IN SELECT id FROM nodes) because they
/// reference nodes by ID, not by file path directly.
pub fn purge_changed_files(
    conn: &Connection,
    files_to_purge: &[String],
    reverse_dep_files: &[String],
) {
    if files_to_purge.is_empty() && reverse_dep_files.is_empty() {
        return;
    }

    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };

    // Purge each file across all tables. Optional tables are silently skipped
    // if they don't exist. Order: analysis dependents → edges → nodes.
    //
    // Note: PRAGMA foreign_keys may be ON (set by clear_all_graph_data on the same
    // connection during the prior full build). The ordering below ensures child rows
    // are deleted before their parent rows to avoid SQLITE_CONSTRAINT_FOREIGNKEY.
    let purge_sql: &[(&str, bool)] = &[
        // Analysis tables (optional — may not exist)
        ("DELETE FROM embeddings WHERE node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM cfg_edges WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM cfg_blocks WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        // Delete dataflow rows that reference edges touching this file via call_edge_id
        // BEFORE deleting those edges — dataflow.call_edge_id REFERENCES edges(id).
        ("DELETE FROM dataflow WHERE call_edge_id IN (SELECT id FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1))", false),
        ("DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        // dataflow rows linked via vertex FK (v18+ schemas).
        ("DELETE FROM dataflow WHERE source_vertex IN (SELECT id FROM dataflow_vertices WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1)) OR target_vertex IN (SELECT id FROM dataflow_vertices WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1))", false),
        ("DELETE FROM dataflow_summary WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM dataflow_vertices WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM function_complexity WHERE node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM node_metrics WHERE node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM ast_nodes WHERE file = ?1", false),
        // Core tables (errors logged)
        ("DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1)", true),
        ("DELETE FROM nodes WHERE file = ?1", true),
    ];

    for file in files_to_purge {
        for &(sql, required) in purge_sql {
            match tx.execute(sql, rusqlite::params![file]) {
                Ok(_) => {}
                Err(e) if required => {
                    eprintln!("[codegraph] purge failed for \"{file}\": {e}");
                }
                Err(_) => {} // optional table missing — skip
            }
        }
    }

    // Delete outgoing edges for reverse-dep files (they'll be re-built).
    // These files keep their nodes but need outgoing edges rebuilt.
    // Clear dataflow rows referencing those outgoing edges via call_edge_id first
    // to satisfy the FK constraint when PRAGMA foreign_keys is ON.
    if !reverse_dep_files.is_empty() {
        let dfcall_sql = "DELETE FROM dataflow WHERE call_edge_id IN \
             (SELECT id FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?))";
        let edge_sql =
            "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)";
        for f in reverse_dep_files {
            // Optional — column absent in pre-v18 schemas; ignore errors.
            let _ = tx.execute(dfcall_sql, [f]);
            let _ = tx.execute(edge_sql, [f]);
        }
    }

    let _ = tx.commit();
}

/// Full build: clear all graph data including file_hashes.
///
/// Clearing file_hashes ensures the next incremental build starts from a
/// clean state — otherwise stale hash entries from a prior incremental
/// build would cause files to be misclassified as unchanged.
pub fn clear_all_graph_data(conn: &Connection, has_embeddings: bool) {
    let mut sql = String::from(
        "PRAGMA foreign_keys = OFF; \
         DELETE FROM cfg_edges; DELETE FROM cfg_blocks; DELETE FROM node_metrics; \
         DELETE FROM edges; DELETE FROM function_complexity; DELETE FROM dataflow; \
         DELETE FROM ast_nodes; DELETE FROM nodes; DELETE FROM file_hashes;",
    );
    if has_embeddings {
        sql.push_str(" DELETE FROM embeddings;");
    }
    sql.push_str(" PRAGMA foreign_keys = ON;");
    let _ = conn.execute_batch(&sql);
}

/// Check if the embeddings table has any data.
pub fn has_embeddings(conn: &Connection) -> bool {
    conn.query_row("SELECT 1 FROM embeddings LIMIT 1", [], |_| Ok(()))
        .is_ok()
}

/// Heal metadata for files with unchanged content but stale mtime/size.
pub fn heal_metadata(conn: &Connection, updates: &[MetadataUpdate]) {
    if updates.is_empty() {
        return;
    }
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };
    if let Ok(mut stmt) = tx
        .prepare("INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)")
    {
        for u in updates {
            let _ = stmt.execute(rusqlite::params![u.rel_path, u.hash, u.mtime, u.size]);
        }
    }
    let _ = tx.commit();
}

/// Main entry point: detect changes using the tiered strategy.
///
/// Returns `None` for full builds (no file_hashes table or force flag).
///
/// When `scoped_rel_paths` is provided, removal detection is limited to files
/// within that scope — non-scoped files in the DB are left untouched.
pub fn detect_changes(
    conn: &Connection,
    all_files: &[String],
    root_dir: &str,
    incremental: bool,
    force_full_rebuild: bool,
    scoped_rel_paths: Option<&HashSet<String>>,
) -> ChangeResult {
    if !incremental || force_full_rebuild {
        return ChangeResult {
            changed: all_files
                .iter()
                .map(|f| ChangedFile {
                    abs_path: f.clone(),
                    rel_path: relative_path(root_dir, f),
                    content: None,
                    hash: None,
                    mtime: 0,
                    size: 0,
                    metadata_only: false,
                    reverse_dep_only: false,
                })
                .collect(),
            removed: Vec::new(),
            is_full_build: true,
            metadata_updates: Vec::new(),
        };
    }

    let existing = match load_file_hashes(conn) {
        Some(h) => h,
        None => {
            return ChangeResult {
                changed: all_files
                    .iter()
                    .map(|f| ChangedFile {
                        abs_path: f.clone(),
                        rel_path: relative_path(root_dir, f),
                        content: None,
                        hash: None,
                        mtime: 0,
                        size: 0,
                        metadata_only: false,
                        reverse_dep_only: false,
                    })
                    .collect(),
                removed: Vec::new(),
                is_full_build: true,
                metadata_updates: Vec::new(),
            };
        }
    };

    let removed = detect_removed_files(&existing, all_files, root_dir, scoped_rel_paths);

    // Try Tier 0 (journal) first
    if let Some(result) = try_journal_tier(conn, &existing, root_dir, &removed) {
        return result;
    }

    // Fall back to Tier 1+2 (mtime/size then hash)
    mtime_and_hash_tiers(&existing, all_files, root_dir, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_works() {
        assert_eq!(
            relative_path("/project", "/project/src/main.ts"),
            "src/main.ts"
        );
        assert_eq!(
            relative_path("/project", "/project/src/utils/helper.ts"),
            "src/utils/helper.ts"
        );
    }

    #[test]
    fn hash_is_deterministic() {
        let h1 = file_hash_sha256("hello world");
        let h2 = file_hash_sha256("hello world");
        assert_eq!(h1, h2);
        assert_ne!(h1, file_hash_sha256("different content"));
    }

    #[test]
    fn detect_removed_finds_missing() {
        let mut existing = HashMap::new();
        existing.insert(
            "src/a.ts".to_string(),
            FileHashRow {
                file: "src/a.ts".to_string(),
                hash: "abc".to_string(),
                mtime: 0,
                size: 0,
            },
        );
        existing.insert(
            "src/b.ts".to_string(),
            FileHashRow {
                file: "src/b.ts".to_string(),
                hash: "def".to_string(),
                mtime: 0,
                size: 0,
            },
        );

        let all_files = vec!["/project/src/a.ts".to_string()];
        let removed = detect_removed_files(&existing, &all_files, "/project", None);
        assert_eq!(removed, vec!["src/b.ts"]);
    }

    #[test]
    fn detect_removed_skips_unsupported_extensions() {
        // Files that the JS-side WASM backfill wrote into `file_hashes` for
        // an extension that the Rust `file_collector` doesn't recognise must
        // not be flagged as removed merely because the orchestrator's
        // narrower collector never sees them — that would purge their rows
        // on every incremental rebuild (the #1066 ~2s floor). All currently
        // registered languages have native extractors, so this test uses
        // synthetic extensions that are deliberately outside the
        // `SUPPORTED_EXTENSIONS` set to exercise the skip path.
        let mut existing = HashMap::new();
        for path in [
            "tests/fixtures/unknown/main.unknownlang",
            "tests/fixtures/unknown/util.fakelang",
        ] {
            existing.insert(
                path.to_string(),
                FileHashRow {
                    file: path.to_string(),
                    hash: "h".to_string(),
                    mtime: 0,
                    size: 0,
                },
            );
        }
        // Also include a supported file that IS missing from disk — should
        // still be flagged as removed.
        existing.insert(
            "src/deleted.ts".to_string(),
            FileHashRow {
                file: "src/deleted.ts".to_string(),
                hash: "h".to_string(),
                mtime: 0,
                size: 0,
            },
        );

        let all_files: Vec<String> = Vec::new();
        let removed = detect_removed_files(&existing, &all_files, "/project", None);
        assert_eq!(removed, vec!["src/deleted.ts"]);
    }

    // ── Reverse-dep edge reconnection (#1752) ───────────────────────────

    #[test]
    fn pick_reconnect_target_single_candidate_is_unambiguous() {
        let candidates = vec![(42, 100)];
        assert_eq!(pick_reconnect_target(&candidates, 1, 1, 999), Some(42));
    }

    #[test]
    fn pick_reconnect_target_no_candidates_returns_none() {
        let candidates: Vec<(i64, i64)> = vec![];
        assert_eq!(pick_reconnect_target(&candidates, 1, 1, 100), None);
    }

    #[test]
    fn pick_reconnect_target_uses_ordinal_when_sibling_count_matches() {
        // Four same-named/same-kind siblings (e.g. four `close() {}` methods),
        // shifted down by an insertion elsewhere in the file. The 3rd-ranked
        // sibling (originally closest to line 433 in the pre-shift layout)
        // must still resolve to the 3rd-ranked sibling post-shift (id 30,
        // line 580), NOT to whichever candidate is nearest to the stale old
        // line 433 (which would wrongly pick id 10 / line 433... except that
        // id no longer exists post-purge; the point is nearest-*new*-line
        // to the OLD reference can pick the wrong post-shift sibling once the
        // group shifts unevenly).
        let candidates = vec![(10, 178), (20, 461), (30, 500), (40, 580)];
        // Saved ordinal=3 out of 4 siblings (matches count) → must pick the
        // 3rd by line (id 30), regardless of how far tgt_line (the stale old
        // reference, 433) now sits from any candidate.
        let picked = pick_reconnect_target(&candidates, 3, 4, 433);
        assert_eq!(picked, Some(30));
    }

    #[test]
    fn pick_reconnect_target_falls_back_to_nearest_line_when_sibling_count_changed() {
        // A sibling was added/removed since save — the ordinal mapping can no
        // longer be trusted, so fall back to nearest-line (best effort, same
        // as pre-#1752 behavior).
        let candidates = vec![(10, 100), (20, 200), (30, 300)];
        // Saved sibling_count=2 but now there are 3 candidates → mismatch.
        let picked = pick_reconnect_target(&candidates, 2, 2, 195);
        assert_eq!(picked, Some(20)); // nearest to 195 is line 200
    }

    /// Minimal in-memory schema covering only the columns `save_reverse_dep_edges`
    /// / `reconnect_reverse_dep_edges` touch — not the full production migration set.
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                file TEXT NOT NULL,
                line INTEGER,
                UNIQUE(name, kind, file, line)
            );
            CREATE TABLE edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER NOT NULL,
                target_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                confidence REAL DEFAULT 1.0,
                dynamic INTEGER DEFAULT 0
            );",
        )
        .unwrap();
        conn
    }

    fn insert_node(conn: &Connection, name: &str, kind: &str, file: &str, line: i64) -> i64 {
        conn.execute(
            "INSERT INTO nodes (name, kind, file, line) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![name, kind, file, line],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn compute_ordinals_ranks_same_name_kind_siblings_by_line() {
        let conn = test_conn();
        insert_node(&conn, "close", "method", "src/db/connection.ts", 433);
        insert_node(&conn, "close", "method", "src/db/connection.ts", 461);
        insert_node(&conn, "close", "method", "src/db/connection.ts", 500);
        insert_node(&conn, "close", "method", "src/db/connection.ts", 580);
        // An unrelated, uniquely-named sibling must not pollute the group.
        insert_node(&conn, "openDb", "function", "src/db/connection.ts", 161);

        let ordinals = compute_ordinals(&conn, "src/db/connection.ts");
        let key = |line: i64| ("close".to_string(), "method".to_string(), line);
        assert_eq!(ordinals.get(&key(433)), Some(&(1, 4)));
        assert_eq!(ordinals.get(&key(461)), Some(&(2, 4)));
        assert_eq!(ordinals.get(&key(500)), Some(&(3, 4)));
        assert_eq!(ordinals.get(&key(580)), Some(&(4, 4)));
        assert_eq!(
            ordinals.get(&("openDb".to_string(), "function".to_string(), 161)),
            Some(&(1, 1))
        );
    }

    /// End-to-end reproduction of #1752: a reverse-dep caller's edge to the
    /// 3rd of four same-named `close` siblings must survive a purge+reinsert
    /// cycle that shifts all four down uniformly (inserting a new, unrelated
    /// function above them — exactly the real repro: "insert N lines above
    /// several existing functions"). A uniform shift is already enough to
    /// break the old nearest-*old*-line heuristic: once the whole group moves
    /// far enough, the saved reference line (500) ends up numerically closest
    /// to the wrong (lowest) candidate's new line rather than its own —
    /// mirroring the real bug's `close@433` vs `close@580` divergence found
    /// by replaying this repo's actual commit history.
    #[test]
    fn reconnect_survives_uniform_shift_of_same_named_siblings() {
        let conn = test_conn();
        let file = "src/db/connection.ts";

        // Pre-edit layout: four `close` siblings.
        insert_node(&conn, "close", "method", file, 433);
        insert_node(&conn, "close", "method", file, 461);
        let target_old_id = insert_node(&conn, "close", "method", file, 500);
        insert_node(&conn, "close", "method", file, 580);
        // External caller in a different (untouched) file.
        let caller_id = insert_node(&conn, "triageData", "function", "src/features/triage.ts", 146);
        conn.execute(
            "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?1, ?2, 'calls', 0.5, 0)",
            rusqlite::params![caller_id, target_old_id],
        )
        .unwrap();

        let saved = save_reverse_dep_edges(&conn, &[file.to_string()]);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].tgt_ordinal, 3);
        assert_eq!(saved[0].tgt_sibling_count, 4);

        // Simulate purge_changed_files: delete the changed file's nodes/edges.
        conn.execute("DELETE FROM edges WHERE target_id IN (SELECT id FROM nodes WHERE file = ?1)", [file]).unwrap();
        conn.execute("DELETE FROM nodes WHERE file = ?1", [file]).unwrap();

        // Re-insert: a new function was added above all four, shifting every
        // sibling down by the same delta (147 lines) — the exact shape of the
        // real #1752 repro (insert one helper above several functions).
        insert_node(&conn, "close", "method", file, 433 + 147);
        insert_node(&conn, "close", "method", file, 461 + 147);
        let target_new_id = insert_node(&conn, "close", "method", file, 500 + 147);
        insert_node(&conn, "close", "method", file, 580 + 147);

        let (reconnected, dropped) = reconnect_reverse_dep_edges(&conn, &saved);
        assert_eq!((reconnected, dropped), (1, 0));

        let new_target: i64 = conn
            .query_row(
                "SELECT target_id FROM edges WHERE source_id = ?1",
                [caller_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(new_target, target_new_id);
    }
}
