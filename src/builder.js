import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { EXTENSIONS, IGNORE_DIRS, normalizePath } from './constants.js';
import { closeDb, getBuildMeta, initSchema, openDb, setBuildMeta } from './db.js';
import { readJournal, writeJournalHeader } from './journal.js';
import { debug, info, warn } from './logger.js';
import { getActiveEngine, parseFilesAuto } from './parser.js';
import { computeConfidence, resolveImportPath, resolveImportsBatch } from './resolve.js';

export { resolveImportPath } from './resolve.js';

const __builderDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const CODEGRAPH_VERSION = JSON.parse(
  fs.readFileSync(path.join(__builderDir, '..', 'package.json'), 'utf-8'),
).version;

const BUILTIN_RECEIVERS = new Set([
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

export function collectFiles(
  dir,
  files = [],
  config = {},
  directories = null,
  _visited = new Set(),
) {
  const trackDirs = directories !== null;

  // Resolve real path to detect symlink loops
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

  // Merge config ignoreDirs with defaults
  const extraIgnore = config.ignoreDirs ? new Set(config.ignoreDirs) : null;

  let hasFiles = false;
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
function fileHash(content) {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Stat a file, returning { mtimeMs, size } or null on error.
 */
function fileStat(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Read a file with retry on transient errors (EBUSY/EACCES/EPERM).
 * Editors performing non-atomic saves can cause these during mid-write.
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
 * Determine which files have changed since last build.
 * Three-tier cascade:
 *   Tier 0 — Journal: O(changed) when watcher was running
 *   Tier 1 — mtime+size: O(n) stats, O(changed) reads
 *   Tier 2 — Hash comparison: O(changed) reads (fallback from Tier 1)
 */
function getChangedFiles(db, allFiles, rootDir) {
  // Check if file_hashes table exists
  let hasTable = false;
  try {
    db.prepare('SELECT 1 FROM file_hashes LIMIT 1').get();
    hasTable = true;
  } catch {
    /* table doesn't exist */
  }

  if (!hasTable) {
    return {
      changed: allFiles.map((f) => ({ file: f })),
      removed: [],
      isFullBuild: true,
    };
  }

  const existing = new Map(
    db
      .prepare('SELECT file, hash, mtime, size FROM file_hashes')
      .all()
      .map((r) => [r.file, r]),
  );

  // Build set of current files for removal detection
  const currentFiles = new Set();
  for (const file of allFiles) {
    currentFiles.add(normalizePath(path.relative(rootDir, file)));
  }

  const removed = [];
  for (const existingFile of existing.keys()) {
    if (!currentFiles.has(existingFile)) {
      removed.push(existingFile);
    }
  }

  // ── Tier 0: Journal ──────────────────────────────────────────────
  const journal = readJournal(rootDir);
  if (journal.valid) {
    // Validate journal timestamp against DB — journal should be from after the last build
    const dbMtimes = db.prepare('SELECT MAX(mtime) as latest FROM file_hashes').get();
    const latestDbMtime = dbMtimes?.latest || 0;

    // Empty journal = no watcher was running, fall to Tier 1 for safety
    const hasJournalEntries = journal.changed.length > 0 || journal.removed.length > 0;

    if (hasJournalEntries && journal.timestamp >= latestDbMtime) {
      debug(
        `Tier 0: journal valid, ${journal.changed.length} changed, ${journal.removed.length} removed`,
      );
      const changed = [];

      for (const relPath of journal.changed) {
        const absPath = path.join(rootDir, relPath);
        const stat = fileStat(absPath);
        if (!stat) continue;

        let content;
        try {
          content = readFileSafe(absPath);
        } catch {
          continue;
        }
        const hash = fileHash(content);
        const record = existing.get(relPath);
        if (!record || record.hash !== hash) {
          changed.push({ file: absPath, content, hash, relPath, stat });
        }
      }

      // Merge journal removals with filesystem removals (dedup)
      const removedSet = new Set(removed);
      for (const relPath of journal.removed) {
        if (existing.has(relPath)) removedSet.add(relPath);
      }

      return { changed, removed: [...removedSet], isFullBuild: false };
    }
    debug(
      `Tier 0: skipped (${hasJournalEntries ? 'timestamp stale' : 'no entries'}), falling to Tier 1`,
    );
  }

  // ── Tier 1: mtime+size fast-path ─────────────────────────────────
  const needsHash = []; // Files that failed mtime+size check
  const skipped = []; // Files that passed mtime+size check

  for (const file of allFiles) {
    const relPath = normalizePath(path.relative(rootDir, file));
    const record = existing.get(relPath);

    if (!record) {
      // New file — needs full read+hash
      needsHash.push({ file, relPath });
      continue;
    }

    const stat = fileStat(file);
    if (!stat) continue;

    const storedMtime = record.mtime || 0;
    const storedSize = record.size || 0;

    // size > 0 guard: pre-v4 rows have size=0, always fall through to hash
    if (storedSize > 0 && Math.floor(stat.mtimeMs) === storedMtime && stat.size === storedSize) {
      skipped.push(relPath);
      continue;
    }

    needsHash.push({ file, relPath, stat });
  }

  if (needsHash.length > 0) {
    debug(`Tier 1: ${skipped.length} skipped by mtime+size, ${needsHash.length} need hash check`);
  }

  // ── Tier 2: Hash comparison ──────────────────────────────────────
  const changed = [];

  for (const item of needsHash) {
    let content;
    try {
      content = readFileSafe(item.file);
    } catch {
      continue;
    }
    const hash = fileHash(content);
    const stat = item.stat || fileStat(item.file);
    const record = existing.get(item.relPath);

    if (!record || record.hash !== hash) {
      changed.push({ file: item.file, content, hash, relPath: item.relPath, stat });
    } else if (stat) {
      // Hash matches but mtime/size was stale — self-heal by updating stored metadata
      changed.push({
        file: item.file,
        content,
        hash,
        relPath: item.relPath,
        stat,
        metadataOnly: true,
      });
    }
  }

  // Filter out metadata-only updates from the "changed" list for parsing,
  // but keep them so the caller can update file_hashes
  const parseChanged = changed.filter((c) => !c.metadataOnly);
  if (needsHash.length > 0) {
    debug(
      `Tier 2: ${parseChanged.length} actually changed, ${changed.length - parseChanged.length} metadata-only`,
    );
  }

  return { changed, removed, isFullBuild: false };
}

export async function buildGraph(rootDir, opts = {}) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);

  const config = loadConfig(rootDir);
  const incremental =
    opts.incremental !== false && config.build && config.build.incremental !== false;

  // Engine selection: 'native', 'wasm', or 'auto' (default)
  const engineOpts = { engine: opts.engine || 'auto' };
  const { name: engineName, version: engineVersion } = getActiveEngine(engineOpts);
  info(`Using ${engineName} engine${engineVersion ? ` (v${engineVersion})` : ''}`);

  // Check for engine/version mismatch on incremental builds
  if (incremental) {
    const prevEngine = getBuildMeta(db, 'engine');
    const prevVersion = getBuildMeta(db, 'codegraph_version');
    if (prevEngine && prevEngine !== engineName) {
      warn(
        `Engine changed (${prevEngine} → ${engineName}). Consider rebuilding with --no-incremental for consistency.`,
      );
    }
    if (prevVersion && prevVersion !== CODEGRAPH_VERSION) {
      warn(
        `Codegraph version changed (${prevVersion} → ${CODEGRAPH_VERSION}). Consider rebuilding with --no-incremental for consistency.`,
      );
    }
  }

  const aliases = loadPathAliases(rootDir);
  // Merge config aliases
  if (config.aliases) {
    for (const [key, value] of Object.entries(config.aliases)) {
      const pattern = key.endsWith('/') ? `${key}*` : key;
      const target = path.resolve(rootDir, value);
      aliases.paths[pattern] = [target.endsWith('/') ? `${target}*` : `${target}/*`];
    }
  }

  if (aliases.baseUrl || Object.keys(aliases.paths).length > 0) {
    info(
      `Loaded path aliases: baseUrl=${aliases.baseUrl || 'none'}, ${Object.keys(aliases.paths).length} path mappings`,
    );
  }

  const collected = collectFiles(rootDir, [], config, new Set());
  const files = collected.files;
  const discoveredDirs = collected.directories;
  info(`Found ${files.length} files to parse`);

  // Check for incremental build
  const { changed, removed, isFullBuild } = incremental
    ? getChangedFiles(db, files, rootDir)
    : { changed: files.map((f) => ({ file: f })), removed: [], isFullBuild: true };

  // Separate metadata-only updates (mtime/size self-heal) from real changes
  const parseChanges = changed.filter((c) => !c.metadataOnly);
  const metadataUpdates = changed.filter((c) => c.metadataOnly);

  if (!isFullBuild && parseChanges.length === 0 && removed.length === 0) {
    // Still update metadata for self-healing even when no real changes
    if (metadataUpdates.length > 0) {
      try {
        const healHash = db.prepare(
          'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
        );
        const healTx = db.transaction(() => {
          for (const item of metadataUpdates) {
            const mtime = item.stat ? Math.floor(item.stat.mtimeMs) : 0;
            const size = item.stat ? item.stat.size : 0;
            healHash.run(item.relPath, item.hash, mtime, size);
          }
        });
        healTx();
        debug(`Self-healed mtime/size for ${metadataUpdates.length} files`);
      } catch {
        /* ignore heal errors */
      }
    }
    info('No changes detected. Graph is up to date.');
    closeDb(db);
    writeJournalHeader(rootDir, Date.now());
    return;
  }

  // Check if embeddings table exists (created by `embed`, not by initSchema)
  let hasEmbeddings = false;
  try {
    db.prepare('SELECT 1 FROM embeddings LIMIT 1').get();
    hasEmbeddings = true;
  } catch {
    /* table doesn't exist */
  }

  if (isFullBuild) {
    const deletions =
      'PRAGMA foreign_keys = OFF; DELETE FROM node_metrics; DELETE FROM edges; DELETE FROM nodes; PRAGMA foreign_keys = ON;';
    db.exec(
      hasEmbeddings
        ? `${deletions.replace('PRAGMA foreign_keys = ON;', '')} DELETE FROM embeddings; PRAGMA foreign_keys = ON;`
        : deletions,
    );
  } else {
    // ── Reverse-dependency cascade (issue #116) ─────────────────────
    // Find files with edges pointing TO changed/removed files.
    // Their nodes stay intact (preserving IDs), but outgoing edges are
    // deleted so they can be rebuilt during the edge-building pass.
    const changedRelPaths = new Set();
    for (const item of parseChanges) {
      changedRelPaths.add(item.relPath || normalizePath(path.relative(rootDir, item.file)));
    }
    for (const relPath of removed) {
      changedRelPaths.add(relPath);
    }

    const reverseDeps = new Set();
    if (changedRelPaths.size > 0) {
      const findReverseDeps = db.prepare(`
        SELECT DISTINCT n_src.file FROM edges e
        JOIN nodes n_src ON e.source_id = n_src.id
        JOIN nodes n_tgt ON e.target_id = n_tgt.id
        WHERE n_tgt.file = ? AND n_src.file != n_tgt.file
      `);
      for (const relPath of changedRelPaths) {
        for (const row of findReverseDeps.all(relPath)) {
          if (!changedRelPaths.has(row.file) && !reverseDeps.has(row.file)) {
            // Verify the file still exists on disk
            const absPath = path.join(rootDir, row.file);
            if (fs.existsSync(absPath)) {
              reverseDeps.add(row.file);
            }
          }
        }
      }
    }

    info(
      `Incremental: ${parseChanges.length} changed, ${removed.length} removed${reverseDeps.size > 0 ? `, ${reverseDeps.size} reverse-deps` : ''}`,
    );
    if (parseChanges.length > 0)
      debug(`Changed files: ${parseChanges.map((c) => c.relPath).join(', ')}`);
    if (removed.length > 0) debug(`Removed files: ${removed.join(', ')}`);
    // Remove embeddings/metrics/edges/nodes for changed and removed files
    // Embeddings must be deleted BEFORE nodes (we need node IDs to find them)
    const deleteEmbeddingsForFile = hasEmbeddings
      ? db.prepare('DELETE FROM embeddings WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)')
      : null;
    const deleteNodesForFile = db.prepare('DELETE FROM nodes WHERE file = ?');
    const deleteEdgesForFile = db.prepare(`
      DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f)
      OR target_id IN (SELECT id FROM nodes WHERE file = @f)
    `);
    const deleteOutgoingEdgesForFile = db.prepare(
      'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    );
    const deleteMetricsForFile = db.prepare(
      'DELETE FROM node_metrics WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    );
    let deleteComplexityForFile;
    try {
      deleteComplexityForFile = db.prepare(
        'DELETE FROM function_complexity WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
      );
    } catch {
      deleteComplexityForFile = null;
    }
    for (const relPath of removed) {
      deleteEmbeddingsForFile?.run(relPath);
      deleteEdgesForFile.run({ f: relPath });
      deleteMetricsForFile.run(relPath);
      deleteComplexityForFile?.run(relPath);
      deleteNodesForFile.run(relPath);
    }
    for (const item of parseChanges) {
      const relPath = item.relPath || normalizePath(path.relative(rootDir, item.file));
      deleteEmbeddingsForFile?.run(relPath);
      deleteEdgesForFile.run({ f: relPath });
      deleteMetricsForFile.run(relPath);
      deleteComplexityForFile?.run(relPath);
      deleteNodesForFile.run(relPath);
    }

    // Process reverse deps: delete only outgoing edges (nodes/IDs preserved)
    // then add them to the parse list so they participate in edge building
    for (const relPath of reverseDeps) {
      deleteOutgoingEdgesForFile.run(relPath);
    }
    for (const relPath of reverseDeps) {
      const absPath = path.join(rootDir, relPath);
      parseChanges.push({ file: absPath, relPath, _reverseDepOnly: true });
    }
  }

  const insertNode = db.prepare(
    'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
  );
  const getNodeId = db.prepare(
    'SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?',
  );
  const insertEdge = db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
  );

  // Prepare hash upsert (with size column from migration v4)
  let upsertHash;
  try {
    upsertHash = db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
  } catch {
    upsertHash = null;
  }

  // First pass: parse files and insert nodes
  const fileSymbols = new Map();

  // For incremental builds, also load existing symbols that aren't changing
  if (!isFullBuild) {
    // We need to reload ALL file symbols for edge building
    const _allExistingFiles = db
      .prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'")
      .all();
    // We'll fill these in during the parse pass + edge pass
  }

  const filesToParse = isFullBuild ? files.map((f) => ({ file: f })) : parseChanges;

  // ── Unified parse via parseFilesAuto ───────────────────────────────
  const filePaths = filesToParse.map((item) => item.file);
  const allSymbols = await parseFilesAuto(filePaths, rootDir, engineOpts);

  // Build a lookup from incremental data (changed items may carry pre-computed hashes + stats)
  const precomputedData = new Map();
  for (const item of filesToParse) {
    if (item.relPath) {
      precomputedData.set(item.relPath, item);
    }
  }

  const insertAll = db.transaction(() => {
    for (const [relPath, symbols] of allSymbols) {
      fileSymbols.set(relPath, symbols);

      insertNode.run(relPath, 'file', relPath, 0, null);
      for (const def of symbols.definitions) {
        insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
      }
      for (const exp of symbols.exports) {
        insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
      }

      // Update file hash with real mtime+size for incremental builds
      // Skip for reverse-dep files — they didn't actually change
      if (upsertHash) {
        const precomputed = precomputedData.get(relPath);
        if (precomputed?._reverseDepOnly) {
          // no-op: file unchanged, hash already correct
        } else if (precomputed?.hash) {
          const stat = precomputed.stat || fileStat(path.join(rootDir, relPath));
          const mtime = stat ? Math.floor(stat.mtimeMs) : 0;
          const size = stat ? stat.size : 0;
          upsertHash.run(relPath, precomputed.hash, mtime, size);
        } else {
          const absPath = path.join(rootDir, relPath);
          let code;
          try {
            code = readFileSafe(absPath);
          } catch {
            code = null;
          }
          if (code !== null) {
            const stat = fileStat(absPath);
            const mtime = stat ? Math.floor(stat.mtimeMs) : 0;
            const size = stat ? stat.size : 0;
            upsertHash.run(relPath, fileHash(code), mtime, size);
          }
        }
      }
    }

    // Also update metadata-only entries (self-heal mtime/size without re-parse)
    if (upsertHash) {
      for (const item of metadataUpdates) {
        const mtime = item.stat ? Math.floor(item.stat.mtimeMs) : 0;
        const size = item.stat ? item.stat.size : 0;
        upsertHash.run(item.relPath, item.hash, mtime, size);
      }
    }
  });
  insertAll();

  const parsed = allSymbols.size;
  const skipped = filesToParse.length - parsed;
  info(`Parsed ${parsed} files (${skipped} skipped)`);

  // Clean up removed file hashes
  if (upsertHash && removed.length > 0) {
    const deleteHash = db.prepare('DELETE FROM file_hashes WHERE file = ?');
    for (const relPath of removed) {
      deleteHash.run(relPath);
    }
  }

  // ── Batch import resolution ────────────────────────────────────────
  // Collect all (fromFile, importSource) pairs and resolve in one native call
  const batchInputs = [];
  for (const [relPath, symbols] of fileSymbols) {
    const absFile = path.join(rootDir, relPath);
    for (const imp of symbols.imports) {
      batchInputs.push({ fromFile: absFile, importSource: imp.source });
    }
  }
  const batchResolved = resolveImportsBatch(batchInputs, rootDir, aliases);

  function getResolved(absFile, importSource) {
    if (batchResolved) {
      const key = `${absFile}|${importSource}`;
      const hit = batchResolved.get(key);
      if (hit !== undefined) return hit;
    }
    return resolveImportPath(absFile, importSource, rootDir, aliases);
  }

  // Build re-export map for barrel resolution
  const reexportMap = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    const reexports = symbols.imports.filter((imp) => imp.reexport);
    if (reexports.length > 0) {
      reexportMap.set(
        relPath,
        reexports.map((imp) => ({
          source: getResolved(path.join(rootDir, relPath), imp.source),
          names: imp.names,
          wildcardReexport: imp.wildcardReexport || false,
        })),
      );
    }
  }

  function isBarrelFile(relPath) {
    const symbols = fileSymbols.get(relPath);
    if (!symbols) return false;
    const reexports = symbols.imports.filter((imp) => imp.reexport);
    if (reexports.length === 0) return false;
    const ownDefs = symbols.definitions.length;
    return reexports.length >= ownDefs;
  }

  function resolveBarrelExport(barrelPath, symbolName, visited = new Set()) {
    if (visited.has(barrelPath)) return null;
    visited.add(barrelPath);
    const reexports = reexportMap.get(barrelPath);
    if (!reexports) return null;

    for (const re of reexports) {
      if (re.names.length > 0 && !re.wildcardReexport) {
        if (re.names.includes(symbolName)) {
          const targetSymbols = fileSymbols.get(re.source);
          if (targetSymbols) {
            const hasDef = targetSymbols.definitions.some((d) => d.name === symbolName);
            if (hasDef) return re.source;
            const deeper = resolveBarrelExport(re.source, symbolName, visited);
            if (deeper) return deeper;
          }
          return re.source;
        }
        continue;
      }
      if (re.wildcardReexport || re.names.length === 0) {
        const targetSymbols = fileSymbols.get(re.source);
        if (targetSymbols) {
          const hasDef = targetSymbols.definitions.some((d) => d.name === symbolName);
          if (hasDef) return re.source;
          const deeper = resolveBarrelExport(re.source, symbolName, visited);
          if (deeper) return deeper;
        }
      }
    }
    return null;
  }

  // N+1 optimization: pre-load all nodes into a lookup map for edge building
  const allNodes = db
    .prepare(
      `SELECT id, name, kind, file FROM nodes WHERE kind IN ('function','method','class','interface')`,
    )
    .all();
  const nodesByName = new Map();
  for (const node of allNodes) {
    if (!nodesByName.has(node.name)) nodesByName.set(node.name, []);
    nodesByName.get(node.name).push(node);
  }
  const nodesByNameAndFile = new Map();
  for (const node of allNodes) {
    const key = `${node.name}|${node.file}`;
    if (!nodesByNameAndFile.has(key)) nodesByNameAndFile.set(key, []);
    nodesByNameAndFile.get(key).push(node);
  }

  // Second pass: build edges
  let edgeCount = 0;
  const buildEdges = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const fileNodeRow = getNodeId.get(relPath, 'file', relPath, 0);
      if (!fileNodeRow) continue;
      const fileNodeId = fileNodeRow.id;

      // Import edges
      for (const imp of symbols.imports) {
        const resolvedPath = getResolved(path.join(rootDir, relPath), imp.source);
        const targetRow = getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
        if (targetRow) {
          const edgeKind = imp.reexport ? 'reexports' : imp.typeOnly ? 'imports-type' : 'imports';
          insertEdge.run(fileNodeId, targetRow.id, edgeKind, 1.0, 0);
          edgeCount++;

          if (!imp.reexport && isBarrelFile(resolvedPath)) {
            const resolvedSources = new Set();
            for (const name of imp.names) {
              const cleanName = name.replace(/^\*\s+as\s+/, '');
              const actualSource = resolveBarrelExport(resolvedPath, cleanName);
              if (
                actualSource &&
                actualSource !== resolvedPath &&
                !resolvedSources.has(actualSource)
              ) {
                resolvedSources.add(actualSource);
                const actualRow = getNodeId.get(actualSource, 'file', actualSource, 0);
                if (actualRow) {
                  insertEdge.run(
                    fileNodeId,
                    actualRow.id,
                    edgeKind === 'imports-type' ? 'imports-type' : 'imports',
                    0.9,
                    0,
                  );
                  edgeCount++;
                }
              }
            }
          }
        }
      }

      // Build import name -> target file mapping
      const importedNames = new Map();
      for (const imp of symbols.imports) {
        const resolvedPath = getResolved(path.join(rootDir, relPath), imp.source);
        for (const name of imp.names) {
          const cleanName = name.replace(/^\*\s+as\s+/, '');
          importedNames.set(cleanName, resolvedPath);
        }
      }

      // Call edges with confidence scoring — using pre-loaded lookup maps (N+1 fix)
      const seenCallEdges = new Set();
      for (const call of symbols.calls) {
        if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;
        let caller = null;
        let callerSpan = Infinity;
        for (const def of symbols.definitions) {
          if (def.line <= call.line) {
            const end = def.endLine || Infinity;
            if (call.line <= end) {
              // Call is inside this definition's range — pick narrowest
              const span = end - def.line;
              if (span < callerSpan) {
                const row = getNodeId.get(def.name, def.kind, relPath, def.line);
                if (row) {
                  caller = row;
                  callerSpan = span;
                }
              }
            } else if (!caller) {
              // Fallback: def starts before call but call is past end
              // Only use if we haven't found an enclosing scope yet
              const row = getNodeId.get(def.name, def.kind, relPath, def.line);
              if (row) caller = row;
            }
          }
        }
        if (!caller) caller = fileNodeRow;

        const isDynamic = call.dynamic ? 1 : 0;
        let targets;
        const importedFrom = importedNames.get(call.name);

        if (importedFrom) {
          // Use pre-loaded map instead of DB query
          targets = nodesByNameAndFile.get(`${call.name}|${importedFrom}`) || [];

          if (targets.length === 0 && isBarrelFile(importedFrom)) {
            const actualSource = resolveBarrelExport(importedFrom, call.name);
            if (actualSource) {
              targets = nodesByNameAndFile.get(`${call.name}|${actualSource}`) || [];
            }
          }
        }
        if (!targets || targets.length === 0) {
          // Same file
          targets = nodesByNameAndFile.get(`${call.name}|${relPath}`) || [];
          if (targets.length === 0) {
            // Method name match (e.g. ClassName.methodName)
            const methodCandidates = (nodesByName.get(call.name) || []).filter(
              (n) => n.name.endsWith(`.${call.name}`) && n.kind === 'method',
            );
            if (methodCandidates.length > 0) {
              targets = methodCandidates;
            } else if (
              !call.receiver ||
              call.receiver === 'this' ||
              call.receiver === 'self' ||
              call.receiver === 'super'
            ) {
              // Scoped fallback — same-dir or parent-dir only, not global
              targets = (nodesByName.get(call.name) || []).filter(
                (n) => computeConfidence(relPath, n.file, null) >= 0.5,
              );
            }
            // else: method call on a receiver — skip global fallback entirely
          }
        }

        if (targets.length > 1) {
          targets.sort((a, b) => {
            const confA = computeConfidence(relPath, a.file, importedFrom);
            const confB = computeConfidence(relPath, b.file, importedFrom);
            return confB - confA;
          });
        }

        for (const t of targets) {
          const edgeKey = `${caller.id}|${t.id}`;
          if (t.id !== caller.id && !seenCallEdges.has(edgeKey)) {
            seenCallEdges.add(edgeKey);
            const confidence = computeConfidence(relPath, t.file, importedFrom);
            insertEdge.run(caller.id, t.id, 'calls', confidence, isDynamic);
            edgeCount++;
          }
        }
      }

      // Class extends edges
      for (const cls of symbols.classes) {
        if (cls.extends) {
          const sourceRow = db
            .prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ?')
            .get(cls.name, 'class', relPath);
          const targetCandidates = nodesByName.get(cls.extends) || [];
          const targetRows = targetCandidates.filter((n) => n.kind === 'class');
          if (sourceRow) {
            for (const t of targetRows) {
              insertEdge.run(sourceRow.id, t.id, 'extends', 1.0, 0);
              edgeCount++;
            }
          }
        }

        if (cls.implements) {
          const sourceRow = db
            .prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ?')
            .get(cls.name, 'class', relPath);
          const targetCandidates = nodesByName.get(cls.implements) || [];
          const targetRows = targetCandidates.filter(
            (n) => n.kind === 'interface' || n.kind === 'class',
          );
          if (sourceRow) {
            for (const t of targetRows) {
              insertEdge.run(sourceRow.id, t.id, 'implements', 1.0, 0);
              edgeCount++;
            }
          }
        }
      }
    }
  });
  buildEdges();

  // Build line count map for structure metrics
  const lineCountMap = new Map();
  for (const [relPath] of fileSymbols) {
    const absPath = path.join(rootDir, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      lineCountMap.set(relPath, content.split('\n').length);
    } catch {
      lineCountMap.set(relPath, 0);
    }
  }

  // For incremental builds, buildStructure needs ALL files (not just changed ones)
  // because it clears and rebuilds all contains edges and directory metrics.
  // Load unchanged files from the DB so structure data stays complete.
  if (!isFullBuild) {
    const existingFiles = db.prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'").all();
    const defsByFile = db.prepare(
      "SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file' AND kind != 'directory'",
    );
    // Count imports per file — buildStructure only uses imports.length for metrics
    const importCountByFile = db.prepare(
      `SELECT COUNT(DISTINCT n2.file) AS cnt FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       WHERE n1.file = ? AND e.kind = 'imports'`,
    );
    const lineCountByFile = db.prepare(
      `SELECT n.name AS file, m.line_count
       FROM node_metrics m JOIN nodes n ON m.node_id = n.id
       WHERE n.kind = 'file'`,
    );
    const cachedLineCounts = new Map();
    for (const row of lineCountByFile.all()) {
      cachedLineCounts.set(row.file, row.line_count);
    }
    let loadedFromDb = 0;
    for (const { file: relPath } of existingFiles) {
      if (!fileSymbols.has(relPath)) {
        const importCount = importCountByFile.get(relPath)?.cnt || 0;
        fileSymbols.set(relPath, {
          definitions: defsByFile.all(relPath),
          imports: new Array(importCount),
          exports: [],
        });
        loadedFromDb++;
      }
      if (!lineCountMap.has(relPath)) {
        const cached = cachedLineCounts.get(relPath);
        if (cached != null) {
          lineCountMap.set(relPath, cached);
        } else {
          const absPath = path.join(rootDir, relPath);
          try {
            const content = fs.readFileSync(absPath, 'utf-8');
            lineCountMap.set(relPath, content.split('\n').length);
          } catch {
            lineCountMap.set(relPath, 0);
          }
        }
      }
    }
    debug(`Structure: ${fileSymbols.size} files (${loadedFromDb} loaded from DB)`);
  }

  // Build directory structure, containment edges, and metrics
  const relDirs = new Set();
  for (const absDir of discoveredDirs) {
    relDirs.add(normalizePath(path.relative(rootDir, absDir)));
  }
  try {
    const { buildStructure } = await import('./structure.js');
    buildStructure(db, fileSymbols, rootDir, lineCountMap, relDirs);
  } catch (err) {
    debug(`Structure analysis failed: ${err.message}`);
  }

  // Classify node roles (entry, core, utility, adapter, dead, leaf)
  try {
    const { classifyNodeRoles } = await import('./structure.js');
    const roleSummary = classifyNodeRoles(db);
    debug(
      `Roles: ${Object.entries(roleSummary)
        .map(([r, c]) => `${r}=${c}`)
        .join(', ')}`,
    );
  } catch (err) {
    debug(`Role classification failed: ${err.message}`);
  }

  // Compute per-function complexity metrics (cognitive, cyclomatic, nesting)
  try {
    const { buildComplexityMetrics } = await import('./complexity.js');
    await buildComplexityMetrics(db, allSymbols, rootDir, engineOpts);
  } catch (err) {
    debug(`Complexity analysis failed: ${err.message}`);
  }

  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  info(`Graph built: ${nodeCount} nodes, ${edgeCount} edges`);
  info(`Stored in ${dbPath}`);

  // Warn about orphaned embeddings that no longer match any node
  if (hasEmbeddings) {
    try {
      const orphaned = db
        .prepare('SELECT COUNT(*) as c FROM embeddings WHERE node_id NOT IN (SELECT id FROM nodes)')
        .get().c;
      if (orphaned > 0) {
        warn(
          `${orphaned} embeddings are orphaned (nodes changed). Run "codegraph embed" to refresh.`,
        );
      }
    } catch {
      /* ignore — embeddings table may have been dropped */
    }
  }

  // Persist build metadata for mismatch detection
  try {
    setBuildMeta(db, {
      engine: engineName,
      engine_version: engineVersion || '',
      codegraph_version: CODEGRAPH_VERSION,
      built_at: new Date().toISOString(),
    });
  } catch (err) {
    debug(`Failed to write build metadata: ${err.message}`);
  }

  closeDb(db);

  // Write journal header after successful build
  writeJournalHeader(rootDir, Date.now());

  if (!opts.skipRegistry) {
    const { tmpdir } = await import('node:os');
    const tmpDir = path.resolve(tmpdir());
    const resolvedRoot = path.resolve(rootDir);
    if (resolvedRoot.startsWith(tmpDir)) {
      debug(`Skipping auto-registration for temp directory: ${resolvedRoot}`);
    } else {
      try {
        const { registerRepo } = await import('./registry.js');
        registerRepo(rootDir);
      } catch (err) {
        debug(`Auto-registration failed: ${err.message}`);
      }
    }
  }
}
