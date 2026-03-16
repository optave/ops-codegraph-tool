import fs from 'node:fs';
import path from 'node:path';
import { loadNative } from '../../infrastructure/native.js';
import { normalizePath } from '../../shared/constants.js';

// ── Alias format conversion ─────────────────────────────────────────

/**
 * Convert JS alias format { baseUrl, paths: { pattern: [targets] } }
 * to native format { baseUrl, paths: [{ pattern, targets }] }.
 */
export function convertAliasesForNative(aliases) {
  if (!aliases) return null;
  return {
    baseUrl: aliases.baseUrl || '',
    paths: Object.entries(aliases.paths || {}).map(([pattern, targets]) => ({
      pattern,
      targets,
    })),
  };
}

// ── JS fallback implementations ─────────────────────────────────────

function resolveViaAlias(importSource, aliases, _rootDir) {
  if (aliases.baseUrl && !importSource.startsWith('.') && !importSource.startsWith('/')) {
    const candidate = path.resolve(aliases.baseUrl, importSource);
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const full = candidate + ext;
      if (fs.existsSync(full)) return full;
    }
  }

  for (const [pattern, targets] of Object.entries(aliases.paths || {})) {
    const prefix = pattern.replace(/\*$/, '');
    if (!importSource.startsWith(prefix)) continue;
    const rest = importSource.slice(prefix.length);
    for (const target of targets) {
      const resolved = target.replace(/\*$/, rest);
      for (const ext of [
        '',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '/index.ts',
        '/index.tsx',
        '/index.js',
      ]) {
        const full = resolved + ext;
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

function resolveImportPathJS(fromFile, importSource, rootDir, aliases) {
  if (!importSource.startsWith('.') && aliases) {
    const aliasResolved = resolveViaAlias(importSource, aliases, rootDir);
    if (aliasResolved) return normalizePath(path.relative(rootDir, aliasResolved));
  }
  if (!importSource.startsWith('.')) return importSource;
  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, importSource);

  if (resolved.endsWith('.js')) {
    const tsCandidate = resolved.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsCandidate)) return normalizePath(path.relative(rootDir, tsCandidate));
    const tsxCandidate = resolved.replace(/\.js$/, '.tsx');
    if (fs.existsSync(tsxCandidate)) return normalizePath(path.relative(rootDir, tsxCandidate));
  }

  for (const ext of [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.py',
    '/index.ts',
    '/index.tsx',
    '/index.js',
    '/__init__.py',
  ]) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return normalizePath(path.relative(rootDir, candidate));
    }
  }
  if (fs.existsSync(resolved)) return normalizePath(path.relative(rootDir, resolved));
  return normalizePath(path.relative(rootDir, resolved));
}

function computeConfidenceJS(callerFile, targetFile, importedFrom) {
  if (!targetFile || !callerFile) return 0.3;
  if (callerFile === targetFile) return 1.0;
  if (importedFrom === targetFile) return 1.0;
  if (path.dirname(callerFile) === path.dirname(targetFile)) return 0.7;
  const callerParent = path.dirname(path.dirname(callerFile));
  const targetParent = path.dirname(path.dirname(targetFile));
  if (callerParent === targetParent) return 0.5;
  return 0.3;
}

// ── Public API with native dispatch ─────────────────────────────────

/**
 * Resolve a single import path.
 * Tries native, falls back to JS.
 */
export function resolveImportPath(fromFile, importSource, rootDir, aliases) {
  const native = loadNative();
  if (native) {
    try {
      const result = native.resolveImport(
        fromFile,
        importSource,
        rootDir,
        convertAliasesForNative(aliases),
      );
      return normalizePath(path.normalize(result));
    } catch {
      // fall through to JS
    }
  }
  return resolveImportPathJS(fromFile, importSource, rootDir, aliases);
}

/**
 * Compute proximity-based confidence for call resolution.
 * Tries native, falls back to JS.
 */
export function computeConfidence(callerFile, targetFile, importedFrom) {
  const native = loadNative();
  if (native) {
    try {
      return native.computeConfidence(callerFile, targetFile, importedFrom || null);
    } catch {
      // fall through to JS
    }
  }
  return computeConfidenceJS(callerFile, targetFile, importedFrom);
}

/**
 * Batch resolve multiple imports in a single native call.
 * Returns Map<"fromFile|importSource", resolvedPath> or null when native unavailable.
 * @param {Array} inputs - Array of { fromFile, importSource }
 * @param {string} rootDir - Project root
 * @param {object} aliases - Path aliases
 * @param {string[]} [knownFiles] - Optional file paths for FS cache (avoids syscalls)
 */
export function resolveImportsBatch(inputs, rootDir, aliases, knownFiles) {
  const native = loadNative();
  if (!native) return null;

  try {
    const nativeInputs = inputs.map(({ fromFile, importSource }) => ({
      fromFile,
      importSource,
    }));
    const results = native.resolveImports(
      nativeInputs,
      rootDir,
      convertAliasesForNative(aliases),
      knownFiles || null,
    );
    const map = new Map();
    for (const r of results) {
      map.set(`${r.fromFile}|${r.importSource}`, normalizePath(path.normalize(r.resolvedPath)));
    }
    return map;
  } catch {
    return null;
  }
}

// ── Exported for testing ────────────────────────────────────────────

export { computeConfidenceJS, resolveImportPathJS };
