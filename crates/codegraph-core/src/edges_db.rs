//! Bulk edge insertion via rusqlite — native replacement for the JS
//! `batchInsertEdges` helper.
//!
//! Used by the build-edges stage to write computed call/receiver/extends/
//! implements edges directly to SQLite without marshaling back to JS.

use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};

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

/// Bulk-insert edge rows into the database via rusqlite.
/// Runs all writes in a single SQLite transaction with chunked multi-value
/// INSERT statements for maximum throughput.
///
/// Returns `true` on success, `false` on any error so the JS caller can
/// fall back to the JS batch insert path.
#[napi]
pub fn bulk_insert_edges(db_path: String, edges: Vec<EdgeRow>) -> bool {
    if edges.is_empty() {
        return true;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut conn = match Connection::open_with_flags(&db_path, flags) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let _ = conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
    do_insert(&mut conn, &edges).is_ok()
}

const CHUNK: usize = 200;

fn do_insert(conn: &mut Connection, edges: &[EdgeRow]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;

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
