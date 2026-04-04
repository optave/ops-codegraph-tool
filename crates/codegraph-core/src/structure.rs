//! Structure metrics for the build pipeline.
//!
//! Computes per-file metrics (line count, symbol count, import count,
//! export count, fan-in, fan-out) and upserts them to `node_metrics`.
//!
//! For small incremental builds (≤5 files), uses targeted per-file queries.
//! For full/larger builds, delegates to the existing `buildStructure` in
//! `features/structure.ts` (via the JS fallback) or computes directly.

use crate::types::FileSymbols;
use rusqlite::Connection;
use std::collections::HashMap;

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
