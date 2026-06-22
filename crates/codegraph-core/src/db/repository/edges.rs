//! Bulk edge insertion via rusqlite — native replacement for the JS
//! `batchInsertEdges` helper.
//!
//! Used by the build-edges stage to write computed call/receiver/extends/
//! implements edges directly to SQLite without marshaling back to JS.

use napi_derive::napi;
use rusqlite::Connection;

/// A single edge row to insert: [source_id, target_id, kind, confidence, dynamic, dynamic_kind].
#[napi(object)]
#[derive(Debug, Clone)]
pub struct EdgeRow {
    #[napi(js_name = "sourceId")]
    pub source_id: u32,
    #[napi(js_name = "targetId")]
    pub target_id: u32,
    pub kind: String,
    pub confidence: f64,
    pub dynamic: u32,
    /// Set only for sink edges (confidence=0, dynamic=1) emitted by FLAG_ONLY_KINDS.
    /// NULL for all normal resolved call/receiver/hierarchy edges.
    #[napi(js_name = "dynamicKind")]
    pub dynamic_kind: Option<String>,
}

// NOTE: The standalone `bulk_insert_edges` napi export was removed in Phase 6.17.
// All callers now use `NativeDatabase::bulk_insert_edges()` which reuses the
// persistent connection, eliminating the double-connection antipattern.

/// 165 rows × 6 params = 990 bind parameters per statement, safely under
/// the legacy `SQLITE_LIMIT_VARIABLE_NUMBER` default of 999.
const CHUNK: usize = 165;

pub(crate) fn do_insert_edges(conn: &Connection, edges: &[EdgeRow]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;

    for chunk in edges.chunks(CHUNK) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let base = i * 6;
                format!(
                    "(?{},?{},?{},?{},?{},?{})",
                    base + 1,
                    base + 2,
                    base + 3,
                    base + 4,
                    base + 5,
                    base + 6
                )
            })
            .collect();
        let sql = format!(
            "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic, dynamic_kind) VALUES {}",
            placeholders.join(",")
        );
        let mut stmt = tx.prepare_cached(&sql)?;
        for (i, edge) in chunk.iter().enumerate() {
            let base = i * 6;
            stmt.raw_bind_parameter(base + 1, edge.source_id)?;
            stmt.raw_bind_parameter(base + 2, edge.target_id)?;
            stmt.raw_bind_parameter(base + 3, edge.kind.as_str())?;
            stmt.raw_bind_parameter(base + 4, edge.confidence)?;
            stmt.raw_bind_parameter(base + 5, edge.dynamic)?;
            stmt.raw_bind_parameter(base + 6, edge.dynamic_kind.as_deref())?;
        }
        stmt.raw_execute()?;
    }

    tx.commit()
}
