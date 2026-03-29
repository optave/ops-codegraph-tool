//! Bulk AST node insertion via rusqlite.
//!
//! Bypasses the JS iteration loop by opening the SQLite database directly
//! from Rust and inserting all AST nodes in a single transaction.
//! Parent node IDs are resolved by querying the `nodes` table.

use std::collections::HashMap;

use napi_derive::napi;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

/// A single AST node to insert (received from JS).
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstInsertNode {
    pub line: u32,
    pub kind: String,
    pub name: String,
    pub text: Option<String>,
    pub receiver: Option<String>,
}

/// A batch of AST nodes for a single file.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAstBatch {
    pub file: String,
    pub nodes: Vec<AstInsertNode>,
}

/// A definition row from the `nodes` table used for parent resolution.
struct NodeDef {
    id: i64,
    line: u32,
    end_line: Option<u32>,
}

/// Find the narrowest enclosing definition for a given source line.
/// Returns the node ID of the best match, or None if no definition encloses this line.
///
/// Mirrors the JS `findParentDef` semantics: a definition with `end_line = NULL`
/// is treated as always enclosing, with a negative sentinel span so it is preferred
/// over definitions that have an explicit (wider) `end_line`.
fn find_parent_id(defs: &[NodeDef], line: u32) -> Option<i64> {
    let mut best_id: Option<i64> = None;
    let mut best_span: i64 = i64::MAX;
    for d in defs {
        if d.line <= line {
            let span: i64 = match d.end_line {
                Some(el) if el >= line => (el - d.line) as i64,
                Some(_) => continue,
                // JS: (def.endLine ?? 0) - def.line → negative, always preferred
                None => -(d.line as i64),
            };
            if span < best_span {
                best_id = Some(d.id);
                best_span = span;
            }
        }
    }
    best_id
}

/// Bulk-insert AST nodes into the database, resolving `parent_node_id`
/// from the `nodes` table. Runs all inserts in a single SQLite transaction.
///
/// Returns the number of rows inserted. Returns 0 on any error (DB open
/// failure, missing table, transaction failure).
#[napi]
pub fn bulk_insert_ast_nodes(db_path: String, batches: Vec<FileAstBatch>) -> u32 {
    if batches.is_empty() {
        return 0;
    }

    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match Connection::open_with_flags(&db_path, flags) {
        Ok(c) => c,
        Err(_) => return 0,
    };

    // Match the JS-side performance pragmas (including busy_timeout for WAL contention)
    let _ = conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");

    do_insert_ast_nodes(&conn, &batches).unwrap_or(0)
}

/// Internal implementation: insert AST nodes using an existing connection.
/// Used by both the standalone `bulk_insert_ast_nodes` function and `NativeDatabase`.
pub(crate) fn do_insert_ast_nodes(
    conn: &Connection,
    batches: &[FileAstBatch],
) -> rusqlite::Result<u32> {
    if batches.is_empty() {
        return Ok(0);
    }

    // Bail out if the ast_nodes table doesn't exist (schema too old)
    let has_table: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ast_nodes'")
        .and_then(|mut s| s.query_row([], |_| Ok(true)))
        .unwrap_or(false);
    if !has_table {
        return Ok(0);
    }

    // ── Phase 1: Pre-fetch node definitions for parent resolution ────────
    let mut file_defs: HashMap<String, Vec<NodeDef>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, line, end_line FROM nodes WHERE file = ?1")?;

        for batch in batches {
            if batch.nodes.is_empty() || file_defs.contains_key(&batch.file) {
                continue;
            }
            let defs: Vec<NodeDef> = stmt
                .query_map(params![&batch.file], |row| {
                    Ok(NodeDef {
                        id: row.get(0)?,
                        line: row.get(1)?,
                        end_line: row.get(2)?,
                    })
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();
            file_defs.insert(batch.file.clone(), defs);
        }
    }

    // ── Phase 2: Bulk insert in a single transaction ─────────────────────
    let tx = conn.unchecked_transaction()?;

    let mut total = 0u32;
    {
        let mut insert_stmt = tx.prepare(
            "INSERT INTO ast_nodes (file, line, kind, name, text, receiver, parent_node_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;

        for batch in batches {
            let empty = Vec::new();
            let defs = file_defs.get(&batch.file).unwrap_or(&empty);

            for node in &batch.nodes {
                let parent_id = find_parent_id(defs, node.line);

                insert_stmt.execute(params![
                    &batch.file,
                    node.line,
                    &node.kind,
                    &node.name,
                    &node.text,
                    &node.receiver,
                    parent_id,
                ])?;
                total += 1;
            }
        }
    }

    tx.commit()?;
    Ok(total)
}
