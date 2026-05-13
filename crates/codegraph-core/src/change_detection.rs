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

use crate::file_collector::is_supported_extension;
use crate::journal;
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
/// (e.g. `.erl`, `.fs` — WASM-only languages) are skipped:
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
            saved.push(SavedReverseDepEdge {
                source_id: row.0,
                tgt_name: row.1,
                tgt_kind: row.2,
                tgt_file: row.3,
                tgt_line: row.4,
                edge_kind: row.5,
                confidence: row.6,
                dynamic: row.7,
            });
        }
    }
    saved
}

/// Reconnect saved reverse-dep edges to the new target node IDs.
///
/// The source node ID is still valid (reverse-dep nodes were never purged).
/// The target was deleted and re-inserted with a new ID — look it up by
/// (name, kind, file) using nearest-line matching, and recreate the edge.
/// Mirrors `reconnectReverseDepEdges` in `build-edges.ts`.
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
        let mut find_stmt = match tx.prepare(
            "SELECT id FROM nodes WHERE name = ?1 AND kind = ?2 AND file = ?3 \
             ORDER BY ABS(line - ?4) LIMIT 1",
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
        for s in saved {
            match find_stmt.query_row(
                rusqlite::params![&s.tgt_name, &s.tgt_kind, &s.tgt_file, s.tgt_line],
                |row| row.get::<_, i64>(0),
            ) {
                Ok(new_id) => {
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
                Err(_) => {
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
/// Deletion order: analysis dependents → edges → nodes (matches `native_db::purge_files_data`).
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
    let purge_sql: &[(&str, bool)] = &[
        // Analysis tables (optional — may not exist)
        ("DELETE FROM embeddings WHERE node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM cfg_edges WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM cfg_blocks WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
        ("DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
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
    if !reverse_dep_files.is_empty() {
        if let Ok(mut stmt) =
            tx.prepare("DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)")
        {
            for f in reverse_dep_files {
                let _ = stmt.execute([f]);
            }
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
        // Files in WASM-only languages (Erlang, F#) live in
        // `file_hashes` because the JS-side WASM backfill writes them, but
        // Rust's narrower file_collector never collects them. Without this
        // skip, every incremental rebuild would flag them as removed and
        // purge their rows — the #1066 ~2s floor.
        let mut existing = HashMap::new();
        for path in [
            "tests/fixtures/erlang/main.erl",
            "tests/fixtures/fsharp/Main.fs",
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
}
