
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { openDb, initSchema } from './db.js';
import { createParsers, getParser, extractSymbols, extractHCLSymbols, extractPythonSymbols, extractGoSymbols, extractRustSymbols, extractJavaSymbols, extractCSharpSymbols, extractRubySymbols, extractPHPSymbols } from './parser.js';
import { IGNORE_DIRS, EXTENSIONS, normalizePath } from './constants.js';
import { loadConfig } from './config.js';
import { warn, debug, info } from './logger.js';
import { loadNative, isNativeAvailable } from './native.js';

export function collectFiles(dir, files = [], config = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) {
    warn(`Cannot read directory ${dir}: ${err.message}`);
    return files;
  }

  // Merge config ignoreDirs with defaults
  const extraIgnore = config.ignoreDirs ? new Set(config.ignoreDirs) : null;

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) continue;
    }
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (extraIgnore && extraIgnore.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files, config);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

export function loadPathAliases(rootDir) {
  const aliases = { baseUrl: null, paths: {} };
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(rootDir, configName);
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([\]}])/g, '$1');
      const config = JSON.parse(raw);
      const opts = config.compilerOptions || {};
      if (opts.baseUrl) aliases.baseUrl = path.resolve(rootDir, opts.baseUrl);
      if (opts.paths) {
        for (const [pattern, targets] of Object.entries(opts.paths)) {
          aliases.paths[pattern] = targets.map(t => path.resolve(aliases.baseUrl || rootDir, t));
        }
      }
      break;
    } catch (err) {
      warn(`Failed to parse ${configName}: ${err.message}`);
    }
  }
  return aliases;
}

function resolveViaAlias(importSource, aliases, rootDir) {
  if (aliases.baseUrl && !importSource.startsWith('.') && !importSource.startsWith('/')) {
    const candidate = path.resolve(aliases.baseUrl, importSource);
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const full = candidate + ext;
      if (fs.existsSync(full)) return full;
    }
  }

  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const prefix = pattern.replace(/\*$/, '');
    if (!importSource.startsWith(prefix)) continue;
    const rest = importSource.slice(prefix.length);
    for (const target of targets) {
      const resolved = target.replace(/\*$/, rest);
      for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
        const full = resolved + ext;
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

export function resolveImportPath(fromFile, importSource, rootDir, aliases) {
  if (!importSource.startsWith('.') && aliases) {
    const aliasResolved = resolveViaAlias(importSource, aliases, rootDir);
    if (aliasResolved) return normalizePath(path.relative(rootDir, aliasResolved));
  }
  if (!importSource.startsWith('.')) return importSource;
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importSource);

  if (resolved.endsWith('.js')) {
    const tsCandidate = resolved.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsCandidate)) return normalizePath(path.relative(rootDir, tsCandidate));
    const tsxCandidate = resolved.replace(/\.js$/, '.tsx');
    if (fs.existsSync(tsxCandidate)) return normalizePath(path.relative(rootDir, tsxCandidate));
  }

  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '/index.ts', '/index.tsx', '/index.js', '/__init__.py']) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return normalizePath(path.relative(rootDir, candidate));
    }
  }
  if (fs.existsSync(resolved)) return normalizePath(path.relative(rootDir, resolved));
  return normalizePath(path.relative(rootDir, resolved));
}

/**
 * Compute proximity-based confidence for call resolution.
 */
function computeConfidence(callerFile, targetFile, importedFrom) {
  if (!targetFile || !callerFile) return 0.3;
  if (callerFile === targetFile) return 1.0;
  if (importedFrom === targetFile) return 1.0;
  if (path.dirname(callerFile) === path.dirname(targetFile)) return 0.7;
  const callerParent = path.dirname(path.dirname(callerFile));
  const targetParent = path.dirname(path.dirname(targetFile));
  if (callerParent === targetParent) return 0.5;
  return 0.3;
}

/**
 * Compute MD5 hash of file contents for incremental builds.
 */
