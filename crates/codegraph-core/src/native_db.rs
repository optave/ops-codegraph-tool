//! NativeDatabase — persistent rusqlite Connection exposed as a napi-rs class.
//!
//! Phase 6.13: foundation for moving all DB operations to rusqlite on the native
//! engine path. Handles lifecycle (open/close), schema migrations, and build
//! metadata KV operations.
//!
//! IMPORTANT: Migration DDL is mirrored from src/db/migrations.ts.
//! Any changes there MUST be reflected here (and vice-versa).

use napi_derive::napi;
use rusqlite::{params, types::ValueRef, Connection, OpenFlags};
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
        // 64 entries comfortably holds the 40+ prepare_cached() queries in read_queries.rs
        // plus build-path queries, avoiding LRU eviction (default is 16).
        conn.set_prepared_statement_cache_capacity(64);
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; \
             PRAGMA synchronous = NORMAL; \
             PRAGMA busy_timeout = 5000; \
             PRAGMA mmap_size = 268435456; \
             PRAGMA temp_store = MEMORY;",
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
        conn.set_prepared_statement_cache_capacity(64);
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000; \
             PRAGMA mmap_size = 268435456; \
             PRAGMA temp_store = MEMORY;",
        )
        .map_err(|e| napi::Error::from_reason(format!("Failed to set pragmas: {e}")))?;
        Ok(Self {
            conn: SendWrapper::new(Some(conn)),
            db_path,
        })
    }

    /// Close the database connection. Idempotent — safe to call multiple times.
    #[napi]
    pub fn close(&mut self) {
        (*self.conn).take();
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

    /// Execute a read-only PRAGMA statement and return the first result as a string.
    /// Returns `null` if the pragma produces no output.
    ///
    /// **Note:** This method is intended for read-only PRAGMAs (e.g. `journal_mode`,
    /// `page_count`). Write-mode PRAGMAs (e.g. `journal_mode = DELETE`) should use
    /// `exec()` instead. No validation is performed — callers are trusted internal code.
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
            .query_row(
                "SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
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
                let tx = conn.unchecked_transaction().map_err(|e| {
                    napi::Error::from_reason(format!("begin migration tx failed: {e}"))
                })?;
                tx.execute_batch(migration.up).map_err(|e| {
                    napi::Error::from_reason(format!(
                        "migration v{} failed: {e}",
                        migration.version
                    ))
                })?;
                tx.execute(
                    "UPDATE schema_version SET version = ?1",
                    params![migration.version],
                )
                .map_err(|e| {
                    napi::Error::from_reason(format!("update schema_version failed: {e}"))
                })?;
                tx.commit().map_err(|e| {
                    napi::Error::from_reason(format!(
                        "commit migration v{} failed: {e}",
                        migration.version
                    ))
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

    // ── Phase 6.16: Generic query execution & version validation ────────

    /// Execute a parameterized query and return all rows as JSON objects.
    /// Each row is a `{ column_name: value, ... }` object.
    /// Params are positional (`?1, ?2, ...`) and accept string, number, or null.
    ///
    /// **Note**: Designed for SELECT statements. Passing DML/DDL will not error
    /// at the Rust layer but is not an intended use — all current callers pass
    /// SELECT-only SQL generated by `NodeQuery.build()`.
    #[napi]
    pub fn query_all(
        &self,
        sql: String,
        params: Vec<serde_json::Value>,
    ) -> napi::Result<Vec<serde_json::Value>> {
        let conn = self.conn()?;
        let rusqlite_params = json_to_rusqlite_params(&params)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            rusqlite_params.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| napi::Error::from_reason(format!("queryAll prepare failed: {e}")))?;

        let col_count = stmt.column_count();
        let col_names: Vec<String> = (0..col_count)
            .map(|i| stmt.column_name(i).unwrap_or("?").to_owned())
            .collect();

        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok(row_to_json(row, col_count, &col_names))
            })
            .map_err(|e| napi::Error::from_reason(format!("queryAll query failed: {e}")))?;

        let mut result = Vec::new();
        for row in rows {
            let val =
                row.map_err(|e| napi::Error::from_reason(format!("queryAll row failed: {e}")))?;
            result.push(val);
        }
        Ok(result)
    }

    /// Execute a parameterized query and return the first row, or null.
    /// See `query_all` for parameter and contract details.
    #[napi]
    pub fn query_get(
        &self,
        sql: String,
        params: Vec<serde_json::Value>,
    ) -> napi::Result<Option<serde_json::Value>> {
        let conn = self.conn()?;
        let rusqlite_params = json_to_rusqlite_params(&params)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            rusqlite_params.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| napi::Error::from_reason(format!("queryGet prepare failed: {e}")))?;

        let col_count = stmt.column_count();
        let col_names: Vec<String> = (0..col_count)
            .map(|i| stmt.column_name(i).unwrap_or("?").to_owned())
            .collect();

        let mut query_rows = stmt
            .query(param_refs.as_slice())
            .map_err(|e| napi::Error::from_reason(format!("queryGet query failed: {e}")))?;

        match query_rows.next() {
            Ok(Some(row)) => Ok(Some(row_to_json(row, col_count, &col_names))),
            Ok(None) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!(
                "queryGet row failed: {e}"
            ))),
        }
    }

    /// Validate that the DB's codegraph_version matches the expected version.
    /// Returns `true` if versions match or no version is stored.
    /// Prints a warning to stderr on mismatch.
    #[napi]
    pub fn validate_schema_version(&self, expected_version: String) -> napi::Result<bool> {
        let stored = self.get_build_meta("codegraph_version".to_string())?;
        match stored {
            None => Ok(true),
            Some(ref v) if v == &expected_version => Ok(true),
            Some(v) => {
                eprintln!(
                    "[codegraph] DB was built with v{v}, running v{expected_version}. \
                     Consider: codegraph build --no-incremental"
                );
                Ok(false)
            }
        }
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
        Ok(insert_nodes::do_insert_nodes(conn, &batches, &file_hashes, &removed_files)
            .inspect_err(|e| eprintln!("[NativeDatabase] bulk_insert_nodes failed: {e}"))
            .is_ok())
    }

    /// Bulk-insert edge rows using chunked multi-value INSERT statements.
    /// Returns `true` on success, `false` on failure.
    #[napi]
    pub fn bulk_insert_edges(&self, edges: Vec<EdgeRow>) -> napi::Result<bool> {
        if edges.is_empty() {
            return Ok(true);
        }
        let conn = self.conn()?;
        Ok(edges_db::do_insert_edges(conn, &edges)
            .inspect_err(|e| eprintln!("[NativeDatabase] bulk_insert_edges failed: {e}"))
            .is_ok())
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
    ///
    /// When `reverse_dep_files` is provided, outgoing edges for those files are
    /// also deleted in the same transaction, closing the atomicity gap between
    /// purge and reverse-dependency edge cleanup (see #670).
    #[napi]
    pub fn purge_files_data(
        &self,
        files: Vec<String>,
        purge_hashes: Option<bool>,
        reverse_dep_files: Option<Vec<String>>,
    ) -> napi::Result<()> {
        if files.is_empty() && reverse_dep_files.as_ref().map_or(true, |v| v.is_empty()) {
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

        // Delete outgoing edges for reverse-dep files in the same transaction (#670).
        // These files keep their nodes but need outgoing edges rebuilt.
        if let Some(ref rev_files) = reverse_dep_files {
            for file in rev_files {
                tx.execute(
                    "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1)",
                    params![file],
                )
                .map_err(|e| {
                    napi::Error::from_reason(format!(
                        "reverse-dep edge purge failed for \"{file}\": {e}"
                    ))
                })?;
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
    pub(crate) fn conn(&self) -> napi::Result<&Connection> {
        self.conn
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("NativeDatabase is closed"))
    }
}

/// Check if a table exists in the database.
pub(crate) fn has_table(conn: &Connection, table: &str) -> bool {
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

/// Convert a JSON param array to rusqlite-compatible values.
fn json_to_rusqlite_params(
    params: &[serde_json::Value],
) -> napi::Result<Vec<rusqlite::types::Value>> {
    params
        .iter()
        .enumerate()
        .map(|(i, v)| match v {
            serde_json::Value::Null => Ok(rusqlite::types::Value::Null),
            serde_json::Value::Number(n) => {
                if let Some(int) = n.as_i64() {
                    Ok(rusqlite::types::Value::Integer(int))
                } else if let Some(float) = n.as_f64() {
                    Ok(rusqlite::types::Value::Real(float))
                } else {
                    Err(napi::Error::from_reason(format!(
                        "param[{i}]: unsupported number {n}"
                    )))
                }
            }
            serde_json::Value::String(s) => Ok(rusqlite::types::Value::Text(s.clone())),
            other => Err(napi::Error::from_reason(format!(
                "param[{i}]: unsupported type {}",
                other
            ))),
        })
        .collect()
}

/// Convert a rusqlite row to a serde_json::Value object.
///
/// **Contract**: Only Integer, Real, Text, and Null column types are supported.
/// BLOB columns are mapped to `null` because the current codegraph schema has no
/// BLOB columns and the generic query path is not designed for binary data.
/// Cell-level read errors are also mapped to `null` to avoid partial-row failures.
fn row_to_json(
    row: &rusqlite::Row<'_>,
    col_count: usize,
    col_names: &[String],
) -> serde_json::Value {
    let mut map = serde_json::Map::with_capacity(col_count);
    for i in 0..col_count {
        let val = match row.get_ref(i) {
            Ok(ValueRef::Integer(n)) => serde_json::json!(n),
            Ok(ValueRef::Real(f)) => serde_json::json!(f),
            Ok(ValueRef::Text(s)) => {
                serde_json::Value::String(String::from_utf8_lossy(s).into_owned())
            }
            Ok(ValueRef::Null) => serde_json::Value::Null,
            // BLOB: no codegraph schema columns use BLOB; map to null (see contract above)
            Ok(ValueRef::Blob(_)) => serde_json::Value::Null,
            // Cell read error: map to null to avoid partial-row failures
            Err(_) => serde_json::Value::Null,
        };
        map.insert(col_names[i].clone(), val);
    }
    serde_json::Value::Object(map)
}
