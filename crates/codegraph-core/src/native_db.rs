//! NativeDatabase — persistent rusqlite Connection exposed as a napi-rs class.
//!
//! Phase 6.13: foundation for moving all DB operations to rusqlite on the native
//! engine path. Handles lifecycle (open/close), schema migrations, and build
//! metadata KV operations.
//!
//! IMPORTANT: Migration DDL is mirrored from src/db/migrations.ts.
//! Any changes there MUST be reflected here (and vice-versa).

use napi_derive::napi;
use rusqlite::{params, Connection, OpenFlags};
use send_wrapper::SendWrapper;

use crate::ast_db::{self, FileAstBatch};
use crate::edges_db::{self, EdgeRow};
use crate::insert_nodes::{self, FileHashEntry, InsertNodesBatch};
use crate::roles_db::{self, RoleSummary};

// ── Migration DDL (mirrored from src/db/migrations.ts) ──────────────────

struct Migration {
    version: u32,
    up: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        up: r#"
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER,
        end_line INTEGER,
        UNIQUE(name, kind, file, line)
      );
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        dynamic INTEGER DEFAULT 0,
        FOREIGN KEY(source_id) REFERENCES nodes(id),
        FOREIGN KEY(target_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
      CREATE TABLE IF NOT EXISTS node_metrics (
        node_id INTEGER PRIMARY KEY,
        line_count INTEGER,
        symbol_count INTEGER,
        import_count INTEGER,
        export_count INTEGER,
        fan_in INTEGER,
        fan_out INTEGER,
        cohesion REAL,
        file_count INTEGER,
        FOREIGN KEY(node_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_node_metrics_node ON node_metrics(node_id);
    "#,
    },
    Migration {
        version: 2,
        up: r#"
      CREATE INDEX IF NOT EXISTS idx_nodes_name_kind_file ON nodes(name, kind, file);
      CREATE INDEX IF NOT EXISTS idx_nodes_file_kind ON nodes(file, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source_id, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target_id, kind);
    "#,
    },
    Migration {
        version: 3,
        up: r#"
      CREATE TABLE IF NOT EXISTS file_hashes (
        file TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL
      );
    "#,
    },
    Migration {
        version: 4,
        up: "ALTER TABLE file_hashes ADD COLUMN size INTEGER DEFAULT 0;",
    },
    Migration {
        version: 5,
        up: r#"
      CREATE TABLE IF NOT EXISTS co_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        commit_count INTEGER NOT NULL,
        jaccard REAL NOT NULL,
        last_commit_epoch INTEGER,
        UNIQUE(file_a, file_b)
      );
      CREATE INDEX IF NOT EXISTS idx_co_changes_file_a ON co_changes(file_a);
      CREATE INDEX IF NOT EXISTS idx_co_changes_file_b ON co_changes(file_b);
      CREATE INDEX IF NOT EXISTS idx_co_changes_jaccard ON co_changes(jaccard DESC);
      CREATE TABLE IF NOT EXISTS co_change_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    "#,
    },
    Migration {
        version: 6,
        up: r#"
      CREATE TABLE IF NOT EXISTS file_commit_counts (
        file TEXT PRIMARY KEY,
        commit_count INTEGER NOT NULL DEFAULT 0
      );
    "#,
    },
    Migration {
        version: 7,
        up: r#"
      CREATE TABLE IF NOT EXISTS build_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    "#,
    },
    Migration {
        version: 8,
        up: r#"
      CREATE TABLE IF NOT EXISTS function_complexity (
        node_id INTEGER PRIMARY KEY,
        cognitive INTEGER NOT NULL,
        cyclomatic INTEGER NOT NULL,
        max_nesting INTEGER NOT NULL,
        FOREIGN KEY(node_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_fc_cognitive ON function_complexity(cognitive DESC);
      CREATE INDEX IF NOT EXISTS idx_fc_cyclomatic ON function_complexity(cyclomatic DESC);
    "#,
    },
    Migration {
        version: 9,
        up: r#"
      ALTER TABLE function_complexity ADD COLUMN loc INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN sloc INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN comment_lines INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_n1 INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_n2 INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_big_n1 INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_big_n2 INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_vocabulary INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_length INTEGER DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_volume REAL DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_difficulty REAL DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_effort REAL DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN halstead_bugs REAL DEFAULT 0;
      ALTER TABLE function_complexity ADD COLUMN maintainability_index REAL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_fc_mi ON function_complexity(maintainability_index ASC);
    "#,
    },
    Migration {
        version: 10,
        up: r#"
      CREATE TABLE IF NOT EXISTS dataflow (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        param_index INTEGER,
        expression TEXT,
        line INTEGER,
        confidence REAL DEFAULT 1.0,
        FOREIGN KEY(source_id) REFERENCES nodes(id),
        FOREIGN KEY(target_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_dataflow_source ON dataflow(source_id);
      CREATE INDEX IF NOT EXISTS idx_dataflow_target ON dataflow(target_id);
      CREATE INDEX IF NOT EXISTS idx_dataflow_kind ON dataflow(kind);
      CREATE INDEX IF NOT EXISTS idx_dataflow_source_kind ON dataflow(source_id, kind);
    "#,
    },
    Migration {
        version: 11,
        up: r#"
      ALTER TABLE nodes ADD COLUMN parent_id INTEGER REFERENCES nodes(id);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind_parent ON nodes(kind, parent_id);
    "#,
    },
    Migration {
        version: 12,
        up: r#"
      CREATE TABLE IF NOT EXISTS cfg_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        function_node_id INTEGER NOT NULL,
        block_index INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        label TEXT,
        FOREIGN KEY(function_node_id) REFERENCES nodes(id),
        UNIQUE(function_node_id, block_index)
      );
      CREATE INDEX IF NOT EXISTS idx_cfg_blocks_fn ON cfg_blocks(function_node_id);

      CREATE TABLE IF NOT EXISTS cfg_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        function_node_id INTEGER NOT NULL,
        source_block_id INTEGER NOT NULL,
        target_block_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        FOREIGN KEY(function_node_id) REFERENCES nodes(id),
        FOREIGN KEY(source_block_id) REFERENCES cfg_blocks(id),
        FOREIGN KEY(target_block_id) REFERENCES cfg_blocks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_cfg_edges_fn ON cfg_edges(function_node_id);
      CREATE INDEX IF NOT EXISTS idx_cfg_edges_src ON cfg_edges(source_block_id);
      CREATE INDEX IF NOT EXISTS idx_cfg_edges_tgt ON cfg_edges(target_block_id);
    "#,
    },
    Migration {
        version: 13,
        up: r#"
      CREATE TABLE IF NOT EXISTS ast_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT,
        receiver TEXT,
        parent_node_id INTEGER,
        FOREIGN KEY(parent_node_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ast_kind ON ast_nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_ast_name ON ast_nodes(name);
      CREATE INDEX IF NOT EXISTS idx_ast_file ON ast_nodes(file);
      CREATE INDEX IF NOT EXISTS idx_ast_parent ON ast_nodes(parent_node_id);
      CREATE INDEX IF NOT EXISTS idx_ast_kind_name ON ast_nodes(kind, name);
    "#,
    },
    Migration {
        version: 14,
        up: r#"
      ALTER TABLE nodes ADD COLUMN exported INTEGER DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_nodes_exported ON nodes(exported);
    "#,
    },
    Migration {
        version: 15,
        up: r#"
      ALTER TABLE nodes ADD COLUMN qualified_name TEXT;
      ALTER TABLE nodes ADD COLUMN scope TEXT;
      ALTER TABLE nodes ADD COLUMN visibility TEXT;
      UPDATE nodes SET qualified_name = name WHERE qualified_name IS NULL;
      CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
      CREATE INDEX IF NOT EXISTS idx_nodes_scope ON nodes(scope);
    "#,
    },
    Migration {
        version: 16,
        up: r#"
      CREATE INDEX IF NOT EXISTS idx_edges_kind_target ON edges(kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_kind_source ON edges(kind, source_id);
    "#,
    },
];

// ── napi types ──────────────────────────────────────────────────────────

/// A key-value entry for build metadata.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct BuildMetaEntry {
    pub key: String,
    pub value: String,
}

// ── NativeDatabase class ────────────────────────────────────────────────

/// Persistent rusqlite Connection wrapper exposed to JS via napi-rs.
///
/// Holds a single `rusqlite::Connection` for the lifetime of a build pipeline.
/// Replaces `better-sqlite3` for schema initialization and build metadata on
/// the native engine path.
#[napi]
pub struct NativeDatabase {
    conn: SendWrapper<Option<Connection>>,
    db_path: String,
}

#[napi]
impl NativeDatabase {
    /// Open a read-write connection to the database at `db_path`.
    /// Creates the file and parent directories if they don't exist.
    #[napi(factory)]
    pub fn open_read_write(db_path: String) -> napi::Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&db_path, flags)
            .map_err(|e| napi::Error::from_reason(format!("Failed to open DB: {e}")))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| napi::Error::from_reason(format!("Failed to set pragmas: {e}")))?;
        Ok(Self {
            conn: SendWrapper::new(Some(conn)),
            db_path,
        })
    }

    /// Open a read-only connection to the database at `db_path`.
    #[napi(factory)]
    pub fn open_readonly(db_path: String) -> napi::Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&db_path, flags)
            .map_err(|e| napi::Error::from_reason(format!("Failed to open DB readonly: {e}")))?;
        conn.execute_batch("PRAGMA busy_timeout = 5000;")
            .map_err(|e| napi::Error::from_reason(format!("Failed to set pragmas: {e}")))?;
        Ok(Self {
            conn: SendWrapper::new(Some(conn)),
            db_path,
        })
    }

    /// Close the database connection. Idempotent — safe to call multiple times.
    #[napi]
    pub fn close(&mut self) {
        self.conn.take();
    }

    /// The path this database was opened with.
    #[napi(getter)]
    pub fn db_path(&self) -> String {
        self.db_path.clone()
    }

    /// Whether the connection is still open.
    #[napi(getter)]
    pub fn is_open(&self) -> bool {
        self.conn.is_some()
    }

    /// Execute one or more SQL statements (no result returned).
    #[napi]
    pub fn exec(&self, sql: String) -> napi::Result<()> {
        let conn = self.conn()?;
        conn.execute_batch(&sql)
            .map_err(|e| napi::Error::from_reason(format!("exec failed: {e}")))
    }

    /// Execute a PRAGMA statement and return the first result as a string.
    /// Returns `null` if the pragma produces no output.
    #[napi]
    pub fn pragma(&self, sql: String) -> napi::Result<Option<String>> {
        let conn = self.conn()?;
        let query = format!("PRAGMA {sql}");
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| napi::Error::from_reason(format!("pragma prepare failed: {e}")))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| napi::Error::from_reason(format!("pragma query failed: {e}")))?;
        match rows.next() {
            Ok(Some(row)) => {
                let val: String = row
                    .get(0)
                    .map_err(|e| napi::Error::from_reason(format!("pragma get failed: {e}")))?;
                Ok(Some(val))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!("pragma next failed: {e}"))),
        }
    }

    /// Run all schema migrations. Mirrors `initSchema()` from `src/db/migrations.ts`.
    #[napi]
    pub fn init_schema(&self) -> napi::Result<()> {
        let conn = self.conn()?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)",
        )
        .map_err(|e| napi::Error::from_reason(format!("create schema_version failed: {e}")))?;

        let mut current_version: u32 = conn
            .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
            .unwrap_or(0);

        // Insert version 0 if table was just created (empty)
        let count: u32 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
            .unwrap_or(0);
        if count == 0 {
            conn.execute("INSERT INTO schema_version (version) VALUES (0)", [])
                .map_err(|e| {
                    napi::Error::from_reason(format!("insert schema_version failed: {e}"))
                })?;
        }

        for migration in MIGRATIONS {
            if migration.version > current_version {
                conn.execute_batch(migration.up).map_err(|e| {
                    napi::Error::from_reason(format!(
                        "migration v{} failed: {e}",
                        migration.version
                    ))
                })?;
                conn.execute(
                    "UPDATE schema_version SET version = ?1",
                    params![migration.version],
                )
                .map_err(|e| {
                    napi::Error::from_reason(format!("update schema_version failed: {e}"))
                })?;
                current_version = migration.version;
            }
        }

        // Legacy column compat — add columns that may be missing from pre-migration DBs.
        // Mirrors the post-migration block in src/db/migrations.ts initSchema().
        if has_table(conn, "nodes") {
            if !has_column(conn, "nodes", "end_line") {
                let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN end_line INTEGER");
            }
            if !has_column(conn, "nodes", "role") {
                let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN role TEXT");
            }
            let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role)");
            if !has_column(conn, "nodes", "parent_id") {
                let _ = conn.execute_batch(
                    "ALTER TABLE nodes ADD COLUMN parent_id INTEGER REFERENCES nodes(id)",
                );
            }
            let _ = conn
                .execute_batch("CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)");
            let _ = conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_nodes_kind_parent ON nodes(kind, parent_id)",
            );
            if !has_column(conn, "nodes", "qualified_name") {
                let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN qualified_name TEXT");
            }
            if !has_column(conn, "nodes", "scope") {
                let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN scope TEXT");
            }
            if !has_column(conn, "nodes", "visibility") {
                let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN visibility TEXT");
            }
            let _ = conn.execute_batch(
                "UPDATE nodes SET qualified_name = name WHERE qualified_name IS NULL",
            );
            let _ = conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name)",
            );
            let _ =
                conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_nodes_scope ON nodes(scope)");
        }
        if has_table(conn, "edges") {
            if !has_column(conn, "edges", "confidence") {
                let _ =
                    conn.execute_batch("ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0");
            }
            if !has_column(conn, "edges", "dynamic") {
                let _ =
                    conn.execute_batch("ALTER TABLE edges ADD COLUMN dynamic INTEGER DEFAULT 0");
            }
        }

        Ok(())
    }

    /// Retrieve a single build metadata value by key. Returns `null` if missing.
    #[napi]
    pub fn get_build_meta(&self, key: String) -> napi::Result<Option<String>> {
        let conn = self.conn()?;

        if !has_table(conn, "build_meta") {
            return Ok(None);
        }

        let result = conn.query_row(
            "SELECT value FROM build_meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!(
                "getBuildMeta failed for key \"{key}\": {e}"
            ))),
        }
    }

    /// Upsert multiple build metadata entries in a single transaction.
    #[napi]
    pub fn set_build_meta(&self, entries: Vec<BuildMetaEntry>) -> napi::Result<()> {
        let conn = self.conn()?;

        // Ensure build_meta table exists (may be called before full migration on edge cases)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS build_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
        .map_err(|e| napi::Error::from_reason(format!("ensure build_meta table failed: {e}")))?;

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| napi::Error::from_reason(format!("begin transaction failed: {e}")))?;
        {
            let mut stmt = tx
                .prepare_cached("INSERT OR REPLACE INTO build_meta (key, value) VALUES (?1, ?2)")
                .map_err(|e| {
                    napi::Error::from_reason(format!("prepare setBuildMeta failed: {e}"))
                })?;
            for entry in &entries {
                stmt.execute(params![entry.key, entry.value]).map_err(|e| {
                    napi::Error::from_reason(format!(
                        "setBuildMeta insert failed for \"{}\": {e}",
                        entry.key
                    ))
                })?;
            }
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("commit setBuildMeta failed: {e}")))?;
        Ok(())
    }

    // ── Phase 6.15: Build pipeline write operations ─────────────────────

    /// Bulk-insert nodes, children, containment edges, exports, and file hashes.
    /// Reuses the persistent connection instead of opening a new one.
    /// Returns `true` on success, `false` on failure.
    #[napi]
    pub fn bulk_insert_nodes(
        &self,
        batches: Vec<InsertNodesBatch>,
        file_hashes: Vec<FileHashEntry>,
        removed_files: Vec<String>,
    ) -> napi::Result<bool> {
        let conn = self.conn()?;
        Ok(insert_nodes::do_insert(conn, &batches, &file_hashes, &removed_files).is_ok())
    }

    /// Bulk-insert edge rows using chunked multi-value INSERT statements.
    /// Returns `true` on success, `false` on failure.
    #[napi]
    pub fn bulk_insert_edges(&self, edges: Vec<EdgeRow>) -> napi::Result<bool> {
        if edges.is_empty() {
            return Ok(true);
        }
        let conn = self.conn()?;
        Ok(edges_db::do_insert_edges(conn, &edges).is_ok())
    }

    /// Bulk-insert AST nodes, resolving parent_node_id from the nodes table.
    /// Returns the number of rows inserted (0 on failure).
    #[napi]
    pub fn bulk_insert_ast_nodes(&self, batches: Vec<FileAstBatch>) -> napi::Result<u32> {
        let conn = self.conn()?;
        Ok(ast_db::do_insert_ast_nodes(conn, &batches).unwrap_or(0))
    }

    /// Full role classification: queries all nodes, computes fan-in/fan-out,
    /// classifies roles, and batch-updates the `role` column.
    #[napi]
    pub fn classify_roles_full(&self) -> napi::Result<Option<RoleSummary>> {
        let conn = self.conn()?;
        Ok(roles_db::do_classify_full(conn).ok())
    }

    /// Incremental role classification: only reclassifies nodes from changed
    /// files plus their immediate edge neighbours.
    #[napi]
    pub fn classify_roles_incremental(
        &self,
        changed_files: Vec<String>,
    ) -> napi::Result<Option<RoleSummary>> {
        let conn = self.conn()?;
        Ok(roles_db::do_classify_incremental(conn, &changed_files).ok())
    }

    /// Cascade-delete all graph data for the specified files across all tables.
    /// Order: dependent tables first (embeddings, cfg, dataflow, complexity,
    /// metrics, ast_nodes), then edges, then nodes, then optionally file_hashes.
    #[napi]
    pub fn purge_files_data(
        &self,
        files: Vec<String>,
        purge_hashes: Option<bool>,
    ) -> napi::Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let conn = self.conn()?;
        let purge_hashes = purge_hashes.unwrap_or(true);

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| napi::Error::from_reason(format!("purge transaction failed: {e}")))?;

        // Purge each file across all tables. Optional tables are silently
        // skipped if they don't exist. Order: dependents → edges → nodes → hashes.
        let purge_sql: &[(&str, bool)] = &[
            ("DELETE FROM embeddings WHERE node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            ("DELETE FROM cfg_edges WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            ("DELETE FROM cfg_blocks WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            ("DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            ("DELETE FROM function_complexity WHERE node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            ("DELETE FROM node_metrics WHERE node_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            ("DELETE FROM ast_nodes WHERE file = ?1", false),
            // Core tables — errors propagated
            ("DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1)", true),
            ("DELETE FROM nodes WHERE file = ?1", true),
        ];

        for file in &files {
            for &(sql, required) in purge_sql {
                match tx.execute(sql, params![file]) {
                    Ok(_) => {}
                    Err(e) if required => {
                        return Err(napi::Error::from_reason(format!(
                            "purge failed for \"{file}\": {e}"
                        )));
                    }
                    Err(_) => {} // optional table missing — skip
                }
            }
            if purge_hashes {
                let _ = tx.execute("DELETE FROM file_hashes WHERE file = ?1", params![file]);
            }
        }

        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("purge commit failed: {e}")))?;
        Ok(())
    }
}

// ── Private helpers ─────────────────────────────────────────────────────

impl NativeDatabase {
    /// Get a reference to the open connection, or error if closed.
    fn conn(&self) -> napi::Result<&Connection> {
        self.conn
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("NativeDatabase is closed"))
    }
}

/// Check if a table exists in the database.
fn has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        params![table],
        |_| Ok(()),
    )
    .is_ok()
}

/// Check if a column exists in a table.
fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    // PRAGMA table_info returns rows with: cid, name, type, notnull, dflt_value, pk
    let query = format!("PRAGMA table_info({table})");
    let result: Result<Vec<String>, _> = conn.prepare(&query).and_then(|mut stmt| {
        stmt.query_map([], |row| row.get::<_, String>(1))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
    });
    match result {
        Ok(cols) => cols.iter().any(|c| c == column),
        Err(_) => false,
    }
}
