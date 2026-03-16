/**
 * Builder helper functions — shared utilities used across pipeline stages.
 *
 * Extracted from the monolithic builder.js so stages can import individually.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { purgeFilesData } from '../../../db/index.js';
import { warn } from '../../../infrastructure/logger.js';
import { EXTENSIONS, IGNORE_DIRS } from '../../../shared/constants.js';

export const BUILTIN_RECEIVERS = new Set([
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Symbol',
  'Error',
  'TypeError',
  'RangeError',
  'Proxy',
  'Reflect',
  'Intl',
  'globalThis',
  'window',
  'document',
  'process',
  'Buffer',
  'require',
]);

/**
 * Recursively collect all source files under `dir`.
 * When `directories` is a Set, also tracks which directories contain files.
 */
export function collectFiles(
  dir,
  files = [],
  config = {},
  directories = null,
  _visited = new Set(),
) {
  const trackDirs = directories instanceof Set;
  let hasFiles = false;

  // Merge config ignoreDirs with defaults
  const extraIgnore = config.ignoreDirs ? new Set(config.ignoreDirs) : null;

  // Detect symlink loops (before I/O to avoid wasted readdirSync)
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return trackDirs ? { files, directories } : files;
  }
  if (_visited.has(realDir)) {
    warn(`Symlink loop detected, skipping: ${dir}`);
    return trackDirs ? { files, directories } : files;
  }
  _visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warn(`Cannot read directory ${dir}: ${err.message}`);
    return trackDirs ? { files, directories } : files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) continue;
    }
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (extraIgnore?.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files, config, directories, _visited);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
      hasFiles = true;
    }
  }
  if (trackDirs && hasFiles) {
    directories.add(dir);
  }
  return trackDirs ? { files, directories } : files;
}

/**
 * Load path aliases from tsconfig.json / jsconfig.json.
 */
export function loadPathAliases(rootDir) {
  const aliases = { baseUrl: null, paths: {} };
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(rootDir, configName);
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs
        .readFileSync(configPath, 'utf-8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([\]}])/g, '$1');
      const config = JSON.parse(raw);
      const opts = config.compilerOptions || {};
      if (opts.baseUrl) aliases.baseUrl = path.resolve(rootDir, opts.baseUrl);
      if (opts.paths) {
        for (const [pattern, targets] of Object.entries(opts.paths)) {
          aliases.paths[pattern] = targets.map((t) => path.resolve(aliases.baseUrl || rootDir, t));
        }
      }
      break;
    } catch (err) {
      warn(`Failed to parse ${configName}: ${err.message}`);
    }
  }
  return aliases;
}

/**
 * Compute MD5 hash of file contents for incremental builds.
 */
export function fileHash(content) {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Stat a file, returning { mtimeMs, size } or null on error.
 */
export function fileStat(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Read a file with retry on transient errors (EBUSY/EACCES/EPERM).
 */
const TRANSIENT_CODES = new Set(['EBUSY', 'EACCES', 'EPERM']);
const RETRY_DELAY_MS = 50;

export function readFileSafe(filePath, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if (attempt < retries && TRANSIENT_CODES.has(err.code)) {
        const end = Date.now() + RETRY_DELAY_MS;
        while (Date.now() < end) {}
        continue;
      }
      throw err;
    }
  }
}

/**
 * Purge all graph data for the specified files.
 */
export function purgeFilesFromGraph(db, files, options = {}) {
  purgeFilesData(db, files, options);
}

/** Batch INSERT chunk size for multi-value INSERTs. */
export const BATCH_CHUNK = 200;

/**
 * Batch-insert node rows via multi-value INSERT statements.
 * Each row: [name, kind, file, line, end_line, parent_id, qualified_name, scope, visibility]
 */
export function batchInsertNodes(db, rows) {
  if (!rows.length) return;
  const ph = '(?,?,?,?,?,?,?,?,?)';
  for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
    const chunk = rows.slice(i, i + BATCH_CHUNK);
    const vals = [];
    for (const r of chunk) vals.push(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]);
    db.prepare(
      'INSERT OR IGNORE INTO nodes (name,kind,file,line,end_line,parent_id,qualified_name,scope,visibility) VALUES ' +
        chunk.map(() => ph).join(','),
    ).run(...vals);
  }
}

/**
 * Batch-insert edge rows via multi-value INSERT statements.
 * Each row: [source_id, target_id, kind, confidence, dynamic]
 */
export function batchInsertEdges(db, rows) {
  if (!rows.length) return;
  const ph = '(?,?,?,?,?)';
  for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
    const chunk = rows.slice(i, i + BATCH_CHUNK);
    const vals = [];
    for (const r of chunk) vals.push(r[0], r[1], r[2], r[3], r[4]);
    db.prepare(
      'INSERT INTO edges (source_id,target_id,kind,confidence,dynamic) VALUES ' +
        chunk.map(() => ph).join(','),
    ).run(...vals);
  }
}
