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
}

/// Key identifying a same-(name, kind) sibling group within one file.
pub type SiblingGroupKey = (String, String, String);

/// Computes the sorted line list for every (name, kind) sibling group within
/// `file`, keyed by `(name, kind)`.
///
/// A file can contain multiple distinct symbols with the identical name and
/// kind — e.g. several object-literal `close() {}` methods returned from
/// different functions in the same file. `(name, kind, file)` alone is not a
/// unique identity for such symbols, so `reconnect_reverse_dep_edges` cannot
/// safely tell them apart by nearest-line matching once unrelated code
/// shifts the candidates unevenly, or a same-named sibling is added/removed
/// in the same edit (#1752, #1865). The sorted line list captured here — the
/// sibling group's layout at save time — lets reconnection align old targets
/// to their correct new nodes by rank when the sibling count is unchanged,
/// or by the dominant line-shift that best explains the surviving siblings
/// when it changed (see `align_sibling_lines`), which tolerates both a
/// uniform shift of the whole group AND a change in the group's size.
fn compute_sibling_groups(conn: &Connection, file: &str) -> HashMap<(String, String), Vec<i64>> {
    let mut groups: HashMap<(String, String), Vec<i64>> = HashMap::new();
    let mut stmt = match conn.prepare("SELECT name, kind, line FROM nodes WHERE file = ?1") {
        Ok(s) => s,
        Err(_) => return groups,
    };
    let rows = match stmt.query_map([file], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return groups,
    };
    for row in rows.flatten() {
        groups.entry((row.0, row.1)).or_default().push(row.2);
    }
    for lines in groups.values_mut() {
        lines.sort_unstable();
    }
    groups
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
) -> (Vec<SavedReverseDepEdge>, HashMap<SiblingGroupKey, Vec<i64>>) {
    let mut saved = Vec::new();
    let mut sibling_groups: HashMap<SiblingGroupKey, Vec<i64>> = HashMap::new();
    if changed_paths.is_empty() {
        return (saved, sibling_groups);
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
        Err(_) => return (saved, sibling_groups),
    };

    for changed in changed_paths {
        // Must be computed BEFORE this file's nodes are purged — captures the
        // pre-purge sibling layout so reconnection can map old→new correctly
        // even when several same-named/same-kind symbols exist in the file.
        let groups = compute_sibling_groups(conn, changed);
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
            let group_key: SiblingGroupKey = (row.1.clone(), row.2.clone(), row.3.clone());
            sibling_groups.entry(group_key).or_insert_with(|| {
                groups
                    .get(&(row.1.clone(), row.2.clone()))
                    .cloned()
                    .unwrap_or_else(|| vec![row.4])
            });
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
    (saved, sibling_groups)
}

/// Aligns two ascending line arrays representing the same-(name, kind)
/// sibling group before (`old_lines`) and after (`new_lines`) a
/// purge+reinsert. Mirrors `alignSiblingLines` in `build-edges.ts`.
///
/// When the sibling count is unchanged, declarations of the same name and
/// kind within one file keep their relative textual order across an edit —
/// even when the whole group shifts by an arbitrary, non-uniform amount per
/// sibling (e.g. one sibling's own body grew independently) — so mapping by
/// rank (1st old -> 1st new, 2nd -> 2nd, ...) is always correct (#1752).
///
/// When the count changed (a same-named sibling was added or removed in the
/// same edit), rank order alone can't tell which element is the new/missing
/// one. But the untouched siblings' OWN source text wasn't edited, so they
/// all shift by the exact SAME line delta — whatever unrelated insertion or
/// deletion elsewhere in the file caused the shift applies uniformly to
/// everything below/above it. This finds the single shift value `S` that
/// makes `old + S` land on a real new line for the most siblings — the
/// dominant shift — and matches every old line whose shifted position
/// exists in `new_lines`; the rest were removed. This is far more reliable
/// than picking whichever old/new pairing merely minimizes total line
/// distance, which a uniform shift can fool once an old line coincidentally
/// ends up numerically closer to a different sibling's new position than to
/// its own (confirmed against this repo's real #1752 fixture numbers) —
/// see #1865.
///
/// Returns a map from each old line to its aligned new line. An old line
/// missing from the result means its sibling was removed (no new line
/// matches it) — callers must drop, not guess, in that case.
fn align_sibling_lines(old_lines: &[i64], new_lines: &[i64]) -> HashMap<i64, i64> {
    let mut result = HashMap::new();
    if old_lines.is_empty() || new_lines.is_empty() {
        return result;
    }

    if old_lines.len() == new_lines.len() {
        for (old_line, new_line) in old_lines.iter().zip(new_lines.iter()) {
            result.insert(*old_line, *new_line);
        }
        return result;
    }

    let new_line_set: HashSet<i64> = new_lines.iter().copied().collect();
    let mut shift_counts: HashMap<i64, i64> = HashMap::new();
    for &old_line in old_lines {
        for &new_line in new_lines {
            *shift_counts.entry(new_line - old_line).or_insert(0) += 1;
        }
    }
    // Tie-break fully by value (not HashMap iteration order, which Rust
    // leaves unspecified): prefer the higher match count, then the smaller
    // magnitude shift, then the smaller signed shift. Mirrors the JS
    // implementation exactly so both engines pick the same shift on a tie.
    let mut best_shift = 0i64;
    let mut best_count = -1i64;
    for (&shift, &count) in &shift_counts {
        let better = count > best_count
            || (count == best_count
                && (shift.abs() < best_shift.abs()
                    || (shift.abs() == best_shift.abs() && shift < best_shift)));
        if better {
            best_shift = shift;
            best_count = count;
        }
    }
    for &old_line in old_lines {
        let candidate = old_line + best_shift;
        if new_line_set.contains(&candidate) {
            result.insert(old_line, candidate);
        }
    }
    result
}

/// Picks the correct reconnect target among same-(name, kind, file)
/// candidates.
///
/// A single candidate is an unambiguous match. With several candidates (e.g.
/// multiple object-literal `close() {}` methods in one file), the saved
/// sibling-group snapshot from before purge is aligned against the current
/// candidate lines (see `align_sibling_lines`) to find which new line the
/// saved target's old line maps to — correct even when the whole group
/// shifted and its size changed in the same edit. Falls back to
/// nearest-line only when no sibling-group snapshot is available, or the
/// group is too large to align cheaply.
fn pick_reconnect_target(
    candidates: &[(i64, i64)],
    tgt_line: i64,
    group_key: &SiblingGroupKey,
    saved_sibling_groups: &HashMap<SiblingGroupKey, Vec<i64>>,
    alignment_cache: &mut HashMap<SiblingGroupKey, HashMap<i64, i64>>,
    max_align_group_size: usize,
) -> Option<i64> {
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return Some(candidates[0].0);
    }

    if let Some(old_lines) = saved_sibling_groups.get(group_key) {
        if !old_lines.is_empty()
            && old_lines.len() <= max_align_group_size
            && candidates.len() <= max_align_group_size
        {
            let alignment = match alignment_cache.entry(group_key.clone()) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(e) => {
                    let new_lines: Vec<i64> = candidates.iter().map(|(_, line)| *line).collect();
                    e.insert(align_sibling_lines(old_lines, &new_lines))
                }
            };
            return match alignment.get(&tgt_line) {
                Some(new_line) => candidates
                    .iter()
                    .find(|(_, line)| line == new_line)
                    .map(|(id, _)| *id),
                // tgt_line's sibling was legitimately removed in this edit —
                // the alignment already accounted for the size change, so
                // falling through to nearest-line here would silently
                // reattach to an unrelated sibling instead of correctly
                // dropping this edge.
                None => None,
            };
        }
    }

    // No sibling-group snapshot (shouldn't normally happen — every saved
    // edge has one recorded at save time) or the group exceeds the
    // alignment size cap — fall back to nearest-line.
    candidates
        .iter()
        .min_by_key(|(_, line)| (line - tgt_line).abs())
        .map(|(id, _)| *id)
}

