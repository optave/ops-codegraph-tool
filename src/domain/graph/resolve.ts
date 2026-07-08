import fs from 'node:fs';
import path from 'node:path';
import { debug } from '../../infrastructure/logger.js';
import { loadNative } from '../../infrastructure/native.js';
import { normalizePath } from '../../shared/constants.js';
import { toErrorMessage } from '../../shared/errors.js';
import type { BareSpecifier, BatchResolvedMap, ImportBatchItem, PathAliases } from '../../types.js';

// ── package.json exports resolution ─────────────────────────────────

/** Cache: packageDir → parsed exports field (or null) */
const _exportsCache: Map<string, any> = new Map();

/**
 * Parse a bare specifier into { packageName, subpath }.
 * Scoped: "@scope/pkg/sub" → { packageName: "@scope/pkg", subpath: "./sub" }
 * Plain:  "pkg/sub"        → { packageName: "pkg", subpath: "./sub" }
 * No sub: "pkg"            → { packageName: "pkg", subpath: "." }
 */
export function parseBareSpecifier(specifier: string): BareSpecifier | null {
  let packageName: string, rest: string;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2) return null;
    packageName = `${parts[0]}/${parts[1]}`;
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
  return { packageName, subpath: rest ? `./${rest}` : '.' };
}

/**
 * Find the package directory for a given package name, starting from rootDir.
 * Walks up node_modules directories.
 */
function findPackageDir(packageName: string, rootDir: string): string | null {
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
function getPackageExports(packageDir: string): any {
  if (_exportsCache.has(packageDir)) return _exportsCache.get(packageDir);
  try {
    const raw = fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const exports = pkg.exports ?? null;
    _exportsCache.set(packageDir, exports);
    return exports;
  } catch (e) {
    debug(`readPackageExports: failed to read package.json in ${packageDir}: ${toErrorMessage(e)}`);
    _exportsCache.set(packageDir, null);
    return null;
  }
}

/** Condition names to try, in priority order. */
const CONDITION_ORDER: readonly string[] = ['import', 'require', 'default'];

/**
 * Resolve a conditional exports value (string, object with conditions, or array).
 * Returns a string target or null.
 */
function resolveCondition(value: unknown): string | null {
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
      if (cond in (value as Record<string, unknown>))
        return resolveCondition((value as Record<string, unknown>)[cond]);
    }
    return null;
  }
  return null;
}

/**
 * Match a subpath against an exports map key that uses a wildcard pattern.
 * Key: "./lib/*" matches subpath "./lib/foo/bar" → substitution "foo/bar"
 */
function matchSubpathPattern(pattern: string, subpath: string): string | null {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return null;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!subpath.startsWith(prefix)) return null;
  if (suffix && !subpath.endsWith(suffix)) return null;
  const matched = subpath.slice(prefix.length, suffix ? -suffix.length || undefined : undefined);
  if (!suffix && subpath.length <= prefix.length) return null;
  return matched;
}

/**
 * Resolve a bare specifier through the package.json exports field.
 * Returns an absolute path or null.
 */
/** Try to resolve a condition target to a file path in packageDir. */
function tryResolveTarget(target: string | null, packageDir: string): string | null {
  if (!target) return null;
  const resolved = path.resolve(packageDir, target);
  return fs.existsSync(resolved) ? resolved : null;
}

/** Resolve subpath against a subpath map (object with "." keys). */
function resolveSubpathMap(
  exports: Record<string, unknown>,
  subpath: string,
  packageDir: string,
): string | null {
  // Exact match first
  if (subpath in exports) {
    return tryResolveTarget(resolveCondition(exports[subpath]), packageDir);
  }
  // Pattern matching (keys with *)
  for (const [pattern, value] of Object.entries(exports)) {
    if (!pattern.includes('*')) continue;
    const matched = matchSubpathPattern(pattern, subpath);
    if (matched == null) continue;
    const rawTarget = resolveCondition(value);
    if (!rawTarget) continue;
    return tryResolveTarget(rawTarget.replace(/\*/g, matched), packageDir);
  }
  return null;
}

