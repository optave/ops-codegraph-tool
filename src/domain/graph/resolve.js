import fs from 'node:fs';
import path from 'node:path';
import { loadNative } from '../../infrastructure/native.js';
import { normalizePath } from '../../shared/constants.js';

// ── package.json exports resolution ─────────────────────────────────

/** Cache: packageDir → parsed exports field (or null) */
const _exportsCache = new Map();

/**
 * Parse a bare specifier into { packageName, subpath }.
 * Scoped: "@scope/pkg/sub" → { packageName: "@scope/pkg", subpath: "./sub" }
 * Plain:  "pkg/sub"        → { packageName: "pkg", subpath: "./sub" }
 * No sub: "pkg"            → { packageName: "pkg", subpath: "." }
 */
export function parseBareSpecifier(specifier) {
  let packageName, rest;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2) return null;
    packageName = parts[0] + '/' + parts[1];
    rest = parts.slice(2).join('/');
  } else {
    const slashIdx = specifier.indexOf('/');
    if (slashIdx === -1) {
      packageName = specifier;
      rest = '';
    } else {
      packageName = specifier.slice(0, slashIdx);
      rest = specifier.slice(slashIdx + 1);
    }
  }
  return { packageName, subpath: rest ? './' + rest : '.' };
}

/**
 * Find the package directory for a given package name, starting from rootDir.
 * Walks up node_modules directories.
 */
function findPackageDir(packageName, rootDir) {
  let dir = rootDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', packageName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read and cache the exports field from a package's package.json.
 * Returns the exports value or null.
 */
function getPackageExports(packageDir) {
  if (_exportsCache.has(packageDir)) return _exportsCache.get(packageDir);
  try {
    const raw = fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const exports = pkg.exports ?? null;
    _exportsCache.set(packageDir, exports);
    return exports;
  } catch {
    _exportsCache.set(packageDir, null);
    return null;
  }
}

/** Condition names to try, in priority order. */
const CONDITION_ORDER = ['import', 'require', 'default'];

/**
 * Resolve a conditional exports value (string, object with conditions, or array).
 * Returns a string target or null.
 */
function resolveCondition(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = resolveCondition(item);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const cond of CONDITION_ORDER) {
      if (cond in value) return resolveCondition(value[cond]);
    }
    return null;
  }
  return null;
}

/**
 * Match a subpath against an exports map key that uses a wildcard pattern.
 * Key: "./lib/*" matches subpath "./lib/foo/bar" → substitution "foo/bar"
 */
function matchSubpathPattern(pattern, subpath) {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return null;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!subpath.startsWith(prefix)) return null;
  if (suffix && !subpath.endsWith(suffix)) return null;
  const matched = subpath.slice(prefix.length, suffix ? -suffix.length || undefined : undefined);
  if (!suffix && subpath.length < prefix.length) return null;
  return matched;
}

/**
 * Resolve a bare specifier through the package.json exports field.
 * Returns an absolute path or null.
 */
export function resolveViaExports(specifier, rootDir) {
  const parsed = parseBareSpecifier(specifier);
  if (!parsed) return null;

  const packageDir = findPackageDir(parsed.packageName, rootDir);
  if (!packageDir) return null;

  const exports = getPackageExports(packageDir);
  if (exports == null) return null;

  const { subpath } = parsed;

  // Simple string exports: "exports": "./index.js"
  if (typeof exports === 'string') {
    if (subpath === '.') {
      const resolved = path.resolve(packageDir, exports);
      return fs.existsSync(resolved) ? resolved : null;
    }
    return null;
  }

  // Array form at top level
  if (Array.isArray(exports)) {
    if (subpath === '.') {
      const target = resolveCondition(exports);
      if (target) {
        const resolved = path.resolve(packageDir, target);
        return fs.existsSync(resolved) ? resolved : null;
      }
    }
    return null;
  }

  if (typeof exports !== 'object') return null;

  // Determine if exports is a conditions object (no keys start with ".")
  // or a subpath map (keys start with ".")
  const keys = Object.keys(exports);
  const isSubpathMap = keys.length > 0 && keys[0].startsWith('.');

  if (!isSubpathMap) {
    // Conditions object at top level → applies to "." subpath only
    if (subpath === '.') {
      const target = resolveCondition(exports);
      if (target) {
        const resolved = path.resolve(packageDir, target);
        return fs.existsSync(resolved) ? resolved : null;
      }
    }
    return null;
  }

  // Subpath map: try exact match first, then pattern match
  if (subpath in exports) {
    const target = resolveCondition(exports[subpath]);
    if (target) {
      const resolved = path.resolve(packageDir, target);
      return fs.existsSync(resolved) ? resolved : null;
    }
  }

  // Pattern matching (keys with *)
  for (const [pattern, value] of Object.entries(exports)) {
    if (!pattern.includes('*')) continue;
    const matched = matchSubpathPattern(pattern, subpath);
    if (matched == null) continue;
    const rawTarget = resolveCondition(value);
    if (!rawTarget) continue;
    const target = rawTarget.replace(/\*/g, matched);
    const resolved = path.resolve(packageDir, target);
    if (fs.existsSync(resolved)) return resolved;
  }

  return null;
}

/** Clear the exports cache (for testing). */
export function clearExportsCache() {
  _exportsCache.clear();
}

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
  if (!importSource.startsWith('.')) {
    const exportsResolved = resolveViaExports(importSource, rootDir);
    if (exportsResolved) return normalizePath(path.relative(rootDir, exportsResolved));
    return importSource;
  }
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
