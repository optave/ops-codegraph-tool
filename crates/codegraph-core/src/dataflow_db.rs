//! Bulk dataflow edge insertion via rusqlite.
//!
//! Bypasses the JS iteration loop by opening the SQLite database directly
//! from Rust and inserting all dataflow edges in a single transaction.
//! Node IDs are resolved by querying the `nodes` table (local-first, then global).

use std::collections::HashMap;

use napi_derive::napi;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

/// A single dataflow edge to insert (received from JS).
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataflowInsertEdge {
    /// Source function name (resolved to node ID)
    #[napi(js_name = "sourceName")]
    pub source_name: String,
    /// Target function name (resolved to node ID)
    #[napi(js_name = "targetName")]
    pub target_name: String,
    /// Edge kind: "flows_to", "returns", or "mutates"
    pub kind: String,
    #[napi(js_name = "paramIndex")]
    pub param_index: Option<u32>,
    pub expression: Option<String>,
    pub line: Option<u32>,
    pub confidence: f64,
}

/// A batch of dataflow edges for a single file.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDataflowBatch {
    /// Relative file path (for local-first node resolution)
    pub file: String,
    pub edges: Vec<DataflowInsertEdge>,
}

/// Resolve a function name to a node ID, preferring local (same-file) matches.
fn resolve_node(
    local_stmt: &mut rusqlite::Statement,
    global_stmt: &mut rusqlite::Statement,
    name: &str,
    file: &str,
    cache: &mut HashMap<(String, String), Option<i64>>,
) -> Option<i64> {
    let key = (name.to_string(), file.to_string());
    if let Some(cached) = cache.get(&key) {
        return *cached;
    }

    // Local-first: same file
    let result = local_stmt
        .query_row(params![name, file], |row| row.get::<_, i64>(0))
        .ok();

    let id = if result.is_some() {
        result
    } else {
        // Global fallback
        global_stmt
            .query_row(params![name], |row| row.get::<_, i64>(0))
            .ok()
    };

    cache.insert(key, id);
    id
}

/// Bulk-insert dataflow edges into the database.
///
/// For each file batch, resolves function names to node IDs (local-first,
/// then global) and inserts edges in a single transaction.
///
/// Returns the total number of edges inserted. Returns 0 on any error.
#[napi]
pub fn bulk_insert_dataflow(db_path: String, batches: Vec<FileDataflowBatch>) -> u32 {
    if batches.is_empty() {
        return 0;
    }

    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut conn = match Connection::open_with_flags(&db_path, flags) {
        Ok(c) => c,
        Err(_) => return 0,
    };

    let _ = conn.execute_batch(
        "PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000",
    );

    // Bail out if the dataflow table doesn't exist
    let has_table: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dataflow'")
        .and_then(|mut s| s.query_row([], |_| Ok(true)))
        .unwrap_or(false);
    if !has_table {
        return 0;
    }

    // ── Phase 1: Pre-build node resolution cache ─────────────────────────
    // Collect all unique (name, file) pairs we need to resolve
    let mut resolve_cache: HashMap<(String, String), Option<i64>> = HashMap::new();
    {
        let Ok(mut local_stmt) = conn.prepare(
            "SELECT id FROM nodes WHERE name = ?1 AND file = ?2 AND kind IN ('function','method') LIMIT 1",
        ) else {
            return 0;
        };
        let Ok(mut global_stmt) = conn.prepare(
            "SELECT id FROM nodes WHERE name = ?1 AND kind IN ('function','method') ORDER BY file, line LIMIT 1",
        ) else {
            return 0;
        };

        for batch in &batches {
            for edge in &batch.edges {
                resolve_node(
                    &mut local_stmt,
                    &mut global_stmt,
                    &edge.source_name,
                    &batch.file,
                    &mut resolve_cache,
                );
                resolve_node(
                    &mut local_stmt,
                    &mut global_stmt,
                    &edge.target_name,
                    &batch.file,
                    &mut resolve_cache,
                );
            }
        }
    }

    // ── Phase 2: Bulk insert in a single transaction ─────────────────────
    let Ok(tx) = conn.transaction() else {
        return 0;
    };

    let mut total = 0u32;
    {
        let Ok(mut insert_stmt) = tx.prepare(
            "INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        ) else {
            return 0;
        };

        for batch in &batches {
            for edge in &batch.edges {
                let source_key = (edge.source_name.clone(), batch.file.clone());
                let target_key = (edge.target_name.clone(), batch.file.clone());

                let Some(&Some(source_id)) = resolve_cache.get(&source_key) else {
                    continue;
                };
                let Some(&Some(target_id)) = resolve_cache.get(&target_key) else {
                    continue;
                };

                match insert_stmt.execute(params![
                    source_id,
                    target_id,
                    &edge.kind,
                    edge.param_index,
                    &edge.expression,
                    edge.line,
                    edge.confidence,
                ]) {
                    Ok(_) => total += 1,
                    Err(_) => return 0,
                }
            }
        }
    }

    if tx.commit().is_err() {
        return 0;
    }

    total
}
