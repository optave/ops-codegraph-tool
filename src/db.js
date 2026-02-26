import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { debug, warn } from './logger.js';

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
];

export function getBuildMeta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM build_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
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

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  acquireAdvisoryLock(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.__lockPath = `${dbPath}.lock`;
  return db;
}

export function closeDb(db) {
  db.close();
  if (db.__lockPath) releaseAdvisoryLock(db.__lockPath);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireAdvisoryLock(dbPath) {
  const lockPath = `${dbPath}.lock`;
  try {
    if (fs.existsSync(lockPath)) {
      const content = fs.readFileSync(lockPath, 'utf-8').trim();
      const pid = Number(content);
      if (pid && pid !== process.pid && isProcessAlive(pid)) {
        warn(`Another process (PID ${pid}) may be using this database. Proceeding with caution.`);
      }
    }
  } catch {
    /* ignore read errors */
  }
  try {
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
  } catch {
    /* best-effort */
  }
}

function releaseAdvisoryLock(lockPath) {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    if (Number(content) === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* ignore */
  }
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

  try {
    db.exec('ALTER TABLE nodes ADD COLUMN end_line INTEGER');
  } catch {
    /* already exists */
  }
  try {
    db.exec('ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0');
  } catch {
    /* already exists */
  }
  try {
    db.exec('ALTER TABLE edges ADD COLUMN dynamic INTEGER DEFAULT 0');
  } catch {
    /* already exists */
  }
  try {
    db.exec('ALTER TABLE nodes ADD COLUMN role TEXT');
  } catch {
    /* already exists */
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role)');
  } catch {
    /* already exists */
  }
}

export function findDbPath(customPath) {
  if (customPath) return path.resolve(customPath);
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.codegraph', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), '.codegraph', 'graph.db');
}

/**
 * Open a database in readonly mode, with a user-friendly error if the DB doesn't exist.
 */
export function openReadonlyOrFail(customPath) {
  const dbPath = findDbPath(customPath);
  if (!fs.existsSync(dbPath)) {
    console.error(
      `No codegraph database found at ${dbPath}.\n` +
        `Run "codegraph build" first to analyze your codebase.`,
    );
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}