/// Reconnect saved reverse-dep edges to the new target node IDs.
///
/// The source node ID is still valid (reverse-dep nodes were never purged).
/// The target was deleted and re-inserted with a new ID — look up all
/// (name, kind, file) candidates and pick the one the saved sibling-group
/// snapshot aligns to the saved line (see `pick_reconnect_target`), then
/// recreate the edge. Mirrors `reconnectReverseDepEdges` in
/// `build-edges.ts`.
///
/// Returns (reconnected, dropped) counts.
pub fn reconnect_reverse_dep_edges(
    conn: &Connection,
    saved: &[SavedReverseDepEdge],
    saved_sibling_groups: &HashMap<SiblingGroupKey, Vec<i64>>,
    max_align_group_size: usize,
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
        let mut candidates_cache: HashMap<SiblingGroupKey, Vec<(i64, i64)>> = HashMap::new();
        // Cache the (potentially expensive) alignment result per group too —
        // shared across every saved edge targeting the same sibling group.
        let mut alignment_cache: HashMap<SiblingGroupKey, HashMap<i64, i64>> = HashMap::new();

        for s in saved {
            let key = (s.tgt_name.clone(), s.tgt_kind.clone(), s.tgt_file.clone());
            let candidates = match candidates_cache.entry(key.clone()) {
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
                s.tgt_line,
                &key,
                saved_sibling_groups,
                &mut alignment_cache,
                max_align_group_size,
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

/// Captures the forward+reverse import-neighbor file set for files about to
/// be removed, BEFORE `purge_changed_files` deletes their edges.
///
/// `refresh_affected_directory_metrics` discovers cross-directory neighbors
/// by querying LIVE import edges from the affected directories — this works
/// for added/modified files (their edges are rebuilt and still present) but
/// not for removed files, whose edges in both directions are purged before
/// the structure stage runs. Reading them here, one step earlier in the
/// pipeline, closes that gap. Mirrors `captureRemovedFileNeighbors` in
/// `detect-changes.ts` (#1839).
pub fn capture_removed_file_neighbors(conn: &Connection, removed_files: &[String]) -> Vec<String> {
    if removed_files.is_empty() {
        return Vec::new();
    }
    let removed_set: HashSet<&str> = removed_files.iter().map(|s| s.as_str()).collect();
    let mut neighbors: HashSet<String> = HashSet::new();

    let mut stmt = match conn.prepare(
        "SELECT n2.file AS other FROM edges e \
           JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id \
           WHERE e.kind IN ('imports', 'imports-type') AND n1.file != n2.file AND n1.file = ?1 \
         UNION \
         SELECT n1.file AS other FROM edges e \
           JOIN nodes n1 ON e.source_id = n1.id JOIN nodes n2 ON e.target_id = n2.id \
           WHERE e.kind IN ('imports', 'imports-type') AND n1.file != n2.file AND n2.file = ?1",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    for f in removed_files {
        if let Ok(rows) = stmt.query_map([f], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                if !removed_set.contains(row.as_str()) {
                    neighbors.insert(row);
                }
            }
        }
    }

    neighbors.into_iter().collect()
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

    // ── Reverse-dep edge reconnection (#1752, #1865) ────────────────────

    /// Convenience wrapper mirroring the pre-#1865 `pick_reconnect_target`
    /// call shape: builds the single-group map + a fresh alignment cache
    /// internally so each test case reads as a plain (candidates, old_lines,
    /// tgt_line) -> Option<id> call.
    fn pick(
        candidates: &[(i64, i64)],
        old_lines: &[i64],
        tgt_line: i64,
    ) -> Option<i64> {
        let key: SiblingGroupKey = ("x".to_string(), "method".to_string(), "f.ts".to_string());
        let mut groups = HashMap::new();
        groups.insert(key.clone(), old_lines.to_vec());
        let mut cache = HashMap::new();
        pick_reconnect_target(candidates, tgt_line, &key, &groups, &mut cache, 200)
    }

    #[test]
    fn pick_reconnect_target_single_candidate_is_unambiguous() {
        let candidates = vec![(42, 100)];
        assert_eq!(pick(&candidates, &[999], 999), Some(42));
    }

    #[test]
    fn pick_reconnect_target_no_candidates_returns_none() {
        let candidates: Vec<(i64, i64)> = vec![];
        assert_eq!(pick(&candidates, &[100], 100), None);
    }

    #[test]
    fn pick_reconnect_target_aligns_unchanged_group_by_rank() {
        // Four same-named/same-kind siblings (e.g. four `close() {}` methods),
        // shifted down by an insertion elsewhere in the file. The 3rd-ranked
        // sibling (old line 500) must still resolve to the 3rd-ranked sibling
        // post-shift (id 30, line 580), NOT to whichever candidate is nearest
        // to the stale old line 500 (which would wrongly pick a different id
        // once the group shifts unevenly).
        let old_lines = vec![433, 461, 500, 580];
        let candidates = vec![(10, 178), (20, 461), (30, 500 + 80), (40, 580 + 80)];
        let picked = pick(&candidates, &old_lines, 500);
        assert_eq!(picked, Some(30));
    }

    #[test]
    fn pick_reconnect_target_drops_edge_when_its_own_sibling_was_removed() {
        // Sibling count changed (4 -> 3): old line 200's sibling was removed,
        // the other three shifted down by 50. The edge targeting line 200
        // must be dropped (no matching new line) — not silently reattached
        // to whichever candidate happens to be nearest.
        let old_lines = vec![100, 200, 300, 400];
        let candidates = vec![(10, 150), (30, 350), (40, 450)]; // id 20 (line 200) removed
        assert_eq!(pick(&candidates, &old_lines, 200), None);
        // The untouched siblings must still resolve correctly despite the
        // group's size having changed in the same edit (#1865).
        assert_eq!(pick(&candidates, &old_lines, 100), Some(10));
        assert_eq!(pick(&candidates, &old_lines, 300), Some(30));
        assert_eq!(pick(&candidates, &old_lines, 400), Some(40));
    }

    #[test]
    fn pick_reconnect_target_survives_added_sibling_plus_shift() {
        // Sibling count changed (3 -> 4): a new sibling was inserted between
        // the 1st and 2nd old siblings, and the whole group shifted down by
        // 50. The two original siblings must still resolve to their own new
        // lines, not to the newly inserted one.
        let old_lines = vec![100, 300, 400];
        let candidates = vec![(10, 150), (99, 250), (30, 350), (40, 450)]; // id 99 is new
        assert_eq!(pick(&candidates, &old_lines, 100), Some(10));
        assert_eq!(pick(&candidates, &old_lines, 300), Some(30));
        assert_eq!(pick(&candidates, &old_lines, 400), Some(40));
    }

    #[test]
    fn align_sibling_lines_forces_exact_pairing_when_counts_match() {
        let old_lines = vec![433, 461, 500, 580];
        let new_lines = vec![513, 541, 580, 660]; // uniform +80 shift
        let alignment = align_sibling_lines(&old_lines, &new_lines);
        assert_eq!(alignment.get(&433), Some(&513));
        assert_eq!(alignment.get(&461), Some(&541));
        assert_eq!(alignment.get(&500), Some(&580));
        assert_eq!(alignment.get(&580), Some(&660));
    }

    #[test]
    fn align_sibling_lines_empty_inputs_yield_empty_map() {
        assert!(align_sibling_lines(&[], &[1, 2, 3]).is_empty());
        assert!(align_sibling_lines(&[1, 2, 3], &[]).is_empty());
        assert!(align_sibling_lines(&[], &[]).is_empty());
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
    fn compute_sibling_groups_ranks_same_name_kind_siblings_by_line() {
        let conn = test_conn();
        insert_node(&conn, "close", "method", "src/db/connection.ts", 433);
        insert_node(&conn, "close", "method", "src/db/connection.ts", 461);
        insert_node(&conn, "close", "method", "src/db/connection.ts", 500);
        insert_node(&conn, "close", "method", "src/db/connection.ts", 580);
        // An unrelated, uniquely-named sibling must not pollute the group.
        insert_node(&conn, "openDb", "function", "src/db/connection.ts", 161);

        let groups = compute_sibling_groups(&conn, "src/db/connection.ts");
        assert_eq!(
            groups.get(&("close".to_string(), "method".to_string())),
            Some(&vec![433, 461, 500, 580])
        );
        assert_eq!(
            groups.get(&("openDb".to_string(), "function".to_string())),
            Some(&vec![161])
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

        let (saved, sibling_groups) = save_reverse_dep_edges(&conn, &[file.to_string()]);
        assert_eq!(saved.len(), 1);
        assert_eq!(
            sibling_groups.get(&("close".to_string(), "method".to_string(), file.to_string())),
            Some(&vec![433, 461, 500, 580])
        );

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

        let (reconnected, dropped) =
            reconnect_reverse_dep_edges(&conn, &saved, &sibling_groups, 200);
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

    /// End-to-end reproduction of #1865: same shift as #1752's repro, but a
    /// same-named/same-kind sibling is ALSO renamed away (removed from the
    /// group) in the same edit — the exact compound scenario the pre-#1865
    /// ordinal+nearest-line fallback could not resolve correctly. The three
    /// untouched siblings' reverse-dep edges must all reconnect to their own
    /// correct new node despite the group shrinking from 4 to 3 in the same
    /// build that also shifted it.
    #[test]
    fn reconnect_survives_shift_plus_sibling_removed_in_same_edit() {
        let conn = test_conn();
        let file = "src/db/connection.ts";

        // Pre-edit layout: four `close` siblings (A, B, C, D by old line).
        let a_old = insert_node(&conn, "close", "method", file, 433);
        let b_old = insert_node(&conn, "close", "method", file, 461);
        let c_old = insert_node(&conn, "close", "method", file, 500);
        let d_old = insert_node(&conn, "close", "method", file, 580);

        // One external caller per sibling, in untouched files.
        let caller_a = insert_node(&conn, "useA", "function", "src/features/a.ts", 10);
        let caller_b = insert_node(&conn, "useB", "function", "src/features/b.ts", 10);
        let caller_c = insert_node(&conn, "useC", "function", "src/features/c.ts", 10);
        let caller_d = insert_node(&conn, "useD", "function", "src/features/d.ts", 10);
        for (caller, target) in [
            (caller_a, a_old),
            (caller_b, b_old),
            (caller_c, c_old),
            (caller_d, d_old),
        ] {
            conn.execute(
                "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?1, ?2, 'calls', 0.9, 0)",
                rusqlite::params![caller, target],
            )
            .unwrap();
        }

        let (saved, sibling_groups) = save_reverse_dep_edges(&conn, &[file.to_string()]);
        assert_eq!(saved.len(), 4);

        // Simulate purge_changed_files.
        conn.execute("DELETE FROM edges WHERE target_id IN (SELECT id FROM nodes WHERE file = ?1)", [file]).unwrap();
        conn.execute("DELETE FROM nodes WHERE file = ?1", [file]).unwrap();

        // Re-insert: whole group shifted +147 (unrelated helper inserted
        // above), AND B's `close` was renamed to `shutdown` in the same
        // edit — sibling count for (close, method) drops from 4 to 3.
        let a_new = insert_node(&conn, "close", "method", file, 433 + 147);
        insert_node(&conn, "shutdown", "method", file, 461 + 147); // was B's close
        let c_new = insert_node(&conn, "close", "method", file, 500 + 147);
        let d_new = insert_node(&conn, "close", "method", file, 580 + 147);

        let (reconnected, dropped) =
            reconnect_reverse_dep_edges(&conn, &saved, &sibling_groups, 200);
        // A, C, D reconnect correctly; B's edge is dropped (its `close` no
        // longer exists — renamed to `shutdown`).
        assert_eq!((reconnected, dropped), (3, 1));

        let target_of = |caller: i64| -> Option<i64> {
            conn.query_row(
                "SELECT target_id FROM edges WHERE source_id = ?1",
                [caller],
                |row| row.get(0),
            )
            .ok()
        };
        assert_eq!(target_of(caller_a), Some(a_new));
        assert_eq!(target_of(caller_b), None);
        assert_eq!(target_of(caller_c), Some(c_new));
        assert_eq!(target_of(caller_d), Some(d_new));
    }

    // ── capture_removed_file_neighbors (#1839) ──────────────────────────

    #[test]
    fn capture_removed_file_neighbors_finds_both_directions() {
        let conn = test_conn();
        // src/pkgA/a1.js imports src/pkgB/b1.js (forward); src/pkgC/c1.js
        // imports src/pkgA/a1.js (reverse) — both directions must surface.
        let a1 = insert_node(&conn, "a1", "function", "src/pkgA/a1.js", 1);
        let b1 = insert_node(&conn, "b1", "function", "src/pkgB/b1.js", 1);
        let c1 = insert_node(&conn, "c1", "function", "src/pkgC/c1.js", 1);
        // Unrelated file — must not appear in the result.
        insert_node(&conn, "d1", "function", "src/pkgD/d1.js", 1);

        conn.execute(
            "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?1, ?2, 'imports', 1.0, 0)",
            rusqlite::params![a1, b1],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?1, ?2, 'imports', 1.0, 0)",
            rusqlite::params![c1, a1],
        )
        .unwrap();

        let mut neighbors =
            capture_removed_file_neighbors(&conn, &["src/pkgA/a1.js".to_string()]);
        neighbors.sort();
        assert_eq!(
            neighbors,
            vec!["src/pkgB/b1.js".to_string(), "src/pkgC/c1.js".to_string()]
        );
    }

    #[test]
    fn capture_removed_file_neighbors_empty_for_no_removed_files() {
        let conn = test_conn();
        assert!(capture_removed_file_neighbors(&conn, &[]).is_empty());
    }

    #[test]
    fn capture_removed_file_neighbors_excludes_other_removed_files() {
        // Two files being removed together that import each other must not
        // report each other as "neighbors" — only still-live files count.
        let conn = test_conn();
        let a1 = insert_node(&conn, "a1", "function", "src/pkgA/a1.js", 1);
        let a2 = insert_node(&conn, "a2", "function", "src/pkgA/a2.js", 1);
        conn.execute(
            "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?1, ?2, 'imports', 1.0, 0)",
            rusqlite::params![a1, a2],
        )
        .unwrap();

        let neighbors = capture_removed_file_neighbors(
            &conn,
            &["src/pkgA/a1.js".to_string(), "src/pkgA/a2.js".to_string()],
        );
        assert!(neighbors.is_empty());
    }
}
