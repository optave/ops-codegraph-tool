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

use crate::db::repository::ast::{self, FileAstBatch};
use crate::db::repository::edges::{self, EdgeRow};
use crate::domain::graph::builder::stages::insert_nodes::{self, FileHashEntry, InsertNodesBatch};
use crate::graph::classifiers::roles::{self, RoleSummary};

/// Fallback `PRAGMA busy_timeout` (ms) used when the caller doesn't pass a
/// resolved value. Mirrors `DEFAULTS.db.busyTimeoutMs` in
/// `src/infrastructure/config.ts` — keep both in sync.
const DEFAULT_BUSY_TIMEOUT_MS: u32 = 5000;

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
    Migration {
        version: 17,
        up: r#"
      ALTER TABLE edges ADD COLUMN technique TEXT;
      CREATE INDEX IF NOT EXISTS idx_edges_technique ON edges(technique);
    "#,
    },
    Migration {
        version: 18,
        up: r#"
      CREATE TABLE IF NOT EXISTS dataflow_vertices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        func_id     INTEGER NOT NULL REFERENCES nodes(id),
        kind        TEXT NOT NULL,
        name        TEXT,
        param_index INTEGER,
        line        INTEGER,
        node_id     INTEGER REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_dfv_func ON dataflow_vertices(func_id);
      CREATE INDEX IF NOT EXISTS idx_dfv_func_kind ON dataflow_vertices(func_id, kind);
      CREATE INDEX IF NOT EXISTS idx_dfv_node ON dataflow_vertices(node_id);

      ALTER TABLE dataflow ADD COLUMN source_vertex INTEGER REFERENCES dataflow_vertices(id);
      ALTER TABLE dataflow ADD COLUMN target_vertex INTEGER REFERENCES dataflow_vertices(id);
      ALTER TABLE dataflow ADD COLUMN scope TEXT;
      ALTER TABLE dataflow ADD COLUMN call_edge_id INTEGER REFERENCES edges(id);

      CREATE INDEX IF NOT EXISTS idx_dataflow_sv ON dataflow(source_vertex);
      CREATE INDEX IF NOT EXISTS idx_dataflow_tv ON dataflow(target_vertex);
      CREATE INDEX IF NOT EXISTS idx_dataflow_scope ON dataflow(scope);

      CREATE TABLE IF NOT EXISTS dataflow_summary (
        func_id     INTEGER NOT NULL REFERENCES nodes(id),
        param_index INTEGER NOT NULL,
        flows_to_return INTEGER NOT NULL DEFAULT 0,
        is_mutated  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(func_id, param_index)
      );
      CREATE INDEX IF NOT EXISTS idx_dfs_func ON dataflow_summary(func_id);

      CREATE VIEW IF NOT EXISTS dataflow_fn AS
        SELECT
          sv.func_id AS source_id,
          tv.func_id AS target_id,
          d.kind,
          d.param_index,
          d.expression,
          d.line,
          d.confidence
        FROM dataflow d
        JOIN dataflow_vertices sv ON d.source_vertex = sv.id
        JOIN dataflow_vertices tv ON d.target_vertex = tv.id
        WHERE sv.func_id != tv.func_id;
    "#,
    },
    Migration {
        version: 19,
        // P6 sentinel: forces a full rebuild so that databases built with the native
        // fast path (which skipped vertex extraction before P6) backfill
        // dataflow_vertices and dataflow_summary on the next `codegraph build`.
        up: "SELECT 1",
    },
    Migration {
        version: 20,
        up: r#"
      ALTER TABLE edges ADD COLUMN dynamic_kind TEXT;
      CREATE INDEX IF NOT EXISTS idx_edges_dynamic_kind ON edges(dynamic_kind) WHERE dynamic_kind IS NOT NULL;
    "#,
    },
    Migration {
        version: 21,
        up: r#"
      CREATE TABLE IF NOT EXISTS deleted_export_advisories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        consumer_name TEXT NOT NULL,
        consumer_file TEXT NOT NULL,
        consumer_line INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deleted_export_advisories_file ON deleted_export_advisories(file);
    "#,
    },
    Migration {
        version: 22,
        up: r#"
      ALTER TABLE deleted_export_advisories ADD COLUMN consumer_kind TEXT;
    "#,
    },
    Migration {
        // dataflow.call_edge_id (added in v18, `REFERENCES edges(id)`) was never
        // given its own index — every DELETE FROM edges pays an O(dataflow-rows)
        // scan under better-sqlite3, which defaults `PRAGMA foreign_keys = ON`
        // (this native/rusqlite connection never sets that pragma, so native
        // never paid this cost — WASM-only exposure, see issue #1948).
        version: 23,
        up: r#"
      CREATE INDEX IF NOT EXISTS idx_dataflow_call_edge ON dataflow(call_edge_id);
    "#,
    },
    Migration {
        // Per-declaration content hash (issue #2015): reverse-dep-edge
        // reconnection during incremental rebuilds previously matched
        // siblings by line position alone, which is provably unsafe when a
        // same-named/same-kind sibling group has one member renamed away
        // and a different one added in the same edit — the group's size
        // stays unchanged, so the line-alignment fast path matches by rank
        // and can silently reconnect a caller to the wrong declaration. A
        // content hash gives reconnection a true identity signal to try
        // first, falling back to line alignment only when a hash is
        // unavailable (e.g. rows from before this migration).
        version: 24,
        up: r#"
      ALTER TABLE nodes ADD COLUMN content_hash TEXT;
    "#,
    },
    Migration {
        // Persist barrel re-export rename pairs (issue #1967): `export { X
        // as Y } from '...'` records `{local: Y, imported: X}` alongside
        // which file the rename's own source resolves to. Populated by the
        // native orchestrator (import_edges::persist_reexport_renames) and
        // the JS pipeline (resolve-imports.ts) whenever a barrel file is
        // (re)parsed, so `codegraph watch`'s single-file incremental rebuild
        // (resolveBarrelTarget, domain/graph/builder/incremental.ts, JS-only)
        // can translate a consumer's requested external alias back to the
        // name actually declared in the reexport source without needing to
        // re-parse the barrel file itself in the same watch batch.
        version: 25,
        up: r#"
      CREATE TABLE IF NOT EXISTS reexport_renames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        barrel_file TEXT NOT NULL,
        local_name TEXT NOT NULL,
        imported_name TEXT NOT NULL,
        source_file TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reexport_renames_barrel ON reexport_renames(barrel_file, local_name);
    "#,
    },
    Migration {
        // One-time relabel (issue #1996): the CHA-expansion post-pass used to
        // tag its own output 'cha-expanded' to distinguish it from
        // this/super-dispatch edges ('cha') for a since-removed
        // candidate-exclusion filter. Existing databases built before this
        // migration have persisted 'cha-expanded' rows that an incremental
        // rebuild's seen-pair dedup would otherwise leave stale forever.
        // Backfill them once here so every database converges on the
        // uniform 'cha' label without requiring a full rebuild.
        version: 26,
        up: r#"
      UPDATE edges SET technique = 'cha' WHERE technique = 'cha-expanded';
    "#,
    },
    Migration {
        // Cross-file ES6 getter/setter accessor recognition (issue #2030,
        // follow-up to #1893). Mirrors src/db/migrations.ts v27 — see that
        // migration's comment for the rationale.
        version: 27,
        up: r#"
      ALTER TABLE nodes ADD COLUMN accessor_kind TEXT;
      CREATE INDEX IF NOT EXISTS idx_nodes_accessor_kind ON nodes(accessor_kind) WHERE accessor_kind IS NOT NULL;
    "#,
    },
    Migration {
        // Content-level uniqueness for `edges` (issue #2072). Mirrors
        // src/db/migrations.ts v28 — see that migration's comment for the
        // full rationale. Summary: `INSERT OR IGNORE` into `edges` had no
        // constraint behind it (unlike `nodes`' real UNIQUE(name, kind,
        // file, line)), so several comments claiming it deduped edge
        // content were wrong — safe today only because every insert path is
        // separately guarded by a purge-before-insert pattern.
        //
        // The content key is EVERY non-id column — (source_id, target_id,
        // kind, confidence, dynamic, dynamic_kind, technique) — not the
        // narrower (source_id, target_id, kind) the issue first suggested.
        // graph/cycles.ts's speculative-cycle classification (#1844)
        // legitimately keeps two edges for the same (source_id, target_id,
        // kind='calls') pair at once — one confirmed direct call, one
        // independent low-confidence dynamic guess — distinguished only by
        // confidence/dynamic. Flag-only dynamic calls similarly emit
        // multiple "sink" edges to the same file distinguished only by
        // dynamic_kind (see `seen_sink_edges` in build_edges.rs). A
        // constraint narrower than "every column" would silently collapse
        // either case. dynamic_kind/technique are NULL far more often than
        // not, and SQL UNIQUE treats every NULL as distinct, so both are
        // wrapped in COALESCE(..., '') — confidence/dynamic/kind need no
        // such wrapping (never NULL). The DELETE runs first (keeping the
        // lowest id per group) so this can never fail on a database that
        // already has duplicate content rows.
        version: 28,
        up: r#"
      DELETE FROM edges WHERE id NOT IN (
        SELECT MIN(id) FROM edges
        GROUP BY source_id, target_id, kind, confidence, dynamic, COALESCE(dynamic_kind, ''), COALESCE(technique, '')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_content_unique
        ON edges(source_id, target_id, kind, confidence, dynamic, COALESCE(dynamic_kind, ''), COALESCE(technique, ''));
    "#,
    },
    Migration {
        // #2087: durable, per-file record of every property/method name ever
        // invoked via member-call syntax (`x.name(...)`) — the "one hop
        // further" liveness evidence the #1895 object-literal-property
        // value-ref check needs (collect_invoked_property_names /
        // collectInvokedPropertyNames). A full build sees every file at
        // once, so it was always exact; a `codegraph watch` single-file
        // incremental rebuild (JS-only, domain/graph/builder/incremental.ts)
        // only sees the one file being rebuilt, so a consumer's
        // `.resolve(...)` call living in an untouched file was invisible.
        // Populated once per full or incremental build (both engines — the
        // native orchestrator mirrors the JS pipeline's write via
        // import_edges::persist_invoked_property_names) so the incremental
        // path has a durable, whole-graph view to query. Mirrors
        // src/db/migrations.ts v29.
        version: 29,
        up: r#"
      CREATE TABLE IF NOT EXISTS invoked_property_names (
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (file, name)
      );
      CREATE INDEX IF NOT EXISTS idx_invoked_property_names_name ON invoked_property_names(name);
    "#,
    },
    Migration {
        // #2138: durable, per-file record of every function/method's
        // inferred return type — needed so cross-file return-type
        // propagation (propagate_return_types_across_files /
        // propagateReturnTypesAcrossFiles) can resolve
        // `const x = importedFactory(); x.method()`-shaped dispatch to a
        // file this build never re-parsed. Without this, an incremental
        // build that re-parses a barrel-adjacent file wipes that file's
        // outgoing calls/receiver edges and re-derives them from an
        // in-memory return-type index scoped only to this build's file set,
        // so a factory/getter defined in an untouched file silently drops
        // out of dispatch resolution until a full --no-incremental rebuild.
        // Populated once per full or incremental build (both engines).
        // Mirrors src/db/migrations.ts v30.
        version: 30,
        up: r#"
      CREATE TABLE IF NOT EXISTS return_types (
        file TEXT NOT NULL,
        fn_name TEXT NOT NULL,
        type_name TEXT NOT NULL,
        confidence REAL NOT NULL,
        PRIMARY KEY (file, fn_name)
      );
      CREATE INDEX IF NOT EXISTS idx_return_types_file ON return_types(file);
    "#,
    },
    Migration {
        // #2428: durable, per-file record of every call the Python extractor
        // flagged as a program entrypoint — the `if __name__ == "__main__":`
        // guard and `__main__.py` module level (#2392).
        //
        // This is the *evidence*; `nodes.entrypoint` is a projection of it
        // (see domain/graph/builder/entrypoints.rs). The two have different
        // lifecycles: the evidence belongs to the guard's file, while the
        // flag sits on the target's node row, which is purged and
        // re-inserted whenever the *target's* file is rebuilt. #2411 wrote
        // the flag straight from the reparsed files' symbols, so a build
        // that reparsed only the target had nothing to re-mark it from and
        // silently dropped it.
        //
        // Deleted and re-inserted per file via the same purge path as
        // invoked_property_names / return_types, which is what makes an
        // edited-away or deleted guard clear its target without a dedicated
        // pre-purge step. Mirrors src/db/migrations.ts v31.
        version: 31,
        up: r#"
      CREATE TABLE IF NOT EXISTS entrypoint_calls (
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (file, name)
      );
    "#,
    },
    Migration {
        // #2088: durable per-file object-literal sites and correlated
        // invoked-property evidence. Mirrors src/db/migrations.ts v32.
        version: 32,
        up: r#"
      CREATE TABLE IF NOT EXISTS object_literal_sites (
        file    TEXT    NOT NULL,
        site    TEXT    NOT NULL,
        escapes INTEGER NOT NULL,
        PRIMARY KEY (file, site)
      );
      CREATE TABLE IF NOT EXISTS invoked_property_sites (
        site_key TEXT NOT NULL,
        name     TEXT NOT NULL,
        file     TEXT NOT NULL,
        PRIMARY KEY (site_key, name, file)
      );
      CREATE INDEX IF NOT EXISTS idx_invoked_property_sites_key
        ON invoked_property_sites(site_key);
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

// ── Bulk-insert input types ────────────────────────────────────────────

/// A single complexity metrics row for bulk insertion.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ComplexityRow {
    pub node_id: i64,
    pub cognitive: u32,
    pub cyclomatic: u32,
    pub max_nesting: u32,
    pub loc: u32,
    pub sloc: u32,
    pub comment_lines: u32,
    pub halstead_n1: u32,
    pub halstead_n2: u32,
    pub halstead_big_n1: u32,
    pub halstead_big_n2: u32,
    pub halstead_vocabulary: u32,
    pub halstead_length: u32,
    pub halstead_volume: f64,
    pub halstead_difficulty: f64,
    pub halstead_effort: f64,
    pub halstead_bugs: f64,
    pub maintainability_index: f64,
}

/// A CFG entry for a single function: blocks + edges.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct CfgEntry {
    pub node_id: i64,
    pub blocks: Vec<CfgBlockRow>,
    pub edges: Vec<CfgEdgeRow>,
}

