import { debug } from '../infrastructure/logger.js';
import type { BetterSqlite3Database } from '../types.js';

// ─── Schema Migrations ─────────────────────────────────────────────────

interface Migration {
  version: number;
  up: string;
}

// IMPORTANT: Migration DDL is mirrored in crates/codegraph-core/src/db/connection.rs.
// Any changes here MUST be reflected there (and vice-versa).
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
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
    `,
  },
  {
    version: 2,
    up: `
      CREATE INDEX IF NOT EXISTS idx_nodes_name_kind_file ON nodes(name, kind, file);
      CREATE INDEX IF NOT EXISTS idx_nodes_file_kind ON nodes(file, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source_id, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target_id, kind);
    `,
  },
  {
    version: 3,
    up: `
      CREATE TABLE IF NOT EXISTS file_hashes (
        file TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    up: `ALTER TABLE file_hashes ADD COLUMN size INTEGER DEFAULT 0;`,
  },
  {
    version: 5,
    up: `
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
    `,
  },
  {
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS file_commit_counts (
        file TEXT PRIMARY KEY,
        commit_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 7,
    up: `
      CREATE TABLE IF NOT EXISTS build_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    up: `
      CREATE TABLE IF NOT EXISTS function_complexity (
        node_id INTEGER PRIMARY KEY,
        cognitive INTEGER NOT NULL,
        cyclomatic INTEGER NOT NULL,
        max_nesting INTEGER NOT NULL,
        FOREIGN KEY(node_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_fc_cognitive ON function_complexity(cognitive DESC);
      CREATE INDEX IF NOT EXISTS idx_fc_cyclomatic ON function_complexity(cyclomatic DESC);
    `,
  },
  {
    version: 9,
    up: `
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
    `,
  },
  {
    version: 10,
    up: `
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
    `,
  },
  {
    version: 11,
    up: `
      ALTER TABLE nodes ADD COLUMN parent_id INTEGER REFERENCES nodes(id);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind_parent ON nodes(kind, parent_id);
    `,
  },
  {
    version: 12,
    up: `
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
    `,
  },
  {
    version: 13,
    up: `
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
    `,
  },
  {
    version: 14,
    up: `
      ALTER TABLE nodes ADD COLUMN exported INTEGER DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_nodes_exported ON nodes(exported);
    `,
  },
  {
    version: 15,
    up: `
      ALTER TABLE nodes ADD COLUMN qualified_name TEXT;
      ALTER TABLE nodes ADD COLUMN scope TEXT;
      ALTER TABLE nodes ADD COLUMN visibility TEXT;
      UPDATE nodes SET qualified_name = name WHERE qualified_name IS NULL;
      CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
      CREATE INDEX IF NOT EXISTS idx_nodes_scope ON nodes(scope);
    `,
  },
  {
    version: 16,
    up: `
      CREATE INDEX IF NOT EXISTS idx_edges_kind_target ON edges(kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_kind_source ON edges(kind, source_id);
    `,
  },
  {
    version: 17,
    up: `
      ALTER TABLE edges ADD COLUMN technique TEXT;
      CREATE INDEX IF NOT EXISTS idx_edges_technique ON edges(technique);
    `,
  },
  {
    version: 18,
    up: `
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

      -- dataflow_fn exposes only vertex-linked (v18+) interprocedural flows.
      -- The INNER JOINs intentionally exclude pre-v18 rows where source_vertex
      -- and target_vertex are NULL — this is NOT a backward-compat replacement
      -- for querying the dataflow table directly; legacy consumers must continue
      -- to query dataflow directly to avoid silently dropping historical rows.
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
    `,
  },
  {
    version: 19,
    // P6 sentinel: forces a full rebuild so that databases built with the native
    // fast path (which skipped vertex extraction before P6) backfill
    // dataflow_vertices and dataflow_summary on the next `codegraph build`.
    up: `SELECT 1`,
  },
  {
    version: 20,
    up: `
      ALTER TABLE edges ADD COLUMN dynamic_kind TEXT;
      CREATE INDEX IF NOT EXISTS idx_edges_dynamic_kind ON edges(dynamic_kind) WHERE dynamic_kind IS NOT NULL;
    `,
  },
  {
    version: 21,
    up: `
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
    `,
  },
  {
    version: 22,
    up: `
      ALTER TABLE deleted_export_advisories ADD COLUMN consumer_kind TEXT;
    `,
  },
  {
    // dataflow.call_edge_id (added in v18, `REFERENCES edges(id)`) was never
    // given its own index — every DELETE FROM edges pays an O(dataflow-rows)
    // scan under better-sqlite3, which defaults `PRAGMA foreign_keys = ON`
    // (rusqlite/native never sets this pragma, so native never paid this
    // cost — this is WASM-only exposure, matching issue #1948's report).
    // Confirmed via EXPLAIN QUERY PLAN: without this index, deleting a
    // single file's edges triggers `SCAN dataflow` for both the explicit
    // `dataflowByCallEdge` cleanup query (build-stmts.ts) and SQLite's own
    // automatic FK-constraint check; with it, both become an indexed SEARCH.
    // Measured on this repo's own ~19.8K-node/~41.8K-edge graph: a 1-file
    // incremental purge dropped from 62ms to 1.47ms (97.6% reduction).
    version: 23,
    up: `
      CREATE INDEX IF NOT EXISTS idx_dataflow_call_edge ON dataflow(call_edge_id);
    `,
  },
  {
    // Per-declaration content hash (issue #2015): reverse-dep-edge
    // reconnection during incremental rebuilds previously matched siblings
    // by line position alone, which is provably unsafe when a same-named/
    // same-kind sibling group has one member renamed away and a different
    // one added in the same edit — the group's size stays unchanged, so the
    // line-alignment fast path matches by rank and can silently reconnect a
    // caller to the wrong declaration. A content hash gives reconnection a
    // true identity signal to try first, falling back to line alignment
    // only when a hash is unavailable (e.g. rows from before this
    // migration).
    version: 24,
    up: `
      ALTER TABLE nodes ADD COLUMN content_hash TEXT;
    `,
  },
  {
    // Persist barrel re-export rename pairs (issue #1967): `export { X as Y }
    // from '...'` records `{local: Y, imported: X}` alongside which file the
    // rename's own source resolves to. Populated by the full-build pipeline
    // (resolve-imports.ts) and both native paths whenever a barrel file is
    // (re)parsed, so `codegraph watch`'s single-file incremental rebuild
    // (resolveBarrelTarget, domain/graph/builder/incremental.ts) can
    // translate a consumer's requested external alias back to the name
    // actually declared in the reexport source without needing to re-parse
    // the barrel file itself in the same watch batch.
    version: 25,
    up: `
      CREATE TABLE IF NOT EXISTS reexport_renames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        barrel_file TEXT NOT NULL,
        local_name TEXT NOT NULL,
        imported_name TEXT NOT NULL,
        source_file TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reexport_renames_barrel ON reexport_renames(barrel_file, local_name);
    `,
  },
  {
    // One-time relabel (issue #1996): the CHA-expansion post-pass used to tag
    // its own output 'cha-expanded' to distinguish it from this/super-dispatch
    // edges ('cha') for a since-removed candidate-exclusion filter. Existing
    // databases built before this migration have persisted 'cha-expanded'
    // rows that an incremental rebuild's seen-pair dedup would otherwise leave
    // stale forever (the pair already exists, so no new edge — and no
    // relabeling — is ever emitted for it). Backfill them once here so every
    // database converges on the uniform 'cha' label without requiring a full
    // rebuild.
    version: 26,
    up: `
      UPDATE edges SET technique = 'cha' WHERE technique = 'cha-expanded';
    `,
  },
  {
    // Cross-file ES6 getter/setter accessor recognition (issue #2030, follow-up
    // to #1893). #1893's same-file accessor registry could confirm a bare
    // property read (`obj.prop`, no call parens) really targets a `get`/`set`
    // accessor — not a plain method/field sharing the name — using only
    // in-file knowledge, so it needed no DB column. Recognizing the same
    // pattern when the accessor's class is declared in a *different* file
    // requires a global (whole-build) accessor registry, which in turn needs
    // each accessor's kind persisted on its own node so resolution can filter
    // candidates by exact kind match rather than guessing. Set only on
    // `method`-kind nodes that are ES6 get/set accessors; NULL for everything
    // else. Mirrored in crates/codegraph-core/src/db/connection.rs.
    version: 27,
    up: `
      ALTER TABLE nodes ADD COLUMN accessor_kind TEXT;
      CREATE INDEX IF NOT EXISTS idx_nodes_accessor_kind ON nodes(accessor_kind) WHERE accessor_kind IS NOT NULL;
    `,
  },
  {
    // Content-level uniqueness for `edges` (issue #2072): every edge-insertion
    // call site relies on `INSERT OR IGNORE` to silently drop duplicate-content
    // rows, and several nearby comments assert that's exactly what happens —
    // but unlike `nodes` (real UNIQUE(name, kind, file, line), see v1 above),
    // `edges` never had a constraint backing that assumption. `OR IGNORE` was
    // therefore dead/misleading code: safe today only because every insert
    // path is guarded elsewhere by a purge-before-insert pattern (full builds
    // wipe `edges` first; incremental builds delete-then-reinsert per changed
    // file), not because SQLite was actually deduping anything. A future
    // change that narrows or skips that purge step would silently start
    // producing duplicate/mixed edge rows with nothing to catch it — and (as
    // discovered while building this migration — see below) at least one
    // real path already does, independent of any purge-step regression.
    //
    // The content key is EVERY non-id column — (source_id, target_id, kind,
    // confidence, dynamic, dynamic_kind, technique) — not the narrower
    // (source_id, target_id, kind) the issue first suggested. That narrower
    // key looks right until `graph/cycles.ts`'s speculative-cycle
    // classification (issue #1844): two edges between the very same
    // (source_id, target_id, kind='calls') pair can be legitimate at once —
    // one confirmed direct call and one independent low-confidence dynamic
    // guess — distinguished ONLY by `confidence`/`dynamic`
    // (`buildLabelEdges`'s doc comment spells this out, and
    // `tests/graph/cycles.test.ts` pins it down). A constraint narrower than
    // "every column" would silently collapse that pair down to one row and
    // break speculative-vs-confirmed classification. Similarly, flag-only
    // dynamic calls with no resolved target emit a "sink" edge (kind='calls',
    // target=the file node) distinguished only by `dynamic_kind` (e.g.
    // 'reflection' vs 'value-ref') — the in-memory `seenCallEdges`/
    // `seen_sink_edges` dedup in build-edges.ts/build_edges.rs already treats
    // both dimensions as part of an edge's identity, so the DB constraint
    // must match or it would wrongly collapse genuinely distinct edges.
    // `dynamic_kind` and `technique` are NULL far more often than not, and
    // SQL UNIQUE treats every NULL as distinct from every other NULL, so
    // both are wrapped in COALESCE(..., '') — otherwise the constraint would
    // enforce nothing for the common NULL case, defeating the point of
    // adding it. `confidence`/`dynamic`/`kind` need no such wrapping: they're
    // NOT NULL (dynamic and kind always; confidence defaults to 1.0 and every
    // insert call site sets it explicitly).
    //
    // That "every column" key is exactly what genuinely duplicate content
    // means, and it caught a real bug during development of this migration:
    // `emitEdgesForImport` (build-edges.ts) and `emit_edges_for_import`
    // (import_edges.rs) push an identical file-level import/reexport/
    // dynamic-import edge once per *import statement*, not once per distinct
    // (file, target, kind) — so a file with two `import()`/`export {…} from`
    // statements resolving to the same target emits the same edge twice.
    // Rust's own insert path already used `INSERT OR IGNORE`, so it silently
    // absorbed the duplicate; the WASM path's `batchInsertEdges` used a plain
    // `INSERT`, so it just accumulated duplicate rows forever (harmless
    // bloat, until this migration's new constraint turned it into a hard
    // UNIQUE-constraint failure — see the `OR IGNORE` fix in
    // `builder/helpers.ts`'s `getEdgeStmt` and `graph/watcher.ts`'s
    // `insertEdge`, both updated alongside this migration for exactly that
    // reason). The redundant computation itself is a separate, tracked
    // cleanup (issue #2297) — out of scope here since `OR IGNORE` + this
    // constraint already make the persisted result correct.
    //
    // The DELETE runs first so this migration can never fail on a database
    // that happens to have accumulated duplicate content rows already (ties
    // are broken by keeping the lowest id). Mirrored in
    // crates/codegraph-core/src/db/connection.rs.
    version: 28,
    up: `
      DELETE FROM edges WHERE id NOT IN (
        SELECT MIN(id) FROM edges
        GROUP BY source_id, target_id, kind, confidence, dynamic, COALESCE(dynamic_kind, ''), COALESCE(technique, '')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_content_unique
        ON edges(source_id, target_id, kind, confidence, dynamic, COALESCE(dynamic_kind, ''), COALESCE(technique, ''));
    `,
  },
  {
    // #2087: durable, per-file record of every property/method name ever
    // invoked via member-call syntax (`x.name(...)`) — the "one hop further"
    // liveness evidence #1895's object-literal-property value-ref check
    // needs (collectInvokedPropertyNames / collect_invoked_property_names).
    // A full build sees every file at once, so it was always exact; a
    // `codegraph watch` single-file incremental rebuild
    // (domain/graph/builder/incremental.ts) only sees the one file being
    // rebuilt, so a consumer's `.resolve(...)` call living in an untouched
    // file was invisible and a same-named object-literal property in the
    // rebuilt file could be misclassified as dead. Persisting this table
    // once per full or incremental build (both engines — the native
    // orchestrator mirrors this via
    // import_edges::persist_invoked_property_names in Rust) gives the
    // incremental path a durable, whole-graph view to query instead of only
    // the current file's own evidence.
    //
    // Deletes and re-inserts per file so a file whose invoked names changed
    // (or were removed entirely) never leaves stale rows behind for it.
    version: 29,
    up: `
      CREATE TABLE IF NOT EXISTS invoked_property_names (
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (file, name)
      );
      CREATE INDEX IF NOT EXISTS idx_invoked_property_names_name ON invoked_property_names(name);
    `,
  },
  {
    // #2138: durable, per-file record of every function/method's inferred
    // return type — needed so cross-file return-type propagation
    // (propagateReturnTypesAcrossFiles / propagate_return_types_across_files)
    // can resolve `const x = importedFactory(); x.method()`-shaped dispatch
    // to a file this build never re-parsed.
    //
    // Without this, an incremental build that re-parses a barrel-adjacent
    // file (Stage 6b) wipes that file's outgoing calls/receiver edges and
    // re-derives them from an in-memory return-type index built only from
    // *this build's* file set — so a factory/getter defined in an untouched
    // file (e.g. `getWasmWorkerPool()` in wasm-worker-pool.ts) silently
    // drops out, and the edges it fed are lost until a full
    // `--no-incremental` rebuild. Persisting this table once per full or
    // incremental build (both engines — the native orchestrator mirrors this
    // via import_edges::persist_return_types in Rust) gives every build a
    // durable, whole-graph view for files it didn't itself parse.
    //
    // Deletes and re-inserts per file so a file whose return types changed
    // (or were removed) never leaves stale rows behind for it.
    version: 30,
    up: `
      CREATE TABLE IF NOT EXISTS return_types (
        file TEXT NOT NULL,
        fn_name TEXT NOT NULL,
        type_name TEXT NOT NULL,
        confidence REAL NOT NULL,
        PRIMARY KEY (file, fn_name)
      );
      CREATE INDEX IF NOT EXISTS idx_return_types_file ON return_types(file);
    `,
  },
  {
    // #2428: durable, per-file record of every call flagged as a program
    // entrypoint by the Python extractor — the `if __name__ == "__main__":`
    // guard and `__main__.py` module level (#2392).
    //
    // This is the *evidence*; `nodes.entrypoint` is a projection of it (see
    // `projectEntrypointAttribution`). Storing the evidence separately is
    // what makes the projection survivable, because the two have different
    // lifecycles: the evidence belongs to the guard's file, while the flag
    // sits on the target's node row, which is purged and re-inserted whenever
    // the *target's* file is rebuilt. #2411 wrote the flag directly from the
    // reparsed files' symbols, so any rebuild that touched only the target
    // (`codegraph build --incremental` after editing the callee, or
    // `codegraph watch` doing the same) silently dropped it — the guard's
    // file was not reparsed, so nothing re-marked it, even though the
    // guard's `calls` edge was still right there in the graph.
    //
    // Deletes and re-inserts per file (via the same purge path as
    // `invoked_property_names` / `return_types`) so a file whose guard was
    // edited away, or removed from disk entirely, leaves no stale evidence —
    // which is also what retires #2411's separate pre-purge clear step.
    version: 31,
    up: `
      CREATE TABLE IF NOT EXISTS entrypoint_calls (
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (file, name)
      );
    `,
  },
  {
    // #2088: durable, per-file record of (a) every object-literal allocation
    // site and whether it escapes, and (b) every `${siteKey}|${property}` pair
    // proven invoked through a correlated receiver. The durable counterpart of
    // the in-memory sets `buildCallEdgesJS` computes, for exactly the reason
    // `invoked_property_names` (v29 / #2087) exists: a scoped incremental build
    // narrows `ctx.fileSymbols` to changed files + reverse-deps, so a consumer
    // living in an untouched file would otherwise be invisible and its site's
    // properties misclassified dead.
    //
    // Deleted and re-inserted per file (see preparePurgeStmts) so a file whose
    // sites changed never leaves stale rows behind.
    version: 32,
    up: `
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
    `,
  },
];

interface PragmaColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function hasColumn(db: BetterSqlite3Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as PragmaColumnInfo[];
  return cols.some((c) => c.name === column);
}

function hasTable(db: BetterSqlite3Database, table: string): boolean {
  const row = db
    .prepare<{ '1': number }>("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  return !!row;
}

export function getBuildMeta(db: BetterSqlite3Database, key: string): string | null {
  if (!hasTable(db, 'build_meta')) return null;
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM build_meta WHERE key = ?')
      .get(key);
    return row ? row.value : null;
  } catch (e) {
    debug(`getBuildMeta failed for key "${key}": ${(e as Error).message}`);
    return null;
  }
}

export function setBuildMeta(
  db: BetterSqlite3Database,
  entries: Record<string, string | number>,
): void {
  const upsert = db.prepare('INSERT OR REPLACE INTO build_meta (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      upsert.run(key, String(value));
    }
  });
  tx();
}

/** Run numbered migrations that haven't been applied yet. */
function applyMigrations(db: BetterSqlite3Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)`);

  const row = db.prepare<{ version: number }>('SELECT version FROM schema_version').get();
  let currentVersion = row ? row.version : 0;

  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  }

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      debug(`Running migration v${migration.version}`);
      db.exec(migration.up);
      db.prepare('UPDATE schema_version SET version = ?').run(migration.version);
      currentVersion = migration.version;
    }
  }
}

/** Ensure columns and indexes exist for pre-migration DBs (legacy compat). */
function ensureLegacyColumns(db: BetterSqlite3Database): void {
  if (hasTable(db, 'nodes')) {
    ensureNodeColumns(db);
  }
  if (hasTable(db, 'edges')) {
    ensureEdgeColumns(db);
  }
  ensureEntrypointCallsColumns(db);
}

function ensureNodeColumns(db: BetterSqlite3Database): void {
  const missing = (col: string) => !hasColumn(db, 'nodes', col);
  if (missing('end_line')) db.exec('ALTER TABLE nodes ADD COLUMN end_line INTEGER');
  if (missing('role')) db.exec('ALTER TABLE nodes ADD COLUMN role TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role)');
  if (missing('parent_id'))
    db.exec('ALTER TABLE nodes ADD COLUMN parent_id INTEGER REFERENCES nodes(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_kind_parent ON nodes(kind, parent_id)');
  if (missing('qualified_name')) db.exec('ALTER TABLE nodes ADD COLUMN qualified_name TEXT');
  if (missing('scope')) db.exec('ALTER TABLE nodes ADD COLUMN scope TEXT');
  if (missing('visibility')) db.exec('ALTER TABLE nodes ADD COLUMN visibility TEXT');
  if (missing('content_hash')) db.exec('ALTER TABLE nodes ADD COLUMN content_hash TEXT');
  if (missing('accessor_kind')) db.exec('ALTER TABLE nodes ADD COLUMN accessor_kind TEXT');
  // #2392: program-entrypoint flag, set from an extractor-flagged call site
  // (Python's `if __name__ == "__main__":` guard and `__main__.py` module
  // level) so role classification can recognize entrypoints that the export
  // surface and path conventions cannot see. Added here rather than as a
  // numbered migration because a bare `ALTER TABLE ... ADD COLUMN` is not
  // replay-safe on a database stamped back to an earlier schema_version; this
  // block is idempotent and runs on every open. Mirrored in
  // crates/codegraph-core/src/db/connection.rs.
  if (missing('entrypoint')) db.exec('ALTER TABLE nodes ADD COLUMN entrypoint INTEGER DEFAULT 0');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_nodes_entrypoint ON nodes(entrypoint) WHERE entrypoint = 1',
  );
  // #2411 (review fix): the file whose call site attributed the current
  // `entrypoint` flag. A rebuild needs this to clear a stale flag when the
  // attributing call is deleted or renamed — re-deriving from live `calls`
  // edges doesn't work for a target declared in a *different* file than the
  // guard, because that edge is already purged (as part of reprocessing the
  // changed file) by the time the clear query would run. Reading this column
  // instead makes the clear correct regardless of the edge's lifecycle.
  // Mirrored in crates/codegraph-core/src/db/connection.rs.
  if (missing('entrypoint_source_file'))
    db.exec('ALTER TABLE nodes ADD COLUMN entrypoint_source_file TEXT');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_nodes_entrypoint_source_file ON nodes(entrypoint_source_file)',
  );
  // #2420: narrower than `entrypoint` — a target can be a live root
  // (`entrypoint = 1`, seeding reachability so it isn't downgraded as dead)
  // without also being the *label-worthy* program entrypoint for role
  // classification. `main(configure())` flags both `main` and `configure` as
  // `entrypoint` (neither should be silently treated as dead code — the
  // reachability side has no bug), but only `main` — the outermost call
  // whose target actually resolves in-repo — should classify as
  // `role: 'entry'`; `configure` keeps whatever role its own fan-in/fan-out
  // shape would otherwise give it. See `projectEntrypointAttribution`'s doc
  // comment for the wrapper-chain rule this column is set from. Mirrored in
  // crates/codegraph-core/src/db/connection.rs.
  if (missing('entrypoint_role'))
    db.exec('ALTER TABLE nodes ADD COLUMN entrypoint_role INTEGER DEFAULT 0');
  db.exec('UPDATE nodes SET qualified_name = name WHERE qualified_name IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_scope ON nodes(scope)');
}

function ensureEdgeColumns(db: BetterSqlite3Database): void {
  if (!hasColumn(db, 'edges', 'confidence'))
    db.exec('ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0');
  if (!hasColumn(db, 'edges', 'dynamic'))
    db.exec('ALTER TABLE edges ADD COLUMN dynamic INTEGER DEFAULT 0');
}

/**
 * #2420: the bare name of the call this evidence row's call is nested inside
 * (e.g. `'main'` for the `configure` evidence row from `main(configure())`),
 * or `NULL` for a top-level (unwrapped) entrypoint call. Added the same way
 * `entrypoint`/`entrypoint_source_file` were — an idempotent `ALTER TABLE`
 * here rather than a numbered migration, since `entrypoint_calls` itself was
 * only ever created via one (v31) and a bare `ALTER` is not replay-safe
 * against a schema_version already stamped past that point. Guarded on the
 * table existing for the same reason `backfillEntrypointEvidence` is: a
 * pre-v31 database reaches this function before migration v31 has run.
 * Mirrored in crates/codegraph-core/src/db/connection.rs.
 */
function ensureEntrypointCallsColumns(db: BetterSqlite3Database): void {
  if (!hasTable(db, 'entrypoint_calls')) return;
  if (!hasColumn(db, 'entrypoint_calls', 'wrapped_by'))
    db.exec('ALTER TABLE entrypoint_calls ADD COLUMN wrapped_by TEXT');
}

/**
 * Seed `entrypoint_calls` (#2428) from attribution a pre-v31 build already
 * wrote onto `nodes`, so upgrading a database does not lose it.
 *
 * `nodes.entrypoint` is a projection of `entrypoint_calls`. On a graph built
 * before v31 the flags exist but the evidence table does not, and migration
 * v31 creates it empty — at which point the very next partial rebuild would
 * project that empty table across the whole graph and clear every flag
 * contributed by a guard file it did not happen to reparse (review finding
 * on #2434). A full build is unaffected, since it reparses everything.
 *
 * Recording the *target's* name rather than the guard's original call name is
 * deliberate and sufficient: the projection matches `tgt.name = ec.name`
 * first, so this reproduces exactly the attribution already in the database.
 * The row is replaced with the real call name the first time that guard file
 * is reparsed, so the approximation never outlives one rebuild of its file.
 *
 * Runs after `ensureLegacyColumns` because `applyMigrations` (which precedes
 * it) cannot rely on `nodes.entrypoint` existing — that column is added by
 * the idempotent ensure-columns block, not by a numbered migration. Guarded
 * on the table being empty, which is both what makes it idempotent and what
 * keeps it from ever overwriting real evidence.
 *
 * Mirrored in `crates/codegraph-core/src/db/connection.rs`.
 */
function backfillEntrypointEvidence(db: BetterSqlite3Database): void {
  if (!hasTable(db, 'entrypoint_calls') || !hasTable(db, 'nodes')) return;
  if (!hasColumn(db, 'nodes', 'entrypoint_source_file')) return;
  if (db.prepare('SELECT 1 FROM entrypoint_calls LIMIT 1').get()) return;
  db.exec(
    `INSERT OR IGNORE INTO entrypoint_calls (file, name)
     SELECT entrypoint_source_file, name FROM nodes
     WHERE entrypoint = 1 AND entrypoint_source_file IS NOT NULL`,
  );
}

export function initSchema(db: BetterSqlite3Database): void {
  applyMigrations(db);
  ensureLegacyColumns(db);
  backfillEntrypointEvidence(db);
}