export function resolveViaExports(specifier: string, rootDir: string): string | null {
  const parsed = parseBareSpecifier(specifier);
  if (!parsed) return null;

  const packageDir = findPackageDir(parsed.packageName, rootDir);
  if (!packageDir) return null;

  const exports = getPackageExports(packageDir);
  if (exports == null) return null;

  const { subpath } = parsed;

  // Simple string exports: "exports": "./index.js"
  if (typeof exports === 'string') {
    return subpath === '.' ? tryResolveTarget(exports, packageDir) : null;
  }

  // Array form at top level
  if (Array.isArray(exports)) {
    return subpath === '.' ? tryResolveTarget(resolveCondition(exports), packageDir) : null;
  }

  if (typeof exports !== 'object') return null;

  // Determine if exports is a conditions object or a subpath map
  const keys = Object.keys(exports);
  const isSubpathMap = keys.length > 0 && keys.some((k) => k.startsWith('.'));

  if (!isSubpathMap) {
    return subpath === '.' ? tryResolveTarget(resolveCondition(exports), packageDir) : null;
  }

  return resolveSubpathMap(exports as Record<string, unknown>, subpath, packageDir);
}

/** Clear the exports cache (for testing). */
export function clearExportsCache(): void {
  _exportsCache.clear();
}

// ── Monorepo workspace resolution ───────────────────────────────────

/** Cache: rootDir → Map<packageName, { dir, entry }> */
const _workspaceCache: Map<string, Map<string, { dir: string; entry: string | null }>> = new Map();

/** Set of resolved relative paths that came from workspace resolution. */
const _workspaceResolvedPaths: Set<string> = new Set();

/**
 * Set the workspace map for a given rootDir.
 * Called by the build pipeline after detecting workspaces.
 */
export function setWorkspaces(
  rootDir: string,
  map: Map<string, { dir: string; entry: string | null }>,
): void {
  _workspaceCache.set(rootDir, map);
  _workspaceResolvedPaths.clear();
  _exportsCache.clear();
}

/**
 * Get workspace packages for a rootDir. Returns empty map if not set.
 */
function getWorkspaces(rootDir: string): Map<string, { dir: string; entry: string | null }> {
  return _workspaceCache.get(rootDir) || new Map();
}

/**
 * Resolve a bare specifier through monorepo workspace packages.
 *
 * For "@myorg/utils" → finds the workspace package dir → resolves entry point.
 * For "@myorg/utils/sub" → finds package dir → tries exports field → filesystem probe.
 *
 * @returns Absolute path to resolved file, or null.
 */
