import { debug } from '../infrastructure/logger.js';

// ─── Schema Migrations ─────────────────────────────────────────────────
export const MIGRATIONS = [
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
];

function hasColumn(db, table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some((c) => c.name === column);
}

function hasTable(db, table) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return !!row;
}

export function getBuildMeta(db, key) {
  if (!hasTable(db, 'build_meta')) return null;
  try {
    const row = db.prepare('SELECT value FROM build_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (e) {
    debug(`getBuildMeta failed for key "${key}": ${e.message}`);
    return null;
  }
}

export function setBuildMeta(db, entries) {
  const upsert = db.prepare('INSERT OR REPLACE INTO build_meta (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      upsert.run(key, String(value));
    }
  });
  tx();
}

export function initSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)`);

  const row = db.prepare('SELECT version FROM schema_version').get();
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

  // Legacy column compat — add columns that may be missing from pre-migration DBs
  if (hasTable(db, 'nodes')) {
    if (!hasColumn(db, 'nodes', 'end_line')) {
      db.exec('ALTER TABLE nodes ADD COLUMN end_line INTEGER');
    }
    if (!hasColumn(db, 'nodes', 'role')) {
      db.exec('ALTER TABLE nodes ADD COLUMN role TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role)');
    if (!hasColumn(db, 'nodes', 'parent_id')) {
      db.exec('ALTER TABLE nodes ADD COLUMN parent_id INTEGER REFERENCES nodes(id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_kind_parent ON nodes(kind, parent_id)');
    if (!hasColumn(db, 'nodes', 'qualified_name')) {
      db.exec('ALTER TABLE nodes ADD COLUMN qualified_name TEXT');
    }
    if (!hasColumn(db, 'nodes', 'scope')) {
      db.exec('ALTER TABLE nodes ADD COLUMN scope TEXT');
    }
    if (!hasColumn(db, 'nodes', 'visibility')) {
      db.exec('ALTER TABLE nodes ADD COLUMN visibility TEXT');
    }
    db.exec('UPDATE nodes SET qualified_name = name WHERE qualified_name IS NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_scope ON nodes(scope)');
  }
  if (hasTable(db, 'edges')) {
    if (!hasColumn(db, 'edges', 'confidence')) {
      db.exec('ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0');
    }
    if (!hasColumn(db, 'edges', 'dynamic')) {
      db.exec('ALTER TABLE edges ADD COLUMN dynamic INTEGER DEFAULT 0');
    }
  }
}
