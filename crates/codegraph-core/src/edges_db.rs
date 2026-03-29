//! Bulk edge insertion via rusqlite — native replacement for the JS
//! `batchInsertEdges` helper.
//!
//! Used by the build-edges stage to write computed call/receiver/extends/
//! implements edges directly to SQLite without marshaling back to JS.

use napi_derive::napi;
use rusqlite::Connection;

/// A single edge row to insert: [source_id, target_id, kind, confidence, dynamic].
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
}

// NOTE: The standalone `bulk_insert_edges` napi export was removed in Phase 6.17.
// All callers now use `NativeDatabase::bulk_insert_edges()` which reuses the
// persistent connection, eliminating the double-connection antipattern.

/// 199 rows × 5 params = 995 bind parameters per statement, safely under
/// the legacy `SQLITE_MAX_VARIABLE_NUMBER` default of 999.
const CHUNK: usize = 199;

pub(crate) fn do_insert_edges(conn: &Connection, edges: &[EdgeRow]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;

    for chunk in edges.chunks(CHUNK) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let base = i * 5;
                format!(
                    "(?{},?{},?{},?{},?{})",
                    base + 1,
                    base + 2,
                    base + 3,
                    base + 4,
                    base + 5
                )
            })
            .collect();
        let sql = format!(
            "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES {}",
            placeholders.join(",")
        );
        let mut stmt = tx.prepare_cached(&sql)?;
        for (i, edge) in chunk.iter().enumerate() {
            let base = i * 5;
            stmt.raw_bind_parameter(base +1, edge.source_id)?;
            stmt.raw_bind_parameter(base +2, edge.target_id)?;
            stmt.raw_bind_parameter(base +3, edge.kind.as_str())?;
            stmt.raw_bind_parameter(base +4, edge.confidence)?;
            stmt.raw_bind_parameter(base +5, edge.dynamic)?;
        }
        stmt.raw_execute()?;
    }

    tx.commit()
}
