import fs from 'node:fs';
import path from 'node:path';
import { findDbPath, openReadonlyOrFail } from '../db/index.js';
import { normalizeFileFilter } from '../db/query-builder.js';
import { isTestFile } from '../infrastructure/test-filter.js';

// ─── CODEOWNERS Parsing ──────────────────────────────────────────────

const CODEOWNERS_PATHS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

/** @type {Map<string, { rules: Array, path: string, mtime: number }>} */
const codeownersCache = new Map();

/**
 * Find and parse a CODEOWNERS file from the standard locations.
 * Results are cached per rootDir and invalidated when the file's mtime changes.
 * @param {string} rootDir - Repository root directory
 * @returns {{ rules: Array<{pattern: string, owners: string[], regex: RegExp}>, path: string } | null}
 */
export function parseCodeowners(rootDir) {
  const cached = codeownersCache.get(rootDir);

  for (const rel of CODEOWNERS_PATHS) {
    const fullPath = path.join(rootDir, rel);
    if (fs.existsSync(fullPath)) {
      const mtime = fs.statSync(fullPath).mtimeMs;
      if (cached && cached.path === rel && cached.mtime === mtime) {
        return { rules: cached.rules, path: cached.path };
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      const rules = parseCodeownersContent(content);
      codeownersCache.set(rootDir, { rules, path: rel, mtime });
      return { rules, path: rel };
    }
  }
  codeownersCache.delete(rootDir);
  return null;
}

/** Clear the parseCodeowners cache (for testing). */
export function clearCodeownersCache() {
  codeownersCache.clear();
}

/**
 * Parse CODEOWNERS file content into rules.
 * @param {string} content - Raw CODEOWNERS file content
 * @returns {Array<{pattern: string, owners: string[], regex: RegExp}>}
 */
export function parseCodeownersContent(content) {
  const rules = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const owners = parts.slice(1).filter((p) => p.startsWith('@') || /^[^@\s]+@[^@\s]+$/.test(p));
    if (owners.length === 0) continue;
    rules.push({ pattern, owners, regex: patternToRegex(pattern) });
  }
  return rules;
}

/**
 * Convert a CODEOWNERS glob pattern to a RegExp.
 *
 * CODEOWNERS semantics:
 * - Leading `/` anchors to repo root; without it, matches anywhere
 * - `*` matches anything except `/`
 * - `**` matches everything including `/`
 * - Trailing `/` matches directory contents
 * - A bare filename like `Makefile` matches anywhere
 */
export function patternToRegex(pattern) {
  let p = pattern;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);

  const dirMatch = p.endsWith('/');
  if (dirMatch) p = p.slice(0, -1);

  // Escape regex specials except * and ?
  let regex = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Replace ? first (single non-slash char) before ** handling
  regex = regex.replace(/\?/g, '[^/]');

  // Handle **/ (zero or more directories) and /** (everything below)
  // Use placeholders to prevent single-* replacement from clobbering
  regex = regex.replace(/\*\*\//g, '<DSS>');
  regex = regex.replace(/\/\*\*/g, '<DSE>');
  regex = regex.replace(/\*\*/g, '<DS>');
  regex = regex.replace(/\*/g, '[^/]*');
  regex = regex.replace(/<DSS>/g, '(.*/)?');
  regex = regex.replace(/<DSE>/g, '/.*');
  regex = regex.replace(/<DS>/g, '.*');

  if (dirMatch) {
    // Pattern like `docs/` matches everything under docs/
    regex = anchored ? `^${regex}/` : `(?:^|/)${regex}/`;
  } else if (anchored) {
    regex = `^${regex}$`;
  } else if (!regex.includes('/')) {
    // Bare filename like `Makefile` or `*.js` — match anywhere
    regex = `(?:^|/)${regex}$`;
  } else {
    // Pattern with path separators but not anchored — match at start or after /
    regex = `(?:^|/)${regex}$`;
  }

  return new RegExp(regex);
}

/**
 * Find the owners for a file path. CODEOWNERS uses last-match-wins semantics.
 * @param {string} filePath - Relative file path (forward slashes)
 * @param {Array<{pattern: string, owners: string[], regex: RegExp}>} rules
 * @returns {string[]}
 */
export function matchOwners(filePath, rules) {
  let owners = [];
  for (const rule of rules) {
    if (rule.regex.test(filePath)) {
      owners = rule.owners;
    }
  }
  return owners;
}

// ─── Data Functions ──────────────────────────────────────────────────

/**
 * Lightweight helper for diff-impact integration.
 * Returns owner mapping for a list of file paths.
 * @param {string[]} filePaths - Relative file paths
 * @param {string} repoRoot - Repository root directory
 * @returns {{ owners: Map<string, string[]>, affectedOwners: string[], suggestedReviewers: string[] }}
 */