/// A single CFG block for bulk insertion.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct CfgBlockRow {
    pub index: u32,
    pub block_type: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub label: Option<String>,
}

/// A single CFG edge for bulk insertion.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct CfgEdgeRow {
    pub source_index: u32,
    pub target_index: u32,
    pub kind: String,
}

/// A single dataflow edge for bulk insertion.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DataflowEdge {
    pub source_id: i64,
    pub target_id: i64,
    pub kind: String,
    pub param_index: Option<u32>,
    pub expression: Option<String>,
    pub line: Option<u32>,
    pub confidence: f64,
}

// ── Build-glue return types ────────────────────────────────────────────

/// A single row from file_hashes.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FileHashRow {
    pub file: String,
    pub hash: String,
    pub mtime: i64,
    pub size: i64,
}

/// Batched result of file_hashes table read.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FileHashData {
    pub exists: bool,
    pub rows: Vec<FileHashRow>,
    pub max_mtime: i64,
}

/// Counts for pending analysis tables.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct PendingAnalysisCounts {
    pub cfg_count: i64,
    pub dataflow_count: i64,
}

/// Batched node/edge counts for finalize.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FinalizeCounts {
    pub node_count: i64,
    pub edge_count: i64,
}

/// Batched advisory check results.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct AdvisoryCheckResult {
    pub orphaned_embeddings: i64,
    pub embed_built_at: Option<String>,
    pub unused_exports: i64,
}

