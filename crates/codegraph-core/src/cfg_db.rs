//! Bulk CFG block and edge insertion via rusqlite.
//!
//! Bypasses the JS iteration loop by opening the SQLite database directly
//! from Rust and inserting all CFG blocks and edges in a single transaction.
//! Function node IDs are resolved by querying the `nodes` table.

use std::collections::HashMap;

use napi_derive::napi;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

/// A single CFG block to insert (received from JS).
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CfgInsertBlock {
    pub index: u32,
    #[napi(js_name = "type")]
    pub block_type: String,
    #[napi(js_name = "startLine")]
    pub start_line: Option<u32>,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    pub label: Option<String>,
}

/// A single CFG edge to insert (received from JS).
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CfgInsertEdge {
    #[napi(js_name = "sourceIndex")]
    pub source_index: u32,
    #[napi(js_name = "targetIndex")]
    pub target_index: u32,
    pub kind: String,
}

/// CFG data for a single function definition.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CfgFunctionBatch {
    /// Definition name (used to look up node ID)
    pub name: String,
    /// Relative file path
    pub file: String,
    /// Definition source line
    pub line: u32,
    pub blocks: Vec<CfgInsertBlock>,
    pub edges: Vec<CfgInsertEdge>,
}

/// Bulk-insert CFG blocks and edges into the database.
///
/// For each function batch:
///   1. Resolve the function's node ID from the `nodes` table
///   2. Delete any existing CFG data for that node (handles incremental rebuilds)
///   3. Insert all blocks, collecting their auto-generated row IDs
///   4. Insert all edges, mapping block indices to row IDs
///
/// Returns the total number of functions processed. Returns 0 on any error.
#[napi]
pub fn bulk_insert_cfg(db_path: String, batches: Vec<CfgFunctionBatch>) -> u32 {
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

    // Bail out if CFG tables don't exist
    let has_tables: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cfg_blocks'")
        .and_then(|mut s| s.query_row([], |_| Ok(true)))
        .unwrap_or(false);
    if !has_tables {
        return 0;
    }

    // ── Phase 1: Pre-fetch function node IDs ─────────────────────────────
    let mut node_ids: HashMap<(String, String, u32), i64> = HashMap::new();
    {
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM nodes WHERE name = ?1 AND kind IN ('function','method') AND file = ?2 AND line = ?3",
        ) else {
            return 0;
        };

        for batch in &batches {
            let key = (batch.name.clone(), batch.file.clone(), batch.line);
            if node_ids.contains_key(&key) {
                continue;
            }
            if let Ok(id) = stmt.query_row(params![&batch.name, &batch.file, batch.line], |row| {
                row.get::<_, i64>(0)
            }) {
                node_ids.insert(key, id);
            }
        }
    }

    // ── Phase 2: Bulk insert in a single transaction ─────────────────────
    let Ok(tx) = conn.transaction() else {
        return 0;
    };

    let mut total = 0u32;
    {
        let Ok(mut delete_edges) =
            tx.prepare("DELETE FROM cfg_edges WHERE function_node_id = ?1")
        else {
            return 0;
        };
        let Ok(mut delete_blocks) =
            tx.prepare("DELETE FROM cfg_blocks WHERE function_node_id = ?1")
        else {
            return 0;
        };
        let Ok(mut insert_block) = tx.prepare(
            "INSERT INTO cfg_blocks (function_node_id, block_index, block_type, start_line, end_line, label) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        ) else {
            return 0;
        };
        let Ok(mut insert_edge) = tx.prepare(
            "INSERT INTO cfg_edges (function_node_id, source_block_id, target_block_id, kind) \
             VALUES (?1, ?2, ?3, ?4)",
        ) else {
            return 0;
        };

        for batch in &batches {
            let key = (batch.name.clone(), batch.file.clone(), batch.line);
            let Some(&node_id) = node_ids.get(&key) else {
                continue;
            };

            // Always delete stale CFG rows (handles body-removed / incremental case)
            if delete_edges.execute(params![node_id]).is_err() {
                return 0;
            }
            if delete_blocks.execute(params![node_id]).is_err() {
                return 0;
            }

            if batch.blocks.is_empty() {
                total += 1;
                continue;
            }

            // Insert blocks and collect their auto-generated row IDs
            let mut block_db_ids: HashMap<u32, i64> = HashMap::new();
            for block in &batch.blocks {
                match insert_block.execute(params![
                    node_id,
                    block.index,
                    &block.block_type,
                    block.start_line,
                    block.end_line,
                    &block.label,
                ]) {
                    Ok(_) => {
                        block_db_ids.insert(block.index, tx.last_insert_rowid());
                    }
                    Err(_) => return 0,
                }
            }

            // Insert edges, mapping block indices to row IDs
            for edge in &batch.edges {
                let Some(&source_db_id) = block_db_ids.get(&edge.source_index) else {
                    continue;
                };
                let Some(&target_db_id) = block_db_ids.get(&edge.target_index) else {
                    continue;
                };
                match insert_edge.execute(params![node_id, source_db_id, target_db_id, &edge.kind])
                {
                    Ok(_) => {}
                    Err(_) => return 0,
                }
            }

            total += 1;
        }
    }

    if tx.commit().is_err() {
        return 0;
    }

    total
}