export function ownersForFiles(filePaths, repoRoot) {
  const parsed = parseCodeowners(repoRoot);
  if (!parsed) return { owners: new Map(), affectedOwners: [], suggestedReviewers: [] };

  const ownersMap = new Map();
  const ownerSet = new Set();
  for (const file of filePaths) {
    const fileOwners = matchOwners(file, parsed.rules);
    ownersMap.set(file, fileOwners);
    for (const o of fileOwners) ownerSet.add(o);
  }
  const affectedOwners = [...ownerSet].sort();
  return { owners: ownersMap, affectedOwners, suggestedReviewers: affectedOwners };
}

/**
 * Full ownership data for the graph.
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {string} [opts.owner] - Filter to a specific owner
 * @param {string} [opts.file] - Filter by partial file path
 * @param {string} [opts.kind] - Filter by symbol kind
 * @param {boolean} [opts.noTests] - Exclude test files
 * @param {boolean} [opts.boundary] - Show cross-owner boundary edges
 */
export function ownersData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');

    const parsed = parseCodeowners(repoRoot);
    if (!parsed) {
      return {
        codeownersFile: null,
        files: [],
        symbols: [],
        boundaries: [],
        summary: {
          totalFiles: 0,
          ownedFiles: 0,
          unownedFiles: 0,
          coveragePercent: 0,
          ownerCount: 0,
          byOwner: [],
        },
      };
    }

    // Get all distinct files from nodes
    let allFiles = db
      .prepare('SELECT DISTINCT file FROM nodes')
      .all()
      .map((r) => r.file);

    if (opts.noTests) allFiles = allFiles.filter((f) => !isTestFile(f));
    const fileFilters = normalizeFileFilter(opts.file);
    if (fileFilters.length > 0) {
      allFiles = allFiles.filter((f) => fileFilters.some((filter) => f.includes(filter)));
    }

    // Map files to owners
    const fileOwners = allFiles.map((file) => ({
      file,
      owners: matchOwners(file, parsed.rules),
    }));

    // Build owner-to-files index
    const ownerIndex = new Map();
    let ownedCount = 0;
    for (const fo of fileOwners) {
      if (fo.owners.length > 0) ownedCount++;
      for (const o of fo.owners) {
        if (!ownerIndex.has(o)) ownerIndex.set(o, []);
        ownerIndex.get(o).push(fo.file);
      }
    }

    // Filter files if --owner specified
    let filteredFiles = fileOwners;
    if (opts.owner) {
      filteredFiles = fileOwners.filter((fo) => fo.owners.includes(opts.owner));
    }

    // Get symbols for filtered files
    const fileSet = new Set(filteredFiles.map((fo) => fo.file));
    let symbols = db
      .prepare('SELECT name, kind, file, line FROM nodes')
      .all()
      .filter((n) => fileSet.has(n.file));

    if (opts.noTests) symbols = symbols.filter((s) => !isTestFile(s.file));
    if (opts.kind) symbols = symbols.filter((s) => s.kind === opts.kind);

    const symbolsWithOwners = symbols.map((s) => ({
      ...s,
      owners: matchOwners(s.file, parsed.rules),
    }));

    // Boundary analysis — cross-owner call edges
    const boundaries = [];
    if (opts.boundary) {
      const edges = db
        .prepare(
          `SELECT e.id, e.kind AS edgeKind,
                  s.name AS srcName, s.kind AS srcKind, s.file AS srcFile, s.line AS srcLine,
                  t.name AS tgtName, t.kind AS tgtKind, t.file AS tgtFile, t.line AS tgtLine
           FROM edges e
           JOIN nodes s ON e.source_id = s.id
           JOIN nodes t ON e.target_id = t.id
           WHERE e.kind = 'calls'`,
        )
        .all();

      for (const e of edges) {
        if (opts.noTests && (isTestFile(e.srcFile) || isTestFile(e.tgtFile))) continue;
        const srcOwners = matchOwners(e.srcFile, parsed.rules);
        const tgtOwners = matchOwners(e.tgtFile, parsed.rules);
        // Cross-boundary: different owner sets
        const srcKey = srcOwners.sort().join(',');
        const tgtKey = tgtOwners.sort().join(',');
        if (srcKey !== tgtKey) {
          boundaries.push({
            from: {
              name: e.srcName,
              kind: e.srcKind,
              file: e.srcFile,
              line: e.srcLine,
              owners: srcOwners,
            },
            to: {
              name: e.tgtName,
              kind: e.tgtKind,
              file: e.tgtFile,
              line: e.tgtLine,
              owners: tgtOwners,
            },
            edgeKind: e.edgeKind,
          });
        }
      }
    }

    // Summary
    const byOwner = [...ownerIndex.entries()]
      .map(([owner, files]) => ({ owner, fileCount: files.length }))
      .sort((a, b) => b.fileCount - a.fileCount);

    return {
      codeownersFile: parsed.path,
      files: filteredFiles,
      symbols: symbolsWithOwners,
      boundaries,
      summary: {
        totalFiles: allFiles.length,
        ownedFiles: ownedCount,
        unownedFiles: allFiles.length - ownedCount,
        coveragePercent: allFiles.length > 0 ? Math.round((ownedCount / allFiles.length) * 100) : 0,
        ownerCount: ownerIndex.size,
        byOwner,
      },
    };
  } finally {
    db.close();
  }
}