export function resolveViaWorkspace(specifier: string, rootDir: string): string | null {
  const parsed = parseBareSpecifier(specifier);
  if (!parsed) return null;

  const workspaces = getWorkspaces(rootDir);
  if (workspaces.size === 0) return null;

  const info = workspaces.get(parsed.packageName);
  if (!info) return null;

  // Root import ("@myorg/utils") — use the entry point
  if (parsed.subpath === '.') {
    // Try exports field first (reuses existing exports logic)
    const exportsResult = resolveViaExports(specifier, rootDir);
    if (exportsResult) return exportsResult;
    // Fall back to workspace entry
    return info.entry;
  }

  // Subpath import ("@myorg/utils/helpers") — try exports, then filesystem probe
  const exportsResult = resolveViaExports(specifier, rootDir);
  if (exportsResult) return exportsResult;

  // Filesystem probe within the package directory
  const subRel = parsed.subpath.slice(2); // strip "./"
  const base = path.resolve(info.dir, subRel);
  for (const ext of [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '/index.ts',
    '/index.tsx',
    '/index.js',
  ]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }

  // Try src/ subdirectory (common monorepo convention)
  const srcBase = path.resolve(info.dir, 'src', subRel);
  for (const ext of [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '/index.ts',
    '/index.tsx',
    '/index.js',
  ]) {
    const candidate = srcBase + ext;
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Check if a resolved relative path was resolved via workspace detection.
 * Used by computeConfidence to assign high confidence (0.95) to workspace imports.
 */
export function isWorkspaceResolved(resolvedPath: string): boolean {
  return _workspaceResolvedPaths.has(resolvedPath);
}

/** Clear workspace caches (for testing). */
export function clearWorkspaceCache(): void {
  _workspaceCache.clear();
  _workspaceResolvedPaths.clear();
}

// ── JS → TS extension remap cache ───────────────────────────────────

/** Cache: absolute .js path → remapped .ts/.tsx relative path (or null if no TS file exists). */
const _jsToTsCache: Map<string, string | null> = new Map();

/**
 * If `resolved` ends with `.js`, check whether a `.ts` or `.tsx` counterpart
 * exists on disk and return its relative path from `rootDir`.  Results are
 * cached for the lifetime of the process to avoid repeated stat calls in the
 * batch hot path.
 *
 * The cache stores **absolute** `.ts`/`.tsx` paths (or `null`) so that the
 * same cached entry is correct regardless of which `rootDir` is passed — the
 * relative path is computed on every cache hit.  This is important for MCP
 * `--multi-repo` mode where the same absolute `.js` file may be resolved with
 * different `rootDir` values.
 *
 * Always returns a normalised relative path from `rootDir` — both the remap
 * branch and the fallback compute `path.relative(rootDir, abs)` to ensure a
 * consistent format regardless of whether the native resolver returned an
 * absolute or relative path.
 */
function remapJsToTs(resolved: string, rootDir: string): string {
  if (!resolved.endsWith('.js')) return resolved;
  const abs = path.resolve(rootDir, resolved);
  if (_jsToTsCache.has(abs)) {
    const cachedAbs = _jsToTsCache.get(abs);
    return cachedAbs
      ? normalizePath(path.relative(rootDir, cachedAbs))
      : normalizePath(path.relative(rootDir, abs));
  }
  const tsAbs = abs.replace(/\.js$/, '.ts');
  if (fs.existsSync(tsAbs)) {
    _jsToTsCache.set(abs, tsAbs);
    return normalizePath(path.relative(rootDir, tsAbs));
  }
  const tsxAbs = abs.replace(/\.js$/, '.tsx');
  if (fs.existsSync(tsxAbs)) {
    _jsToTsCache.set(abs, tsxAbs);
    return normalizePath(path.relative(rootDir, tsxAbs));
  }
  _jsToTsCache.set(abs, null);
  // Normalise fallback to relative to stay consistent with the remap branch —
  // avoids a format mismatch if the native resolver ever returns an absolute path.
  return normalizePath(path.relative(rootDir, abs));
}

/** Clear the .js → .ts remap cache (for testing). */
export function clearJsToTsCache(): void {
  _jsToTsCache.clear();
}

// ── Alias format conversion ─────────────────────────────────────────

/**
 * Convert JS alias format { baseUrl, paths: { pattern: [targets] } }
 * to native format { baseUrl, paths: [{ pattern, targets }] }.
 */
export function convertAliasesForNative(
  aliases: PathAliases | null | undefined,
): { baseUrl: string; paths: { pattern: string; targets: string[] }[] } | null {
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

function resolveViaAlias(
  importSource: string,
  aliases: PathAliases,
  _rootDir: string,
): string | null {
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

function resolveImportPathJS(
  fromFile: string,
  importSource: string,
  rootDir: string,
  aliases: PathAliases | null,
): string {
  if (!importSource.startsWith('.') && aliases) {
    const aliasResolved = resolveViaAlias(importSource, aliases, rootDir);
    if (aliasResolved) return normalizePath(path.relative(rootDir, aliasResolved));
  }
  if (!importSource.startsWith('.')) {
    // Workspace packages take priority over node_modules
    const wsResolved = resolveViaWorkspace(importSource, rootDir);
    if (wsResolved) {
      const rel = normalizePath(path.relative(rootDir, wsResolved));
      _workspaceResolvedPaths.add(rel);
      return rel;
    }
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
    '.pyi',
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

/** All ancestor directories of `dir`, starting with `dir` itself, walking up to the root. */
function ancestorChain(dir: string): string[] {
  const chain = [dir];
  let cur = dir;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return chain; // reached root ('.', '/', or a drive root)
    chain.push(parent);
    cur = parent;
  }
}

/**
 * Directory-tree distance between two directories: hops up from `a` to the
 * nearest ancestor shared with `b`, plus hops down from there to `b`.
 *
 * Symmetric and depth-independent — unlike a fixed-depth equality check
 * (e.g. comparing `dirname(dirname(a))` to `dirname(dirname(b))`, as this
 * function used to), this correctly scores both sibling directories (common
 * parent) and direct ancestor/descendant directories (one nested inside the
 * other) regardless of how deep either path is. The fixed-depth check only
 * matched when both files sat at the *same* depth, so e.g. a file in
 * `graph/algorithms/*.ts` calling a method declared in the shallower
 * `graph/model.ts` was scored as maximally distant (issue #1769).
 */
// directoryDistance is on the hot path for every call-edge confidence score
// (computeConfidence runs per candidate during ranking/filtering, not just
// once per emitted edge — see call-resolver.ts, resolver/strategy.ts,
// stages/build-edges.ts). The same directory pairs recur constantly across a
// build, so memoizing avoids rebuilding both ancestor chains and the lookup
// map on every call. distance(a, b) === distance(b, a) (symmetric tree
// distance), so the key is order-independent to halve the effective cache
// size. Never cleared: purely a function of two path strings, so a stale
// entry can't exist, and even a large repo's directory count keeps this
// bounded (#1769 perf regression — see PR discussion).
const directoryDistanceCache = new Map<string, number>();

function directoryDistance(a: string, b: string): number {
  const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
  const cached = directoryDistanceCache.get(key);
  if (cached !== undefined) return cached;

  const chainA = ancestorChain(a);
  const chainB = ancestorChain(b);
  const indexInB = new Map<string, number>(chainB.map((d, idx) => [d, idx]));
  let dist = Infinity;
  for (let i = 0; i < chainA.length; i++) {
    const j = indexInB.get(chainA[i]!);
    if (j !== undefined) {
      dist = i + j;
      break;
    }
  }
  directoryDistanceCache.set(key, dist);
  return dist;
}

function computeConfidenceJS(
  callerFile: string,
  targetFile: string,
  importedFrom: string | null,
): number {
  if (!targetFile || !callerFile) return 0.3;
  if (callerFile === targetFile) return 1.0;
  if (importedFrom === targetFile) return 1.0;
  // Workspace-resolved imports get high confidence even across package boundaries
  if (importedFrom && _workspaceResolvedPaths.has(importedFrom)) return 0.95;
  const dist = directoryDistance(path.dirname(callerFile), path.dirname(targetFile));
  if (dist === 0) return 0.7; // same directory
  if (dist === 1) return 0.6; // direct parent/child directory
  if (dist === 2) return 0.5; // sibling directories, or a grandparent/grandchild pair
  return 0.3;
}

// ── Public API with native dispatch ─────────────────────────────────

/**
 * Resolve a single import path.
 * Tries native, falls back to JS.
 */
export function resolveImportPath(
  fromFile: string,
  importSource: string,
  rootDir: string,
  aliases: PathAliases | null,
): string {
  const native = loadNative();
  if (native) {
    try {
      const result = native.resolveImport(
        fromFile,
        importSource,
        rootDir,
        convertAliasesForNative(aliases),
      );
      const normalized = normalizePath(path.normalize(result));
      // The native resolver's .js → .ts remap fails when paths contain
      // unresolved ".." components (PathBuf::components().collect() doesn't
      // collapse parent refs). Apply the remap on the JS side as a fallback.
      return remapJsToTs(normalized, rootDir);
    } catch (e) {
      debug(
        `resolveImportPath: native resolution failed, falling back to JS: ${toErrorMessage(e)}`,
      );
    }
  }
  return resolveImportPathJS(fromFile, importSource, rootDir, aliases);
}

/**
 * Compute proximity-based confidence for call resolution.
 * Tries native, falls back to JS.
 */
export function computeConfidence(
  callerFile: string,
  targetFile: string,
  importedFrom: string | null,
): number {
  const native = loadNative();
  if (native) {
    try {
      return native.computeConfidence(callerFile, targetFile, importedFrom || null);
    } catch (e) {
      debug(
        `computeConfidence: native computation failed, falling back to JS: ${toErrorMessage(e)}`,
      );
    }
  }
  return computeConfidenceJS(callerFile, targetFile, importedFrom);
}

/**
 * Batch resolve multiple imports in a single native call.
 * Returns Map<"fromFile|importSource", resolvedPath> or null when native unavailable.
 */
export function resolveImportsBatch(
  inputs: ImportBatchItem[],
  rootDir: string,
  aliases: PathAliases | null,
  knownFiles?: string[] | null,
): BatchResolvedMap | null {
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
    const map: BatchResolvedMap = new Map();
    for (const r of results) {
      const normalized = normalizePath(path.normalize(r.resolvedPath));
      // Native resolver's .js → .ts remap fails on unnormalized paths —
      // apply JS-side fallback (same fix as resolveImportPath).
      const resolved = remapJsToTs(normalized, rootDir);
      map.set(`${normalizePath(r.fromFile)}|${r.importSource}`, resolved);
    }
    return map;
  } catch (e) {
    debug(`batchResolve: native batch resolution failed: ${toErrorMessage(e)}`);
    return null;
  }
}

// ── Exported for testing ────────────────────────────────────────────

export { computeConfidenceJS, resolveImportPathJS };
