//! Bulk node insertion via rusqlite — native replacement for the JS insert-nodes stage.
//!
//! Moves the entire insert-nodes loop to Rust: receives `InsertNodesBatch[]` from JS
//! and writes nodes, children, containment/parameter_of edges, exports, and file hashes
//! directly to SQLite without crossing back to JS.

use std::collections::HashMap;

use napi_derive::napi;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

// ── Input types (received from JS via napi) ─────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertNodesChild {
    pub name: String,
    pub kind: String,
    pub line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    pub visibility: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertNodesDefinition {
    pub name: String,
    pub kind: String,
    pub line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    pub visibility: Option<String>,
    pub children: Vec<InsertNodesChild>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertNodesExport {
    pub name: String,
    pub kind: String,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertNodesBatch {
    pub file: String,
    pub definitions: Vec<InsertNodesDefinition>,
    pub exports: Vec<InsertNodesExport>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHashEntry {
    pub file: String,
    pub hash: String,
    /// `Math.floor(stat.mtimeMs)` from JS — f64 because JS `number`.
    pub mtime: f64,
    pub size: f64,
}

// ── Public napi entry point ─────────────────────────────────────────

// NOTE: The standalone `bulk_insert_nodes` napi export was removed in Phase 6.17.
// Callers use `NativeDatabase::bulk_insert_nodes()` — either through the
// persistent pipeline connection or a temporary connection opened by the
// insert-nodes stage with its own WAL checkpoint coordination (#709).

// ── Internal implementation ─────────────────────────────────────────

fn query_node_ids(
    stmt: &mut rusqlite::CachedStatement,
    file: &str,
) -> rusqlite::Result<HashMap<String, i64>> {
    let mut map = HashMap::new();
    let rows = stmt.query_map(params![file], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, u32>(3)?,
        ))
    })?;
    for row in rows {
        let (id, name, kind, line) = row?;
        map.insert(format!("{name}|{kind}|{line}"), id);
    }
    Ok(map)
}

pub(crate) fn do_insert_nodes(
    conn: &Connection,
    batches: &[InsertNodesBatch],
    file_hashes: &[FileHashEntry],
    removed_files: &[String],
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;

    // ── Phase 1: Insert file nodes + definitions + export nodes ──────
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO nodes \
             (name, kind, file, line, end_line, parent_id, qualified_name, scope, visibility) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;

        for batch in batches {
            // File node
            stmt.execute(params![
                &batch.file,
                "file",
                &batch.file,
                0,
                None::<u32>,
                None::<i64>,
                None::<&str>,
                None::<&str>,
                None::<&str>
            ])?;

            // Definitions
            for def in &batch.definitions {
                let scope: Option<&str> = def.name.rfind('.').map(|i| &def.name[..i]);
                // .as_deref() converts Option<String> → Option<&str> so rusqlite
                // serialises None as SQL NULL unambiguously (#709).
                let vis = def.visibility.as_deref();
                stmt.execute(params![
                    &def.name,
                    &def.kind,
                    &batch.file,
                    def.line,
                    def.end_line,
                    None::<i64>,
                    &def.name,
                    scope,
                    vis
                ])?;
            }

            // Exports (may duplicate definitions — OR IGNORE handles it)
            for exp in &batch.exports {
                stmt.execute(params![
                    &exp.name,
                    &exp.kind,
                    &batch.file,
                    exp.line,
                    None::<u32>,
                    None::<i64>,
                    &exp.name,
                    None::<&str>,
                    None::<&str>
                ])?;
            }
        }
    }

    // ── Phase 1b: Mark exported nodes ────────────────────────────────
    {
        let mut stmt = tx.prepare_cached(
            "UPDATE nodes SET exported = 1 \
             WHERE name = ?1 AND kind = ?2 AND file = ?3 AND line = ?4",
        )?;
        for batch in batches {
            for exp in &batch.exports {
                stmt.execute(params![&exp.name, &exp.kind, &batch.file, exp.line])?;
            }
        }
    }

    // ── Phase 2: Query node IDs, insert children, collect file→def edges
    let mut contains_edges: Vec<(i64, i64)> = Vec::new();
    let mut param_of_edges: Vec<(i64, i64)> = Vec::new();

    {
        let mut id_stmt =
            tx.prepare_cached("SELECT id, name, kind, line FROM nodes WHERE file = ?1")?;
        let mut child_stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO nodes \
             (name, kind, file, line, end_line, parent_id, qualified_name, scope, visibility) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;

        for batch in batches {
            let node_ids = query_node_ids(&mut id_stmt, &batch.file)?;
            let file_id = node_ids.get(&format!("{}|file|0", &batch.file)).copied();

            for def in &batch.definitions {
                let def_key = format!("{}|{}|{}", def.name, def.kind, def.line);
                let def_id = node_ids.get(&def_key).copied();

                // file → definition containment edge
                if let (Some(fid), Some(did)) = (file_id, def_id) {
                    contains_edges.push((fid, did));
                }

                let def_id = match def_id {
                    Some(id) if !def.children.is_empty() => id,
                    _ => continue,
                };

                for child in &def.children {
                    let qname = format!("{}.{}", def.name, child.name);
                    let child_vis = child.visibility.as_deref();
                    child_stmt.execute(params![
                        &child.name,
                        &child.kind,
                        &batch.file,
                        child.line,
                        child.end_line,
                        def_id,
                        &qname,
                        &def.name,
                        child_vis
                    ])?;
                }
            }
        }
    }

    // ── Phase 3: Re-fetch IDs (including children), add def→child edges
    {
        let mut id_stmt =
            tx.prepare_cached("SELECT id, name, kind, line FROM nodes WHERE file = ?1")?;

        for batch in batches {
            let node_ids = query_node_ids(&mut id_stmt, &batch.file)?;

            for def in &batch.definitions {
                if def.children.is_empty() {
                    continue;
                }
                let def_key = format!("{}|{}|{}", def.name, def.kind, def.line);
                let def_id = match node_ids.get(&def_key) {
                    Some(&id) => id,
                    None => continue,
                };

                for child in &def.children {
                    let child_key = format!("{}|{}|{}", child.name, child.kind, child.line);
                    if let Some(&child_id) = node_ids.get(&child_key) {
                        contains_edges.push((def_id, child_id));
                        if child.kind == "parameter" {
                            param_of_edges.push((child_id, def_id));
                        }
                    }
                }
            }
        }
    }

    // ── Insert all edges ─────────────────────────────────────────────
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for &(src, tgt) in &contains_edges {
            stmt.execute(params![src, tgt, "contains", 1.0, 0])?;
        }
        for &(src, tgt) in &param_of_edges {
            stmt.execute(params![src, tgt, "parameter_of", 1.0, 0])?;
        }
    }

    // ── Phase 4: File hashes ─────────────────────────────────────────
    let has_file_hashes = tx
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_hashes'")
        .and_then(|mut s| s.query_row([], |_| Ok(true)))
        .unwrap_or(false);

    if has_file_hashes {
        {
            let mut upsert = tx.prepare_cached(
                "INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) \
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for entry in file_hashes {
                upsert.execute(params![
                    &entry.file,
                    &entry.hash,
                    entry.mtime as i64,
                    entry.size as i64
                ])?;
            }
        }

        if !removed_files.is_empty() {
            let mut delete =
                tx.prepare_cached("DELETE FROM file_hashes WHERE file = ?1")?;
            for file in removed_files {
                delete.execute(params![file])?;
            }
        }
    }

    tx.commit()
}