function fileHash(content) {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Determine which files have changed since last build.
 */
function getChangedFiles(db, allFiles, rootDir) {
  // Check if file_hashes table exists
  let hasTable = false;
  try {
    db.prepare('SELECT 1 FROM file_hashes LIMIT 1').get();
    hasTable = true;
  } catch { /* table doesn't exist */ }

  if (!hasTable) {
    // No hash table = first build, everything is new
    return {
      changed: allFiles.map(f => ({ file: f })),
      removed: [],
      isFullBuild: true
    };
  }

  const existing = new Map(
    db.prepare('SELECT file, hash FROM file_hashes').all()
      .map(r => [r.file, r.hash])
  );

  const changed = [];
  const currentFiles = new Set();

  for (const file of allFiles) {
    const relPath = normalizePath(path.relative(rootDir, file));
    currentFiles.add(relPath);

    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const hash = fileHash(content);

    if (existing.get(relPath) !== hash) {
      changed.push({ file, content, hash, relPath });
    }
  }

  const removed = [];
  for (const existingFile of existing.keys()) {
    if (!currentFiles.has(existingFile)) {
      removed.push(existingFile);
    }
  }

  return { changed, removed, isFullBuild: false };
}

export async function buildGraph(rootDir, opts = {}) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);

  const config = loadConfig(rootDir);
  const incremental = opts.incremental !== false && config.build && config.build.incremental !== false;

  // Engine selection: 'native', 'wasm', or 'auto' (default)
  const enginePref = opts.engine || 'auto';
  const useNative = enginePref === 'native' || (enginePref === 'auto' && isNativeAvailable());
  const native = useNative ? loadNative() : null;

  if (native) {
    console.log(`Using native engine (v${native.engineVersion()})`);
  } else {
    if (enginePref === 'native') {
      console.warn('Native engine requested but unavailable — falling back to WASM');
    }
    console.log('Using WASM engine');
  }

  const parsers = useNative ? null : await createParsers();
  const aliases = loadPathAliases(rootDir);
  // Merge config aliases
  if (config.aliases) {
    for (const [key, value] of Object.entries(config.aliases)) {
      const pattern = key.endsWith('/') ? key + '*' : key;
      const target = path.resolve(rootDir, value);
      aliases.paths[pattern] = [target.endsWith('/') ? target + '*' : target + '/*'];
    }
  }

  if (aliases.baseUrl || Object.keys(aliases.paths).length > 0) {
    console.log(`Loaded path aliases: baseUrl=${aliases.baseUrl || 'none'}, ${Object.keys(aliases.paths).length} path mappings`);
  }

  const files = collectFiles(rootDir, [], config);
  console.log(`Found ${files.length} files to parse`);

  // Check for incremental build
  const { changed, removed, isFullBuild } = incremental
    ? getChangedFiles(db, files, rootDir)
    : { changed: files.map(f => ({ file: f })), removed: [], isFullBuild: true };

  if (!isFullBuild && changed.length === 0 && removed.length === 0) {
    console.log('No changes detected. Graph is up to date.');
    db.close();
    return;
  }

  if (isFullBuild) {
    db.exec('PRAGMA foreign_keys = OFF; DELETE FROM edges; DELETE FROM nodes; PRAGMA foreign_keys = ON;');
  } else {
    console.log(`Incremental: ${changed.length} changed, ${removed.length} removed`);
    // Remove nodes/edges for changed and removed files
    const deleteNodesForFile = db.prepare('DELETE FROM nodes WHERE file = ?');
    const deleteEdgesForFile = db.prepare(`
      DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f)
      OR target_id IN (SELECT id FROM nodes WHERE file = @f)
    `);
    for (const relPath of removed) {
      deleteEdgesForFile.run({ f: relPath });
      deleteNodesForFile.run(relPath);
    }
    for (const item of changed) {
      const relPath = item.relPath || normalizePath(path.relative(rootDir, item.file));
      deleteEdgesForFile.run({ f: relPath });
      deleteNodesForFile.run(relPath);
    }
  }

  const insertNode = db.prepare('INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)');
  const getNodeId = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?');
  const insertEdge = db.prepare('INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)');

  // Prepare hash upsert
  let upsertHash;
  try {
    upsertHash = db.prepare('INSERT OR REPLACE INTO file_hashes (file, hash, mtime) VALUES (?, ?, ?)');
  } catch { upsertHash = null; }

  // First pass: parse files and insert nodes
  const fileSymbols = new Map();
  let parsed = 0, skipped = 0;

  // For incremental builds, also load existing symbols that aren't changing
  if (!isFullBuild) {
    // We need to reload ALL file symbols for edge building
    const allExistingFiles = db.prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'").all();
    // We'll fill these in during the parse pass + edge pass
  }

  const filesToParse = isFullBuild
    ? files.map(f => ({ file: f }))
    : changed;

  // ── Native engine fast path ──────────────────────────────────────────
  if (native) {
    const filePaths = filesToParse.map(item => item.file);
    const nativeResults = native.parseFiles(filePaths, rootDir);

    const insertNative = db.transaction(() => {
      for (const result of nativeResults) {
        if (!result) continue;
        const relPath = normalizePath(path.relative(rootDir, result.file));

        // Adapt native field names to match JS convention (snake_case → camelCase)
        const symbols = {
          definitions: (result.definitions || []).map(d => ({
            name: d.name, kind: d.kind, line: d.line,
            endLine: d.endLine ?? d.end_line ?? null,
            decorators: d.decorators
          })),
          calls: (result.calls || []).map(c => ({
            name: c.name, line: c.line, dynamic: c.dynamic
          })),
          imports: (result.imports || []).map(i => ({
            source: i.source, names: i.names || [], line: i.line,
            typeOnly: i.typeOnly ?? i.type_only,
            reexport: i.reexport ?? i.reexport,
            wildcardReexport: i.wildcardReexport ?? i.wildcard_reexport,
            pythonImport: i.pythonImport ?? i.python_import,
            goImport: i.goImport ?? i.go_import,
            rustUse: i.rustUse ?? i.rust_use,
            javaImport: i.javaImport ?? i.java_import,
            csharpUsing: i.csharpUsing ?? i.csharp_using,
            rubyRequire: i.rubyRequire ?? i.ruby_require,
            phpUse: i.phpUse ?? i.php_use
          })),
          classes: (result.classes || []).map(c => ({
            name: c.name, extends: c.extends, implements: c.implements, line: c.line
          })),
          exports: (result.exports || []).map(e => ({
            name: e.name, kind: e.kind, line: e.line
          }))
        };
        fileSymbols.set(relPath, symbols);

        insertNode.run(relPath, 'file', relPath, 0, null);
        for (const def of symbols.definitions) {
          insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
        }
        for (const exp of symbols.exports) {
          insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
        }

        // Update file hash for incremental builds
        if (upsertHash) {
          let code;
          try { code = fs.readFileSync(result.file, 'utf-8'); } catch { code = null; }
          if (code !== null) {
            const hash = fileHash(code);
            upsertHash.run(relPath, hash, Date.now());
          }
        }

        parsed++;
        if (parsed % 100 === 0) process.stdout.write(`  Parsed ${parsed}/${filesToParse.length} files\r`);
      }
      skipped = filesToParse.length - parsed;
    });
    insertNative();
  } else {
  // ── WASM engine path (original) ────────────────────────────────────

  const insertMany = db.transaction(() => {
    for (const item of filesToParse) {
      const filePath = item.file;
      const parser = getParser(parsers, filePath);
      if (!parser) { skipped++; continue; }

      let code;
      if (item.content) {
        code = item.content;
      } else {
        try { code = fs.readFileSync(filePath, 'utf-8'); }
        catch (err) {
          warn(`Skipping ${path.relative(rootDir, filePath)}: ${err.message}`);
          skipped++;
          continue;
        }
      }

      let tree;
      try { tree = parser.parse(code); }
      catch (e) {
        warn(`Parse error in ${path.relative(rootDir, filePath)}: ${e.message}`);
        skipped++;
        continue;
      }

      const relPath = normalizePath(path.relative(rootDir, filePath));
      const isHCL = filePath.endsWith('.tf') || filePath.endsWith('.hcl');
      const isPython = filePath.endsWith('.py');
      const isGo = filePath.endsWith('.go');
      const isRust = filePath.endsWith('.rs');
      const isJava = filePath.endsWith('.java');
      const isCSharp = filePath.endsWith('.cs');
      const isRuby = filePath.endsWith('.rb');
      const isPHP = filePath.endsWith('.php');
      const symbols = isHCL ? extractHCLSymbols(tree, filePath)
        : isPython ? extractPythonSymbols(tree, filePath)
        : isGo ? extractGoSymbols(tree, filePath)
        : isRust ? extractRustSymbols(tree, filePath)
        : isJava ? extractJavaSymbols(tree, filePath)
        : isCSharp ? extractCSharpSymbols(tree, filePath)
        : isRuby ? extractRubySymbols(tree, filePath)
        : isPHP ? extractPHPSymbols(tree, filePath)
        : extractSymbols(tree, filePath);
      fileSymbols.set(relPath, symbols);

      insertNode.run(relPath, 'file', relPath, 0, null);

      for (const def of symbols.definitions) {
        insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
      }

      for (const exp of symbols.exports) {
        insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
      }

      // Update file hash for incremental builds
      if (upsertHash) {
        const hash = item.hash || fileHash(code);
        upsertHash.run(relPath, hash, Date.now());
      }

      parsed++;
      if (parsed % 100 === 0) process.stdout.write(`  Parsed ${parsed}/${filesToParse.length} files\r`);
    }
  });
  insertMany();
  } // end else (WASM path)
  console.log(`Parsed ${parsed} files (${skipped} skipped)`);

  // Clean up removed file hashes
  if (upsertHash && removed.length > 0) {
    const deleteHash = db.prepare('DELETE FROM file_hashes WHERE file = ?');
    for (const relPath of removed) {
      deleteHash.run(relPath);
    }
  }

  // Build re-export map for barrel resolution
  const reexportMap = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    const reexports = symbols.imports.filter(imp => imp.reexport);
    if (reexports.length > 0) {
      reexportMap.set(relPath, reexports.map(imp => ({
        source: resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases),
        names: imp.names,
        wildcardReexport: imp.wildcardReexport || false
      })));
    }
  }

  function isBarrelFile(relPath) {
    const symbols = fileSymbols.get(relPath);
    if (!symbols) return false;
    const reexports = symbols.imports.filter(imp => imp.reexport);
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
            const hasDef = targetSymbols.definitions.some(d => d.name === symbolName);
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
          const hasDef = targetSymbols.definitions.some(d => d.name === symbolName);
          if (hasDef) return re.source;
          const deeper = resolveBarrelExport(re.source, symbolName, visited);
          if (deeper) return deeper;
        }
      }
    }
    return null;
  }

  // N+1 optimization: pre-load all nodes into a lookup map for edge building
  const allNodes = db.prepare(
    `SELECT id, name, kind, file FROM nodes WHERE kind IN ('function','method','class','interface')`
  ).all();
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
        const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
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
              if (actualSource && actualSource !== resolvedPath && !resolvedSources.has(actualSource)) {
                resolvedSources.add(actualSource);
                const actualRow = getNodeId.get(actualSource, 'file', actualSource, 0);
                if (actualRow) {
                  insertEdge.run(fileNodeId, actualRow.id, edgeKind === 'imports-type' ? 'imports-type' : 'imports', 0.9, 0);
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
        const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
        for (const name of imp.names) {
          const cleanName = name.replace(/^\*\s+as\s+/, '');
          importedNames.set(cleanName, resolvedPath);
        }
      }

      // Call edges with confidence scoring — using pre-loaded lookup maps (N+1 fix)
      for (const call of symbols.calls) {
        let caller = null;
        for (const def of symbols.definitions) {
          if (def.line <= call.line) {
            const row = getNodeId.get(def.name, def.kind, relPath, def.line);
            if (row) caller = row;
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
            const methodCandidates = (nodesByName.get(call.name) || []).filter(n =>
              n.name.endsWith(`.${call.name}`) && n.kind === 'method'
            );
            if (methodCandidates.length > 0) {
              targets = methodCandidates;
            } else {
              // Global fallback
              targets = nodesByName.get(call.name) || [];
            }
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
          if (t.id !== caller.id) {
            const confidence = computeConfidence(relPath, t.file, importedFrom);
            insertEdge.run(caller.id, t.id, 'calls', confidence, isDynamic);
            edgeCount++;
          }
        }
      }

      // Class extends edges
      for (const cls of symbols.classes) {
        if (cls.extends) {
          const sourceRow = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ?').get(cls.name, 'class', relPath);
          const targetCandidates = nodesByName.get(cls.extends) || [];
          const targetRows = targetCandidates.filter(n => n.kind === 'class');
          if (sourceRow) {
            for (const t of targetRows) {
              insertEdge.run(sourceRow.id, t.id, 'extends', 1.0, 0);
              edgeCount++;
            }
          }
        }

        if (cls.implements) {
          const sourceRow = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ?').get(cls.name, 'class', relPath);
          const targetCandidates = nodesByName.get(cls.implements) || [];
          const targetRows = targetCandidates.filter(n => n.kind === 'interface' || n.kind === 'class');
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

  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  console.log(`Graph built: ${nodeCount} nodes, ${edgeCount} edges`);
  console.log(`Stored in ${dbPath}`);
  db.close();
}

