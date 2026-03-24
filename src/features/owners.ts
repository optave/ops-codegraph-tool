import fs from 'node:fs';
import path from 'node:path';
import { findDbPath, openReadonlyOrFail } from '../db/index.js';
import { normalizeFileFilter } from '../db/query-builder.js';
import { isTestFile } from '../infrastructure/test-filter.js';

// ─── CODEOWNERS Parsing ──────────────────────────────────────────────

const CODEOWNERS_PATHS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

interface CodeownersRule {
  pattern: string;
  owners: string[];
  regex: RegExp;
}

interface CodeownersCache {
  rules: CodeownersRule[];
  path: string;
  mtime: number;
}

const codeownersCache = new Map<string, CodeownersCache>();

export function parseCodeowners(rootDir: string): { rules: CodeownersRule[]; path: string } | null {
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

export function clearCodeownersCache(): void {
  codeownersCache.clear();
}

export function parseCodeownersContent(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0]!;
    const owners = parts.slice(1).filter((p) => p.startsWith('@') || /^[^@\s]+@[^@\s]+$/.test(p));
    if (owners.length === 0) continue;
    rules.push({ pattern, owners, regex: patternToRegex(pattern) });
  }
  return rules;
}

export function patternToRegex(pattern: string): RegExp {
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

export function matchOwners(filePath: string, rules: CodeownersRule[]): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (rule.regex.test(filePath)) {
      owners = rule.owners;
    }
  }
  return owners;
}

// ─── Data Functions ──────────────────────────────────────────────────

export function ownersForFiles(
  filePaths: string[],
  repoRoot: string,
): { owners: Map<string, string[]>; affectedOwners: string[]; suggestedReviewers: string[] } {
  const parsed = parseCodeowners(repoRoot);
  if (!parsed) return { owners: new Map(), affectedOwners: [], suggestedReviewers: [] };

  const ownersMap = new Map<string, string[]>();
  const ownerSet = new Set<string>();
  for (const file of filePaths) {
    const fileOwners = matchOwners(file, parsed.rules);
    ownersMap.set(file, fileOwners);
    for (const o of fileOwners) ownerSet.add(o);
  }
  const affectedOwners = [...ownerSet].sort();
  return { owners: ownersMap, affectedOwners, suggestedReviewers: affectedOwners };
}

interface OwnersDataOpts {
  owner?: string;
  file?: string;
  kind?: string;
  noTests?: boolean;
  boundary?: boolean;
}

export function ownersData(
  customDbPath?: string,
  opts: OwnersDataOpts = {},
): {
  codeownersFile: string | null;
  files: { file: string; owners: string[] }[];
  symbols: { name: string; kind: string; file: string; line: number; owners: string[] }[];
  boundaries: {
    from: { name: string; kind: string; file: string; line: number; owners: string[] };
    to: { name: string; kind: string; file: string; line: number; owners: string[] };
    edgeKind: string;
  }[];
  summary: {
    totalFiles: number;
    ownedFiles: number;
    unownedFiles: number;
    coveragePercent: number;
    ownerCount: number;
    byOwner: { owner: string; fileCount: number }[];
  };
} {
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
    let allFiles = (db.prepare('SELECT DISTINCT file FROM nodes').all() as { file: string }[]).map(
      (r) => r.file,
    );

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
    const ownerIndex = new Map<string, string[]>();
    let ownedCount = 0;
    for (const fo of fileOwners) {
      if (fo.owners.length > 0) ownedCount++;
      for (const o of fo.owners) {
        if (!ownerIndex.has(o)) ownerIndex.set(o, []);
        ownerIndex.get(o)!.push(fo.file);
      }
    }

    // Filter files if --owner specified
    let filteredFiles = fileOwners;
    if (opts.owner) {
      filteredFiles = fileOwners.filter((fo) => fo.owners.includes(opts.owner!));
    }

    // Get symbols for filtered files
    const fileSet = new Set(filteredFiles.map((fo) => fo.file));
    let symbols = (
      db.prepare('SELECT name, kind, file, line FROM nodes').all() as {
        name: string;
        kind: string;
        file: string;
        line: number;
      }[]
    ).filter((n) => fileSet.has(n.file));

    if (opts.noTests) symbols = symbols.filter((s) => !isTestFile(s.file));
    if (opts.kind) symbols = symbols.filter((s) => s.kind === opts.kind);

    const symbolsWithOwners = symbols.map((s) => ({
      ...s,
      owners: matchOwners(s.file, parsed.rules),
    }));

    // Boundary analysis — cross-owner call edges
    const boundaries: {
      from: { name: string; kind: string; file: string; line: number; owners: string[] };
      to: { name: string; kind: string; file: string; line: number; owners: string[] };
      edgeKind: string;
    }[] = [];
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
        .all() as {
        id: number;
        edgeKind: string;
        srcName: string;
        srcKind: string;
        srcFile: string;
        srcLine: number;
        tgtName: string;
        tgtKind: string;
        tgtFile: string;
        tgtLine: number;
      }[];

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