/// Batched collect-files data.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct CollectFilesData {
    pub count: i64,
    pub files: Vec<String>,
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
    ///
    /// `busy_timeout_ms` mirrors `config.db.busyTimeoutMs` on the TS side
    /// (`DEFAULTS.db.busyTimeoutMs` in `src/infrastructure/config.ts`);
    /// defaults to `DEFAULT_BUSY_TIMEOUT_MS` when omitted.
    #[napi(factory)]
    pub fn open_read_write(db_path: String, busy_timeout_ms: Option<u32>) -> napi::Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&db_path, flags)
            .map_err(|e| napi::Error::from_reason(format!("Failed to open DB: {e}")))?;
        // 64 entries comfortably holds the 40+ prepare_cached() queries in read_queries.rs
        // plus build-path queries, avoiding LRU eviction (default is 16).
        conn.set_prepared_statement_cache_capacity(64);
        // Disable mmap for read-write connections: when both rusqlite and
        // better-sqlite3 share the same WAL-mode file, mmap and regular I/O
        // are not cache-coherent on Windows, leading to SQLITE_CORRUPT (#715).
        // Read-only connections keep mmap since they don't share a WAL file
        // with a concurrent writer from a different library.
        let busy_timeout_ms = busy_timeout_ms.unwrap_or(DEFAULT_BUSY_TIMEOUT_MS);
        conn.execute_batch(&format!(
            "PRAGMA journal_mode = WAL; \
             PRAGMA synchronous = NORMAL; \
             PRAGMA busy_timeout = {busy_timeout_ms}; \
             PRAGMA temp_store = MEMORY;",
        ))
        .map_err(|e| napi::Error::from_reason(format!("Failed to set pragmas: {e}")))?;
        Ok(Self {
            conn: SendWrapper::new(Some(conn)),
            db_path,
        })
    }

    /// Open a read-only connection to the database at `db_path`.
    ///
    /// `busy_timeout_ms` mirrors `config.db.busyTimeoutMs` on the TS side
    /// (`DEFAULTS.db.busyTimeoutMs` in `src/infrastructure/config.ts`);
    /// defaults to `DEFAULT_BUSY_TIMEOUT_MS` when omitted.
    #[napi(factory)]
    pub fn open_readonly(db_path: String, busy_timeout_ms: Option<u32>) -> napi::Result<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&db_path, flags)
            .map_err(|e| napi::Error::from_reason(format!("Failed to open DB readonly: {e}")))?;
        conn.set_prepared_statement_cache_capacity(64);
        let busy_timeout_ms = busy_timeout_ms.unwrap_or(DEFAULT_BUSY_TIMEOUT_MS);
        conn.execute_batch(&format!(
            "PRAGMA busy_timeout = {busy_timeout_ms}; \
             PRAGMA mmap_size = 268435456; \
             PRAGMA temp_store = MEMORY;",
        ))
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

    /// Execute a read-only PRAGMA statement and return its first result column.
    /// Returns `null` if the pragma produces no output. Most pragmas return an
    /// INTEGER (e.g. `busy_timeout`, `page_count`, `user_version`) or TEXT (e.g.
    /// `journal_mode`) result — the return type mirrors whichever affinity the
    /// pragma actually produced (see `value_ref_to_json`'s contract doc).
    ///
    /// **Note:** This method is intended for read-only PRAGMAs (e.g. `journal_mode`,
    /// `page_count`). Write-mode PRAGMAs (e.g. `journal_mode = DELETE`) should use
    /// `exec()` instead. No validation is performed — callers are trusted internal code.
    #[napi]
    pub fn pragma(&self, sql: String) -> napi::Result<Option<serde_json::Value>> {
        let conn = self.conn()?;
        let query = format!("PRAGMA {sql}");
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| napi::Error::from_reason(format!("pragma prepare failed: {e}")))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| napi::Error::from_reason(format!("pragma query failed: {e}")))?;
        match rows.next() {
            Ok(Some(row)) => Ok(Some(value_ref_to_json(row.get_ref(0)))),
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

        // #2072: migration v28 below (edges content-uniqueness index) assumes
        // `edges.dynamic_kind` already exists once the versioned loop reaches
        // it — true for every ordinary database, since v20 (further down)
        // adds that column and always runs first for any `current_version <
        // 20`. It is NOT true for the one anomalous case the post-loop
        // "legacy column compat" block further below already exists to
        // repair (see its own comment on `edges.dynamic_kind` for the full
        // #2001/#2066 history): a native-only database whose
        // `schema_version` was already stamped past 20 by the pre-fix
        // MIGRATIONS array, which jumped straight from v19 to v21 and never
        // actually applied v20. The loop's `migration.version >
        // current_version` gate means it will never revisit v20 to add the
        // column for such a database — so without this, v28 would fail with
        // "no such column: dynamic_kind" before the post-loop repair ever
        // gets a chance to run. Guarding on `current_version > 20` (rather
        // than an unconditional add) is what keeps this a no-op for every
        // normal database: those have `current_version <= 20` here, so the
        // loop's own v20 migration is the one and only place that adds the
        // column — adding it here too would collide with that unconditional
        // `ALTER TABLE ... ADD COLUMN` and fail with "duplicate column name".
        if current_version > 20
            && has_table(conn, "edges")
            && !has_column(conn, "edges", "dynamic_kind")
        {
            conn.execute_batch("ALTER TABLE edges ADD COLUMN dynamic_kind TEXT")
                .map_err(|e| {
                    napi::Error::from_reason(format!(
                        "pre-migration repair: add edges.dynamic_kind failed: {e}"
                    ))
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
            // #2015: content_hash is referenced unconditionally by every node
            // insert (see insert_nodes.rs), unlike the other legacy columns in
            // this block — propagate failure instead of swallowing it, mirroring
            // the #2001/#2066 dynamic_kind fix on the edges table below.
            if !has_column(conn, "nodes", "content_hash") {
                conn.execute_batch("ALTER TABLE nodes ADD COLUMN content_hash TEXT")
                    .map_err(|e| {
                        napi::Error::from_reason(format!(
                            "legacy repair: add nodes.content_hash failed: {e}"
                        ))
                    })?;
            }
            if !has_column(conn, "nodes", "accessor_kind") {
                let _ = conn.execute_batch("ALTER TABLE nodes ADD COLUMN accessor_kind TEXT");
            }
            // #2392: added here rather than as a numbered migration because a
            // bare `ALTER TABLE ... ADD COLUMN` is not replay-safe — a DB
            // stamped back to an earlier schema_version (as
            // `migration_v28_deletes_pre_existing_duplicate_edges_before_indexing`
            // does) would re-run it against a table that already has the
            // column and abort the whole upgrade. This block is idempotent by
            // construction and runs on every open, so it covers fresh and
            // legacy databases alike.
            if !has_column(conn, "nodes", "entrypoint") {
                let _ =
                    conn.execute_batch("ALTER TABLE nodes ADD COLUMN entrypoint INTEGER DEFAULT 0");
            }
            let _ = conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_nodes_entrypoint ON nodes(entrypoint) WHERE entrypoint = 1",
            );
            // #2411 (review fix): the file whose call site attributed the
            // current `entrypoint` flag. A rebuild needs this to clear a
            // stale flag when the attributing call is deleted or renamed —
            // re-deriving from live `calls` edges doesn't work for a target
            // declared in a *different* file than the guard, because that
            // edge is already purged (as part of reprocessing the changed
            // file) by the time the clear query would run. Reading this
            // column instead makes the clear correct regardless of the
            // edge's lifecycle.
            if !has_column(conn, "nodes", "entrypoint_source_file") {
                let _ =
                    conn.execute_batch("ALTER TABLE nodes ADD COLUMN entrypoint_source_file TEXT");
            }
            let _ = conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_nodes_entrypoint_source_file ON nodes(entrypoint_source_file)",
            );
            // #2420: narrower than `entrypoint` — see TS `ensureNodeColumns`'s
            // mirrored comment (migrations.ts) for the full rationale.
            if !has_column(conn, "nodes", "entrypoint_role") {
                let _ = conn.execute_batch(
                    "ALTER TABLE nodes ADD COLUMN entrypoint_role INTEGER DEFAULT 0",
                );
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
            // #2001/#2066: version-gated migration v20 alone cannot repair a
            // native-only database whose schema_version was already advanced
            // past 20 by the pre-fix MIGRATIONS array (which jumped straight
            // from v19 to v21, never applying v20) — its stored version being
            // >= 21 makes the `migration.version > current_version` gate skip
            // v20 forever on every subsequent init_schema() call. This
            // unconditional, reality-checked backfill (mirroring the
            // confidence/dynamic columns just above) repairs those databases
            // too, not just fresh ones.
            //
            // Unlike the other legacy columns in this block, `dynamic_kind` is
            // referenced unconditionally by every edge insert (see
            // db/repository/edges.rs). A silently swallowed ALTER failure here
            // would let init_schema() report success while leaving the column
            // absent, so every subsequent edge batch would fail with a much
            // harder-to-diagnose "no such column" error — propagate instead.
            if !has_column(conn, "edges", "dynamic_kind") {
                conn.execute_batch("ALTER TABLE edges ADD COLUMN dynamic_kind TEXT")
                    .map_err(|e| {
                        napi::Error::from_reason(format!(
                            "legacy repair: add edges.dynamic_kind failed: {e}"
                        ))
                    })?;
            }
            let _ = conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_edges_dynamic_kind ON edges(dynamic_kind) WHERE dynamic_kind IS NOT NULL",
            );
        }

        // #2420: bare name of the call this evidence row's call is nested
        // inside, or NULL for a top-level entrypoint call. Mirrors TS
        // `ensureEntrypointCallsColumns` (migrations.ts) — see that
        // function's doc comment for why this is an idempotent ALTER rather
        // than a numbered migration. Guarded on the table existing since a
        // pre-v31 database reaches this before migration v31 has run.
        if has_table(conn, "entrypoint_calls")
            && !has_column(conn, "entrypoint_calls", "wrapped_by")
        {
            let _ = conn.execute_batch("ALTER TABLE entrypoint_calls ADD COLUMN wrapped_by TEXT");
        }

        // #2428: seed `entrypoint_calls` from attribution a pre-v31 build
        // already wrote onto `nodes`, so upgrading a database does not lose
        // it. `nodes.entrypoint` is a projection of that table; on a pre-v31
        // graph the flags exist but the table does not, and migration v31
        // creates it empty — at which point the next partial rebuild would
        // project the empty table across the whole graph and clear every flag
        // contributed by a guard file it did not happen to reparse (review
        // finding on #2434). A full build is unaffected, since it reparses
        // everything.
        //
        // Recording the *target's* name rather than the guard's original call
        // name is deliberate and sufficient: the projection matches
        // `tgt.name = ec.name` first, so this reproduces exactly the
        // attribution already stored. The row is replaced with the real call
        // name the first time that guard file is reparsed.
        //
        // Runs here, after the legacy-column block, because the versioned
        // migration loop above cannot rely on `nodes.entrypoint` existing —
        // that column is added by that block, not by a numbered migration.
        // Guarded on the table being empty, which is both what makes it
        // idempotent and what keeps it from ever overwriting real evidence.
        // Mirrors `backfillEntrypointEvidence` in src/db/migrations.ts.
        if has_table(conn, "entrypoint_calls")
            && has_table(conn, "nodes")
            && has_column(conn, "nodes", "entrypoint_source_file")
            && conn
                .query_row("SELECT 1 FROM entrypoint_calls LIMIT 1", [], |_| Ok(()))
                .is_err()
        {
            let _ = conn.execute_batch(
                "INSERT OR IGNORE INTO entrypoint_calls (file, name)
                 SELECT entrypoint_source_file, name FROM nodes
                 WHERE entrypoint = 1 AND entrypoint_source_file IS NOT NULL",
            );
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
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = rusqlite_params
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();

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
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = rusqlite_params
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();

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
    ///
    /// Batches are received as `serde_json::Value` and deserialized via serde so
    /// that `null` visibility values map to `None` instead of crashing napi's
    /// `Option<String>` object conversion (#709).
    ///
    /// `file_hashes` is committed in its own transaction, separate from node
    /// insertion (#1731) — callers that need edge-consistent hashes (i.e. the
    /// standard incremental build pipeline) should pass an empty array here
    /// and commit hashes themselves once resolveImports/buildEdges have
    /// finished rebuilding the affected files' edges (see
    /// `insertNodes.commitFileHashes` on the JS side, or
    /// `insert_nodes::commit_file_hashes` for the all-Rust orchestrator).
    #[napi(
        ts_args_type = "batches: Array<{ file: string; definitions: Array<{ name: string; kind: string; line: number; endLine?: number; visibility?: string; children: Array<{ name: string; kind: string; line: number; endLine?: number; visibility?: string }> }>; exports: Array<{ name: string; kind: string; line: number }> }>, fileHashes: FileHashEntry[], removedFiles: string[]"
    )]
    pub fn bulk_insert_nodes(
        &self,
        batches: serde_json::Value,
        file_hashes: Vec<FileHashEntry>,
        removed_files: Vec<String>,
    ) -> napi::Result<bool> {
        let batches: Vec<InsertNodesBatch> = serde_json::from_value(batches).map_err(|e| {
            napi::Error::from_reason(format!("bulk_insert_nodes: invalid batches: {e}"))
        })?;
        let conn = self.conn()?;
        let insert_ok = insert_nodes::do_insert_nodes(conn, &batches, &removed_files)
            .inspect_err(|e| eprintln!("[NativeDatabase] bulk_insert_nodes failed: {e}"))
            .is_ok();
        if !insert_ok {
            return Ok(false);
        }
        let hashes_ok = insert_nodes::commit_file_hashes(conn, &file_hashes)
            .inspect_err(|e| {
                eprintln!("[NativeDatabase] bulk_insert_nodes hash commit failed: {e}")
            })
            .is_ok();
        Ok(hashes_ok)
    }

    /// Bulk-insert edge rows using chunked multi-value INSERT statements.
    /// Returns `true` on success, `false` on failure.
    #[napi]
    pub fn bulk_insert_edges(&self, edges: Vec<EdgeRow>) -> napi::Result<bool> {
        if edges.is_empty() {
            return Ok(true);
        }
        let conn = self.conn()?;
        Ok(edges::do_insert_edges(conn, &edges)
            .inspect_err(|e| eprintln!("[NativeDatabase] bulk_insert_edges failed: {e}"))
            .is_ok())
    }

    /// Bulk-insert AST nodes, resolving parent_node_id from the nodes table.
    /// Returns the number of rows inserted (0 on failure).
    #[napi]
    pub fn bulk_insert_ast_nodes(&self, batches: Vec<FileAstBatch>) -> napi::Result<u32> {
        let conn = self.conn()?;
        Ok(ast::do_insert_ast_nodes(conn, &batches).unwrap_or(0))
    }

    /// Bulk-insert complexity metrics for functions/methods.
    /// Each row maps a node_id to its complexity metrics.
    /// Returns the number of rows inserted (0 on failure).
    #[napi]
    pub fn bulk_insert_complexity(&self, rows: Vec<ComplexityRow>) -> napi::Result<u32> {
        if rows.is_empty() {
            return Ok(0);
        }
        let conn = self.conn()?;
        if !has_table(conn, "function_complexity") {
            return Ok(0);
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| napi::Error::from_reason(format!("complexity tx failed: {e}")))?;
        let mut total = 0u32;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO function_complexity \
                 (node_id, cognitive, cyclomatic, max_nesting, \
                  loc, sloc, comment_lines, \
                  halstead_n1, halstead_n2, halstead_big_n1, halstead_big_n2, \
                  halstead_vocabulary, halstead_length, halstead_volume, \
                  halstead_difficulty, halstead_effort, halstead_bugs, \
                  maintainability_index) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
                )
                .map_err(|e| napi::Error::from_reason(format!("complexity prepare failed: {e}")))?;

            for r in &rows {
                if stmt
                    .execute(params![
                        r.node_id,
                        r.cognitive,
                        r.cyclomatic,
                        r.max_nesting,
                        r.loc,
                        r.sloc,
                        r.comment_lines,
                        r.halstead_n1,
                        r.halstead_n2,
                        r.halstead_big_n1,
                        r.halstead_big_n2,
                        r.halstead_vocabulary,
                        r.halstead_length,
                        r.halstead_volume,
                        r.halstead_difficulty,
                        r.halstead_effort,
                        r.halstead_bugs,
                        r.maintainability_index,
                    ])
                    .is_ok()
                {
                    total += 1;
                }
            }
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("complexity commit failed: {e}")))?;
        Ok(total)
    }

    /// Bulk-insert CFG blocks and edges for functions/methods.
    /// Returns the number of blocks inserted (0 on failure).
    #[napi]
    pub fn bulk_insert_cfg(&self, entries: Vec<CfgEntry>) -> napi::Result<u32> {
        if entries.is_empty() {
            return Ok(0);
        }
        let conn = self.conn()?;
        if !has_table(conn, "cfg_blocks") {
            return Ok(0);
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| napi::Error::from_reason(format!("cfg tx failed: {e}")))?;
        let mut total = 0u32;
        {
            let mut block_stmt = tx
                .prepare(
                    "INSERT INTO cfg_blocks \
                 (function_node_id, block_index, block_type, start_line, end_line, label) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|e| napi::Error::from_reason(format!("cfg_blocks prepare failed: {e}")))?;

            let mut edge_stmt = tx
                .prepare(
                    "INSERT INTO cfg_edges \
                 (function_node_id, source_block_id, target_block_id, kind) \
                 VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| napi::Error::from_reason(format!("cfg_edges prepare failed: {e}")))?;

            let mut del_edges = tx
                .prepare("DELETE FROM cfg_edges WHERE function_node_id = ?1")
                .map_err(|e| {
                    napi::Error::from_reason(format!("cfg_edges del prepare failed: {e}"))
                })?;
            let mut del_blocks = tx
                .prepare("DELETE FROM cfg_blocks WHERE function_node_id = ?1")
                .map_err(|e| {
                    napi::Error::from_reason(format!("cfg_blocks del prepare failed: {e}"))
                })?;

            for entry in &entries {
                // Delete existing CFG data for this node so the caller doesn't
                // need to perform deletes on a separate (JS) connection, which
                // would cause a WAL conflict with the native connection.
                del_edges.execute(params![entry.node_id]).map_err(|e| {
                    napi::Error::from_reason(format!("cfg_edges delete failed: {e}"))
                })?;
                del_blocks.execute(params![entry.node_id]).map_err(|e| {
                    napi::Error::from_reason(format!("cfg_blocks delete failed: {e}"))
                })?;

                let mut block_db_ids: std::collections::HashMap<u32, i64> =
                    std::collections::HashMap::new();
                for block in &entry.blocks {
                    if block_stmt
                        .execute(params![
                            entry.node_id,
                            block.index,
                            &block.block_type,
                            block.start_line,
                            block.end_line,
                            &block.label,
                        ])
                        .is_ok()
                    {
                        block_db_ids.insert(block.index, tx.last_insert_rowid());
                        total += 1;
                    }
                }
                for edge in &entry.edges {
                    if let (Some(&src), Some(&tgt)) = (
                        block_db_ids.get(&edge.source_index),
                        block_db_ids.get(&edge.target_index),
                    ) {
                        let _ = edge_stmt.execute(params![entry.node_id, src, tgt, &edge.kind]);
                    }
                }
            }
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("cfg commit failed: {e}")))?;
        Ok(total)
    }

    /// Bulk-insert dataflow edges (flows_to, returns, mutates).
    /// Returns the number of edges inserted (0 on failure).
    #[napi]
    pub fn bulk_insert_dataflow(&self, edges: Vec<DataflowEdge>) -> napi::Result<u32> {
        if edges.is_empty() {
            return Ok(0);
        }
        let conn = self.conn()?;
        if !has_table(conn, "dataflow") {
            return Ok(0);
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| napi::Error::from_reason(format!("dataflow tx failed: {e}")))?;
        let mut total = 0u32;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO dataflow \
                 (source_id, target_id, kind, param_index, expression, line, confidence) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|e| napi::Error::from_reason(format!("dataflow prepare failed: {e}")))?;

            for e in &edges {
                if stmt
                    .execute(params![
                        e.source_id,
                        e.target_id,
                        &e.kind,
                        e.param_index,
                        &e.expression,
                        e.line,
                        e.confidence,
                    ])
                    .is_ok()
                {
                    total += 1;
                }
            }
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("dataflow commit failed: {e}")))?;
        Ok(total)
    }

    /// Full role classification: queries all nodes, computes fan-in/fan-out,
    /// classifies roles, and batch-updates the `role` column.
    #[napi]
    pub fn classify_roles_full(&self) -> napi::Result<Option<RoleSummary>> {
        let conn = self.conn()?;
        Ok(roles::do_classify_full(conn).ok())
    }

    /// Incremental role classification: only reclassifies nodes from changed
    /// files plus their immediate edge neighbours.
    #[napi]
    pub fn classify_roles_incremental(
        &self,
        changed_files: Vec<String>,
    ) -> napi::Result<Option<RoleSummary>> {
        let conn = self.conn()?;
        Ok(roles::do_classify_incremental(conn, &changed_files).ok())
    }

    // ── Phase 6.18: Batched build-glue queries ──────────────────────────

    /// Batched read of file_hashes table for detect-changes stage.
    /// Returns table existence, all rows, and max mtime in a single napi call.
    #[napi]
    pub fn get_file_hash_data(&self) -> napi::Result<FileHashData> {
        let conn = self.conn()?;
        if !has_table(conn, "file_hashes") {
            return Ok(FileHashData {
                exists: false,
                rows: vec![],
                max_mtime: 0,
            });
        }
        let mut stmt = conn
            .prepare_cached("SELECT file, hash, mtime, size FROM file_hashes")
            .map_err(|e| {
                napi::Error::from_reason(format!("getFileHashData prepare failed: {e}"))
            })?;
        let mut rows = Vec::new();
        let mut max_mtime: i64 = 0;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| napi::Error::from_reason(format!("getFileHashData query failed: {e}")))?;
        for r in mapped {
            let (file, hash, mtime, size) =
                r.map_err(|e| napi::Error::from_reason(format!("getFileHashData row: {e}")))?;
            if mtime > max_mtime {
                max_mtime = mtime;
            }
            rows.push(FileHashRow {
                file,
                hash,
                mtime,
                size,
            });
        }
        Ok(FileHashData {
            exists: true,
            rows,
            max_mtime,
        })
    }

    /// Check pending analysis tables: returns counts for cfg_blocks and dataflow.
    /// Tables that don't exist return -1 (distinguishes "missing" from "empty").
    #[napi]
    pub fn check_pending_analysis(&self) -> napi::Result<PendingAnalysisCounts> {
        let conn = self.conn()?;
        let cfg_count = if has_table(conn, "cfg_blocks") {
            conn.query_row("SELECT COUNT(*) FROM cfg_blocks", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(-1)
        } else {
            -1
        };
        let dataflow_count = if has_table(conn, "dataflow") {
            conn.query_row("SELECT COUNT(*) FROM dataflow", [], |r| r.get::<_, i64>(0))
                .unwrap_or(-1)
        } else {
            -1
        };
        Ok(PendingAnalysisCounts {
            cfg_count,
            dataflow_count,
        })
    }

    /// Batch upsert file_hashes for metadata healing (mtime/size only updates).
    #[napi]
    pub fn heal_file_metadata(&self, entries: Vec<FileHashEntry>) -> napi::Result<u32> {
        if entries.is_empty() {
            return Ok(0);
        }
        let conn = self.conn()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| napi::Error::from_reason(format!("heal tx failed: {e}")))?;
        let mut count = 0u32;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| napi::Error::from_reason(format!("heal prepare failed: {e}")))?;
            for entry in &entries {
                stmt.execute(params![entry.file, entry.hash, entry.mtime, entry.size])
                    .map_err(|e| napi::Error::from_reason(format!("heal row failed: {e}")))?;
                count += 1;
            }
        }
        tx.commit()
            .map_err(|e| napi::Error::from_reason(format!("heal commit failed: {e}")))?;
        Ok(count)
    }

    /// Find files that have edges pointing to any of the changed files.
    /// Returns deduplicated list of reverse-dependency file paths.
    #[napi]
    pub fn find_reverse_dependencies(
        &self,
        changed_files: Vec<String>,
    ) -> napi::Result<Vec<String>> {
        if changed_files.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn()?;
        let changed_set: std::collections::HashSet<&str> =
            changed_files.iter().map(|s| s.as_str()).collect();
        let mut result_set: std::collections::HashSet<String> = std::collections::HashSet::new();

        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT n_src.file FROM edges e \
                 JOIN nodes n_src ON e.source_id = n_src.id \
                 JOIN nodes n_tgt ON e.target_id = n_tgt.id \
                 WHERE n_tgt.file = ?1 AND n_src.file != n_tgt.file AND n_src.kind != 'directory'",
            )
            .map_err(|e| napi::Error::from_reason(format!("reverseDeps prepare failed: {e}")))?;

        for file in &changed_files {
            let rows = stmt
                .query_map(params![file], |row| row.get::<_, String>(0))
                .map_err(|e| napi::Error::from_reason(format!("reverseDeps query failed: {e}")))?;
            for dep_file in rows.flatten() {
                if !changed_set.contains(dep_file.as_str()) {
                    result_set.insert(dep_file);
                }
            }
        }
        let mut result_vec: Vec<String> = result_set.into_iter().collect();
        result_vec.sort_unstable();
        Ok(result_vec)
    }

    /// Get node and edge counts in a single napi call.
    #[napi]
    pub fn get_finalize_counts(&self) -> napi::Result<FinalizeCounts> {
        let conn = self.conn()?;
        let node_count = conn
            .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0);
        let edge_count = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0);
        Ok(FinalizeCounts {
            node_count,
            edge_count,
        })
    }

    /// Run all advisory checks in a single napi call (orphaned embeddings,
    /// stale embeddings, unused exports). Only called on full builds.
    #[napi]
    pub fn run_advisory_checks(&self, has_embeddings: bool) -> napi::Result<AdvisoryCheckResult> {
        let conn = self.conn()?;
        let mut result = AdvisoryCheckResult {
            orphaned_embeddings: 0,
            embed_built_at: None,
            unused_exports: 0,
        };

        if has_embeddings {
            // Orphaned embeddings
            result.orphaned_embeddings = conn
                .query_row(
                    "SELECT COUNT(*) FROM embeddings WHERE node_id NOT IN (SELECT id FROM nodes)",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0);

            // Stale embeddings
            result.embed_built_at = conn
                .query_row(
                    "SELECT value FROM embedding_meta WHERE key = 'built_at'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok();
        }

        // Unused exports
        result.unused_exports = conn
            .query_row(
                "SELECT COUNT(*) FROM nodes \
                 WHERE exported = 1 AND kind != 'file' \
                 AND id NOT IN ( \
                   SELECT DISTINCT e.target_id FROM edges e \
                   JOIN nodes caller ON e.source_id = caller.id \
                   JOIN nodes target ON e.target_id = target.id \
                   WHERE e.kind = 'calls' AND caller.file != target.file \
                 )",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0);

        Ok(result)
    }

    /// Get file_hashes count and all file paths in a single napi call.
    /// Used by the fast-collect path in collect-files stage.
    #[napi]
    pub fn get_collect_files_data(&self) -> napi::Result<CollectFilesData> {
        let conn = self.conn()?;
        if !has_table(conn, "file_hashes") {
            return Ok(CollectFilesData {
                count: 0,
                files: vec![],
            });
        }
        let mut stmt = conn
            .prepare_cached("SELECT file FROM file_hashes")
            .map_err(|e| napi::Error::from_reason(format!("collectFiles prepare failed: {e}")))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| napi::Error::from_reason(format!("collectFiles query failed: {e}")))?;
        let files: Vec<String> = rows.filter_map(|r| r.ok()).collect();
        let count = files.len() as i64;
        Ok(CollectFilesData { count, files })
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
        if files.is_empty() && reverse_dep_files.as_ref().is_none_or(|v| v.is_empty()) {
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
            // Delete dataflow rows that reference edges touching this file via call_edge_id
            // BEFORE deleting those edges — dataflow.call_edge_id REFERENCES edges(id)
            // causes SQLITE_CONSTRAINT_FOREIGNKEY if edges are deleted first.
            ("DELETE FROM dataflow WHERE call_edge_id IN (SELECT id FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1))", false),
            ("DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1) OR target_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            // dataflow rows linked via vertex FK (v18+ schemas).
            ("DELETE FROM dataflow WHERE source_vertex IN (SELECT id FROM dataflow_vertices WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1)) OR target_vertex IN (SELECT id FROM dataflow_vertices WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1))", false),
            ("DELETE FROM dataflow_summary WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
            ("DELETE FROM dataflow_vertices WHERE func_id IN (SELECT id FROM nodes WHERE file = ?1)", false),
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
        // Clear dataflow rows referencing those outgoing edges via call_edge_id first
        // to satisfy the FK constraint: dataflow.call_edge_id REFERENCES edges(id).
        if let Some(ref rev_files) = reverse_dep_files {
            let dfcall_sql = "DELETE FROM dataflow WHERE call_edge_id IN \
                (SELECT id FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1))";
            let edge_sql =
                "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?1)";
            for file in rev_files {
                // Optional — column absent in pre-v18 schemas; ignore errors.
                let _ = tx.execute(dfcall_sql, params![file]);
                tx.execute(edge_sql, params![file]).map_err(|e| {
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

// ── Full Rust build orchestration ───────────────────────────────────────

#[napi]
impl NativeDatabase {
    /// Run the full build pipeline in Rust — zero napi boundary crossings
    /// after this call. Returns a JSON string with timing and result data.
    ///
    /// The JS caller falls back to `runPipelineStages()` when this method
    /// is unavailable or throws.
    #[napi]
    pub fn build_graph(
        &self,
        root_dir: String,
        config_json: String,
        aliases_json: String,
        opts_json: String,
        // Monorepo workspace packages (JSON array of `WorkspacePackage`),
        // detected on the JS side by `detectWorkspaces()` — see
        // `resolve::resolve_via_workspace`'s doc comment (issue #1927).
        // `Option` for compatibility with older JS callers built against a
        // pre-#1927 native binary that never passes this argument.
        workspaces_json: Option<String>,
    ) -> napi::Result<String> {
        let conn = self.conn()?;
        let workspaces_json = workspaces_json.unwrap_or_default();
        let db_path = self.db_path();
        let result = crate::domain::graph::builder::pipeline::run_pipeline(
            conn,
            &root_dir,
            &db_path,
            &config_json,
            &aliases_json,
            &opts_json,
            &workspaces_json,
        )
        .map_err(|e| napi::Error::from_reason(format!("build_graph failed: {e}")))?;
        serde_json::to_string(&result)
            .map_err(|e| napi::Error::from_reason(format!("result serialization failed: {e}")))
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

/// Convert a single rusqlite cell read result to a serde_json::Value.
///
/// **Contract**: Only Integer, Real, Text, and Null column types are supported.
/// BLOB columns are mapped to `null` because the current codegraph schema has no
/// BLOB columns and the generic query path is not designed for binary data.
/// Cell-level read errors are also mapped to `null` to avoid partial-row/partial-value
/// failures. Shared by `row_to_json` (per-column) and `pragma` (single scalar result).
fn value_ref_to_json(value: rusqlite::Result<ValueRef<'_>>) -> serde_json::Value {
    match value {
        Ok(ValueRef::Integer(n)) => serde_json::json!(n),
        Ok(ValueRef::Real(f)) => serde_json::json!(f),
        Ok(ValueRef::Text(s)) => serde_json::Value::String(String::from_utf8_lossy(s).into_owned()),
        Ok(ValueRef::Null) => serde_json::Value::Null,
        // BLOB: no codegraph schema columns use BLOB; map to null (see contract above)
        Ok(ValueRef::Blob(_)) => serde_json::Value::Null,
        // Cell read error: map to null to avoid partial-row/partial-value failures
        Err(_) => serde_json::Value::Null,
    }
}

/// Convert a rusqlite row to a serde_json::Value object. See `value_ref_to_json`'s
/// contract doc for supported column types.
fn row_to_json(
    row: &rusqlite::Row<'_>,
    col_count: usize,
    col_names: &[String],
) -> serde_json::Value {
    let mut map = serde_json::Map::with_capacity(col_count);
    for (i, name) in col_names.iter().enumerate().take(col_count) {
        map.insert(name.clone(), value_ref_to_json(row.get_ref(i)));
    }
    serde_json::Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression for #2015: a database whose schema was initialized purely
    /// through the native `init_schema()` must end up with
    /// `nodes.content_hash` — needed by reverse-dep-edge reconnection to
    /// disambiguate a same-named/same-kind sibling group where one member
    /// was renamed away and a different one added in the same edit (a
    /// net-zero group-size change the prior line-alignment-only heuristic
    /// cannot distinguish from "same declaration, shifted").
    #[test]
    fn init_schema_adds_nodes_content_hash_column() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema().expect("init_schema should succeed");

        let conn = db.conn().expect("connection should still be open");
        let mut stmt = conn.prepare("PRAGMA table_info(nodes)").unwrap();
        let has_content_hash = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .any(|name| name == "content_hash");

        assert!(
            has_content_hash,
            "nodes.content_hash column missing after native-only init_schema()"
        );
    }

    /// Regression for #2015, mirroring the #2001/#2066 pattern: a
    /// native-only database already stamped past v24 (e.g. by a future
    /// migration added without content_hash ever having been applied) must
    /// still be repaired by the unconditional legacy-column backfill, not
    /// just the version-gated migration. Stamps to the current max computed
    /// from `MIGRATIONS` itself (not a hardcoded literal — see the
    /// dynamic_kind repair test's doc comment for why a hardcoded version
    /// number silently goes stale as soon as a later migration is added).
    #[test]
    fn init_schema_repairs_nodes_content_hash_on_a_database_already_past_v24() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema()
            .expect("initial init_schema should succeed");

        let max_version = MIGRATIONS.iter().map(|m| m.version).max().unwrap();
        {
            let conn = db.conn().expect("connection should still be open");
            conn.execute_batch(&format!(
                "ALTER TABLE nodes DROP COLUMN content_hash; \
                 UPDATE schema_version SET version = {max_version};"
            ))
            .expect("simulating the pre-fix state should succeed");
            assert!(
                !has_column(conn, "nodes", "content_hash"),
                "test setup failed: content_hash should be absent after the simulated drop"
            );
        }

        db.init_schema()
            .expect("repair init_schema call should succeed");
        let conn = db.conn().expect("connection should still be open");
        assert!(
            has_column(conn, "nodes", "content_hash"),
            "nodes.content_hash was not repaired for a database already stamped past v24"
        );
    }

    /// Regression for #2001/#2066: a database whose schema was initialized
    /// purely through the native `init_schema()` (never touched by the TS
    /// `initSchema()` in src/db/migrations.ts) must still end up with
    /// `edges.dynamic_kind` — migration v20 was missing from Rust's
    /// `MIGRATIONS` array entirely, so `do_insert_edges`'s unconditional
    /// `dynamic_kind` column reference would fail with "no such column" on
    /// any DB that only ever ran the native migration path.
    #[test]
    fn init_schema_adds_edges_dynamic_kind_column() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema().expect("init_schema should succeed");

        let conn = db.conn().expect("connection should still be open");
        let mut stmt = conn.prepare("PRAGMA table_info(edges)").unwrap();
        let has_dynamic_kind = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .any(|name| name == "dynamic_kind");

        assert!(
            has_dynamic_kind,
            "edges.dynamic_kind column missing after native-only init_schema()"
        );
    }

    /// Regression for the Greptile-flagged gap in #2001's initial fix: a
    /// native-only database that was ALREADY migrated past v20 by the
    /// pre-fix `MIGRATIONS` array (which jumped straight from v19 to v21,
    /// never applying v20) has `schema_version >= 21` stored — so the
    /// version-gated `migration.version > current_version` check skips v20
    /// forever on every later `init_schema()` call, even after v20 is added
    /// to the array. Only the unconditional, reality-checked legacy-column
    /// backfill (not the version-gated migration itself) can repair an
    /// already-affected database. Simulates that exact prior-bug state by
    /// stamping schema_version to the current max (computed from `MIGRATIONS`
    /// itself, not hardcoded — a hardcoded literal silently drifts stale
    /// every time a later migration is added, spuriously re-attempting that
    /// migration and failing on a column that already exists, exactly as
    /// happened here when v24 was added after this test was written) and
    /// dropping dynamic_kind back out before re-running init_schema().
    #[test]
    fn init_schema_repairs_edges_dynamic_kind_on_a_database_already_past_v20() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema()
            .expect("initial init_schema should succeed");

        let max_version = MIGRATIONS.iter().map(|m| m.version).max().unwrap();
        {
            let conn = db.conn().expect("connection should still be open");
            // Simulate the pre-fix native-only end state: schema stamped past
            // v20, but the column itself never actually got added. #2072's
            // v28 added a second index over the same column
            // (idx_edges_content_unique) — SQLite refuses to DROP COLUMN
            // while any index still references it, so both must be dropped
            // first, exactly as a real pre-fix database (which predates both
            // indexes) would never have had either one to begin with.
            conn.execute_batch(&format!(
                "DROP INDEX IF EXISTS idx_edges_dynamic_kind; \
                 DROP INDEX IF EXISTS idx_edges_content_unique; \
                 ALTER TABLE edges DROP COLUMN dynamic_kind; \
                 UPDATE schema_version SET version = {max_version};"
            ))
            .expect("simulating the pre-fix state should succeed");
            assert!(
                !has_column(conn, "edges", "dynamic_kind"),
                "test setup failed: dynamic_kind should be absent after the simulated drop"
            );
        }

        db.init_schema()
            .expect("repair init_schema call should succeed");

        let conn = db.conn().expect("connection should still be open");
        assert!(
            has_column(conn, "edges", "dynamic_kind"),
            "edges.dynamic_kind was not repaired for a database already stamped past v20"
        );
    }

    /// #1996: a database built before migration v26 existed may have
    /// persisted `technique = 'cha-expanded'` edges from the CHA-expansion
    /// post-pass's old self-exclusion convention. Because the incremental
    /// rebuild's seen-pair dedup guard means such an edge would otherwise
    /// never be re-emitted (and thus never relabeled) once its pair already
    /// exists, v26's one-time backfill is the only way an existing database
    /// converges on the uniform 'cha' label without a full rebuild.
    #[test]
    fn init_schema_relabels_legacy_cha_expanded_edges_on_a_database_already_past_v25() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema()
            .expect("initial init_schema should succeed");

        {
            let conn = db.conn().expect("connection should still be open");
            conn.execute_batch(
                "INSERT INTO nodes (name, kind, file, line) VALUES ('a', 'function', 'a.ts', 1), ('b', 'method', 'b.ts', 2); \
                 INSERT INTO edges (source_id, target_id, kind, confidence, dynamic, technique) \
                   SELECT (SELECT id FROM nodes WHERE name = 'a'), (SELECT id FROM nodes WHERE name = 'b'), \
                          'calls', 0.8, 0, 'cha-expanded'; \
                 UPDATE schema_version SET version = 25;",
            )
            .expect("simulating a pre-v26 database with a legacy edge should succeed");
            // #2030 added migration v27 (a non-idempotent `ALTER TABLE ... ADD
            // COLUMN`) after this test was written. Stamping schema_version
            // back to 25 below replays every migration after it — including
            // v27 — on the SECOND init_schema() call; the first call above
            // already added `accessor_kind` once, so replaying v27 without
            // also undoing it would hit "duplicate column name" (exactly the
            // staleness failure mode the dynamic_kind/content_hash repair
            // tests' doc comments already warn about). Drop it back out here,
            // mirroring how those tests drop their own non-idempotent column
            // before re-stamping.
            conn.execute_batch(
                "DROP INDEX IF EXISTS idx_nodes_accessor_kind; \
                 ALTER TABLE nodes DROP COLUMN accessor_kind;",
            )
            .expect("simulating the pre-v27 state should succeed");
        }

        db.init_schema()
            .expect("repair init_schema call should succeed");

        let conn = db.conn().expect("connection should still be open");
        let technique: String = conn
            .query_row(
                "SELECT technique FROM edges WHERE kind = 'calls'",
                [],
                |row| row.get(0),
            )
            .expect("the edge inserted above should still exist");
        assert_eq!(
            technique, "cha",
            "legacy 'cha-expanded' edge was not relabeled 'cha' by migration v26"
        );
    }

    /// #2072: `edges` never had a constraint backing the `INSERT OR IGNORE`
    /// dedup several nearby comments claimed happened. Migration v28 adds a
    /// real one — this proves it actually rejects duplicate content instead
    /// of merely being present in the schema.
    #[test]
    fn migration_v28_deduplicates_calls_edges_on_insert() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema().expect("init_schema should succeed");
        let conn = db.conn().expect("connection should still be open");

        conn.execute_batch(
            "INSERT INTO nodes (name, kind, file, line) VALUES ('a', 'function', 'a.ts', 1), ('b', 'function', 'b.ts', 1);",
        )
        .expect("node setup should succeed");

        for _ in 0..3 {
            conn.execute_batch(
                "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) \
                 SELECT (SELECT id FROM nodes WHERE name = 'a'), (SELECT id FROM nodes WHERE name = 'b'), \
                        'calls', 0.9, 0;",
            )
            .expect("repeated insert of identical edge content should not error");
        }

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM edges WHERE kind = 'calls'",
                [],
                |row| row.get(0),
            )
            .expect("count query should succeed");
        assert_eq!(
            count, 1,
            "three inserts of byte-identical edge content should collapse to one row now \
             that idx_edges_content_unique backs OR IGNORE"
        );
    }

    /// #2072/#1844: `idx_edges_content_unique`'s key includes confidence and
    /// dynamic precisely so this keeps working — `graph/cycles.ts`'s
    /// speculative-cycle classification relies on being able to hold two
    /// edges between the very same (source_id, target_id, kind='calls') pair
    /// at once: one confirmed direct call and one independent low-confidence
    /// dynamic guess. A narrower key (e.g. just source/target/kind) would
    /// silently collapse this pair down to one row and break that
    /// classification — see `tests/graph/cycles.test.ts`'s "treats a node
    /// pair as confirmed if any edge between them is non-speculative, even
    /// with a duplicate speculative edge" for the TS-side pin of the same
    /// invariant.
    #[test]
    fn migration_v28_keeps_confirmed_and_speculative_calls_edges_distinct() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema().expect("init_schema should succeed");
        let conn = db.conn().expect("connection should still be open");

        conn.execute_batch(
            "INSERT INTO nodes (name, kind, file, line) VALUES ('a', 'function', 'a.ts', 1), ('b', 'function', 'b.ts', 1);",
        )
        .expect("node setup should succeed");

        conn.execute_batch(
            // One confirmed direct call (confidence=1.0, dynamic=0) and one
            // independent low-confidence dynamic guess (confidence=0.3,
            // dynamic=1) for the SAME (source, target, kind) pair.
            "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) \
             SELECT (SELECT id FROM nodes WHERE name = 'a'), (SELECT id FROM nodes WHERE name = 'b'), 'calls', 1.0, 0; \
             INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) \
             SELECT (SELECT id FROM nodes WHERE name = 'a'), (SELECT id FROM nodes WHERE name = 'b'), 'calls', 0.3, 1;",
        )
        .expect("a confirmed edge and a speculative edge for the same pair should both insert");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM edges WHERE kind = 'calls'",
                [],
                |row| row.get(0),
            )
            .expect("count query should succeed");
        assert_eq!(
            count, 2,
            "a confirmed edge and a speculative edge between the same (source, target, kind) \
             pair must not be collapsed by idx_edges_content_unique"
        );
    }

    /// #2072: the content key backing `idx_edges_content_unique` is
    /// (source_id, target_id, kind, dynamic_kind) — not just
    /// (source_id, target_id, kind). Flag-only dynamic calls with no
    /// resolved target emit "sink" edges (kind='calls', target=the file
    /// node) distinguished only by `dynamic_kind`; `seen_sink_edges` in
    /// build_edges.rs already treats two different dynamic_kind values
    /// targeting the same file as distinct edges, so the DB constraint must
    /// not collapse them or it would silently drop real dynamic-call
    /// classifications.
    #[test]
    fn migration_v28_keeps_sink_edges_with_different_dynamic_kind_distinct() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");
        db.init_schema().expect("init_schema should succeed");
        let conn = db.conn().expect("connection should still be open");

        conn.execute_batch(
            "INSERT INTO nodes (name, kind, file, line) VALUES ('caller', 'function', 'a.ts', 1), ('a.ts', 'file', 'a.ts', 0);",
        )
        .expect("node setup should succeed");

        conn.execute_batch(
            "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic, dynamic_kind) \
             SELECT (SELECT id FROM nodes WHERE name = 'caller'), (SELECT id FROM nodes WHERE name = 'a.ts' AND kind = 'file'), \
                    'calls', 0.0, 1, 'reflection'; \
             INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic, dynamic_kind) \
             SELECT (SELECT id FROM nodes WHERE name = 'caller'), (SELECT id FROM nodes WHERE name = 'a.ts' AND kind = 'file'), \
                    'calls', 0.0, 1, 'value-ref';",
        )
        .expect("two sink edges with different dynamic_kind should both insert");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM edges WHERE kind = 'calls'",
                [],
                |row| row.get(0),
            )
            .expect("count query should succeed");
        assert_eq!(
            count, 2,
            "sink edges to the same file with distinct dynamic_kind must not be collapsed by \
             idx_edges_content_unique"
        );
    }

    /// #2072: if a database somehow already has duplicate edge content
    /// before upgrading (none are expected in practice, given the
    /// purge-before-insert protection every insert path relies on — but the
    /// migration must be safe regardless), v28's DELETE must clear them
    /// before CREATE UNIQUE INDEX runs, keeping the lowest id per group
    /// rather than failing the whole migration.
    #[test]
    fn migration_v28_deletes_pre_existing_duplicate_edges_before_indexing() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");

        // Stamp the DB at v27 (pre-v28) and hand-insert duplicate content
        // directly, bypassing OR IGNORE, so the migration must contend with
        // rows that already violate the constraint it's about to add.
        conn_at_v27_with_duplicate_edges(&db);

        db.init_schema()
            .expect("migration v28 should tolerate pre-existing duplicate content");

        let conn = db.conn().expect("connection should still be open");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM edges WHERE kind = 'calls'",
                [],
                |row| row.get(0),
            )
            .expect("count query should succeed");
        assert_eq!(
            count, 1,
            "pre-existing duplicate edge content should be deduplicated by v28's DELETE, \
             keeping exactly one row"
        );

        let min_id: i64 = conn
            .query_row(
                "SELECT MIN(id) FROM edges WHERE kind = 'calls'",
                [],
                |row| row.get(0),
            )
            .expect("min id query should succeed");
        let surviving_id: i64 = conn
            .query_row("SELECT id FROM edges WHERE kind = 'calls'", [], |row| {
                row.get(0)
            })
            .expect("surviving row id query should succeed");
        assert_eq!(
            surviving_id, min_id,
            "the surviving row should be the lowest-id duplicate"
        );
    }

    /// Shared setup for [`migration_v28_deletes_pre_existing_duplicate_edges_before_indexing`]:
    /// a database stamped at v27 with two identical-content `calls` edges
    /// already present, simulating a pre-v28 database that (hypothetically)
    /// accumulated duplicate content before this migration existed.
    fn conn_at_v27_with_duplicate_edges(db: &NativeDatabase) {
        db.init_schema()
            .expect("initial init_schema should succeed");
        let conn = db.conn().expect("connection should still be open");
        conn.execute_batch(
            // idx_edges_content_unique must be dropped BEFORE the duplicate
            // inserts below, not after — it already exists at this point
            // (the init_schema() call above ran the full up-to-date
            // MIGRATIONS set, v28 included, on this fresh database) and
            // would otherwise reject the second identical-content insert
            // immediately, defeating the simulation.
            // Both duplicate rows use the SAME confidence/dynamic (0.9/0) —
            // the content key is every non-id column, so a difference in
            // confidence would make these legitimately distinct edges (see
            // the v28 migration's own comment on graph/cycles.ts's
            // speculative-cycle classification) rather than the true
            // byte-identical duplicate this test means to simulate.
            "DROP INDEX IF EXISTS idx_edges_content_unique; \
             INSERT INTO nodes (name, kind, file, line) VALUES ('a', 'function', 'a.ts', 1), ('b', 'function', 'b.ts', 1); \
             INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) \
               SELECT (SELECT id FROM nodes WHERE name = 'a'), (SELECT id FROM nodes WHERE name = 'b'), 'calls', 0.9, 0; \
             INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) \
               SELECT (SELECT id FROM nodes WHERE name = 'a'), (SELECT id FROM nodes WHERE name = 'b'), 'calls', 0.9, 0; \
             UPDATE schema_version SET version = 27;",
        )
        .expect("simulating a pre-v28 database with duplicate edge content should succeed");
    }

    // ── pragma() (#2019) ─────────────────────────────────────────────────

    /// Regression for #2019: `pragma()` hardcoded a `String` read of the
    /// result column, so any PRAGMA whose result has INTEGER affinity (the
    /// overwhelming majority — `busy_timeout`, `page_count`, `user_version`,
    /// `application_id`, `cache_size`, `mmap_size`, `wal_autocheckpoint`,
    /// etc.) threw "Invalid column type Integer" instead of returning the
    /// value. Only TEXT-affinity pragmas like `journal_mode` happened to work.
    #[test]
    fn pragma_returns_integer_affinity_results_instead_of_throwing() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");

        let busy_timeout = db
            .pragma("busy_timeout".to_string())
            .expect("pragma('busy_timeout') should not throw");
        // open_read_write applies DEFAULT_BUSY_TIMEOUT_MS (5000) when none is given.
        assert_eq!(
            busy_timeout,
            Some(serde_json::json!(DEFAULT_BUSY_TIMEOUT_MS))
        );

        let page_count = db
            .pragma("page_count".to_string())
            .expect("pragma('page_count') should not throw");
        assert_eq!(page_count, Some(serde_json::json!(0)));

        let user_version = db
            .pragma("user_version".to_string())
            .expect("pragma('user_version') should not throw");
        assert_eq!(user_version, Some(serde_json::json!(0)));
    }

    #[test]
    fn pragma_still_returns_text_affinity_results() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");

        let journal_mode = db
            .pragma("journal_mode".to_string())
            .expect("pragma('journal_mode') should not throw");
        // In-memory databases report journal_mode as "memory".
        assert_eq!(journal_mode, Some(serde_json::json!("memory")));
    }

    #[test]
    fn pragma_returns_none_when_the_pragma_produces_no_output() {
        let db = NativeDatabase::open_read_write(":memory:".to_string(), None)
            .expect("open_read_write should succeed for :memory:");

        // wal_checkpoint on a non-WAL (in-memory) database is a valid,
        // side-effect-only pragma with no result row.
        let result = db
            .pragma("optimize".to_string())
            .expect("pragma('optimize') should not throw");
        assert_eq!(result, None);
    }
}
